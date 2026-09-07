"""Port of backend/src/AgentTeam/Services/ParallelAgentExecutor.php (423 lines).

Concurrency engine for running multiple agents' LLM calls in parallel,
round-tripping tool calls, and looping until every agent completes or the
round cap is hit.

PHP `curl_multi` fan-out -> `concurrent.futures.ThreadPoolExecutor`. PHP's
`callLLMs()` splits the round's agent states into `array_chunk(...,
maxConcurrency, true)` chunks (preserve_keys) and dispatches each chunk as
one `curl_multi` batch via `dispatchChunk()`; every request inside a chunk
runs truly concurrently (bounded to at most `maxConcurrency` in flight at
once), and chunks run one after another. This port mirrors that exactly:
`callLLMs` chunks with `_array_chunk_preserve_keys`, and `dispatchChunk`
fans a chunk out across a `ThreadPoolExecutor(max_workers=len(chunk))`.

**Result ordering rule** (ParallelAgentExecutor.php 194-304, `dispatchChunk`):
PHP builds `$curlHandles[$nodeId] = [...]` in the order it iterates the
input `$chunk` (skipping any node whose `buildAgentLLMRequestWithTools`
returned null), fires them all via `curl_multi_exec`/`curl_multi_select`
(genuinely concurrent), and THEN, once the whole batch has finished,
collects responses with `foreach ($curlHandles as $nodeId => $info)` — i.e.
in the ORIGINAL CHUNK ORDER, not completion order. So results are ordered
by agent (submission order), not by which HTTP response lands first. This
port reproduces that: `dispatchChunk` submits every prepared request to the
thread pool up front (so they run concurrently — proven in
tests/unit/test_parallel_agent_executor.py via overlapping timestamps), then
assembles the `responses` dict by iterating the chunk's original key order
and blocking on each future's `.result()` in that order.

`private` PHP methods -> `_name`. `protected` PHP methods (`callLLMs`,
`dispatchChunk`) stay unprefixed so test subclasses can override them
exactly like the PHP oracle tests' `FakeExecutor`/`ChunkSpyExecutor`/
`RoundSpyExecutor` do.

`AgentRunner` does not exist yet in this port (Task 2); it is accepted via
constructor injection typed loosely (`Any`). The methods this module calls
on it: `getToolsManager()` -> an object with `getToolDefinitions() -> list`
and `execute(name: str, args) -> Any`; `recordExecutionStart(agent, user_id,
input) -> int`; `recordExecutionComplete(execution_id, response, response_time_ms)
-> None` (mirrors AgentRunner.php's public wrappers around
createExecution/completeExecution).

Deviation from PHP (ParallelAgentExecutor.php 260-265): PHP additionally
special-cases `$httpCode === 0` ("connection failed") as a curl artifact —
curl_multi can return HTTP 0 with no curl error for a totally failed
connection. httpx has no such state: a failed connection always raises
`httpx.RequestError`, already handled below as the "CURL error" branch, so
the HTTP-0 branch has no Python equivalent.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx

from app.agent_team.services.skill_tool_choice import SkillToolChoice
from app.providers._http import SHARED_SSL_CONTEXT
from app.providers.provider_request_factory import ProviderRequestFactory
from app.support.logger import error_log
from app.support.phpcompat import php_bool, php_empty, php_floatval, php_intval
from app.support.phpjson import dumps, php_json_decode, php_json_encode

_PROVIDER_ALIASES = {'anthropic': 'claude', 'google': 'gemini'}


def _idx(d, key):
    """`$arr['key'] ?? null` for a value that may not be an array at all."""
    return d.get(key) if isinstance(d, dict) else None


def _coalesce(value, default):
    """`$value ?? $default` — isset-based (None only), never a truthiness check."""
    return value if value is not None else default


def _array_chunk_preserve_keys(d: dict, size: int) -> list:
    """`array_chunk($d, $size, true)` — split an (insertion-ordered, str/int
    keyed) dict into chunks of at most `size` entries, preserving keys."""
    items = list(d.items())
    return [dict(items[i:i + size]) for i in range(0, len(items), size)]


def _headers_list_to_dict(headers: list) -> dict:
    """PHP's CURLOPT_HTTPHEADER list (['Name: value', ...], the shape
    ProviderRequestFactory::buildRequest()['headers'] returns) -> a header
    dict for httpx."""
    out = {}
    for h in headers:
        if ':' in h:
            k, v = h.split(':', 1)
            out[k.strip()] = v.strip()
    return out


class ParallelAgentExecutor:
    def __init__(
        self,
        agent_runner: Any,
        db,
        config: dict,
        record_executions: bool = False,
        max_concurrency: int = 6,
        http_client: httpx.Client | None = None,
    ):
        self.agentRunner = agent_runner
        self.db = db
        self.config = config if config is not None else {}
        self.recordExecutions = record_executions
        self.maxConcurrency = max_concurrency

        # Python-only addition (no PHP counterpart — curl_multi needs no
        # persistent client). Defaults to a real client with the shared SSL
        # context (see app.providers._http); tests inject a MockTransport
        # client to intercept dispatchChunk's real HTTP calls without
        # overriding dispatchChunk itself.
        self._httpClient = http_client if http_client is not None else httpx.Client(
            timeout=300, verify=SHARED_SSL_CONTEXT,
        )

    def run(self, states: list, max_rounds: int = 10) -> dict:
        """@param states list of dicts with keys 'key','agent','input',
        'messages','tools','tools_filter' (ParallelAgentExecutor.php 30-112)."""
        agent_states: dict = {}
        for s in states:
            key = s['key']
            agent = s['agent']
            execution_id = None
            if self.recordExecutions and agent.getId() is not None:
                user_id = s.get('user_id')
                execution_id = self.agentRunner.recordExecutionStart(
                    agent, php_intval(user_id if user_id is not None else 0), s.get('input'))
            agent_states[key] = {
                'key': key,
                'agent': agent,
                'input': s.get('input'),
                'messages': s.get('messages'),
                'tools': s.get('tools'),
                'tools_filter': s.get('tools_filter'),
                'execution_id': execution_id,
                'completed': False,
                'output': '',
                'success': False,
                'usage': None,
                'start_time': time.time(),
            }

        results: dict = {}
        for _round in range(max_rounds):
            pending = {k: v for k, v in agent_states.items() if not v['completed']}
            if not pending:
                break

            responses = self.callLLMs(pending)

            for key, response in responses.items():
                state = agent_states[key]
                if not (response.get('success') if response.get('success') is not None else False):
                    state['completed'] = True
                    state['success'] = False
                    error = response.get('error') if response.get('error') is not None else 'Unknown error'
                    state['output'] = 'Error: ' + error
                    self._finalize(key, state, results)
                    continue

                parsed = response['parsed']
                if not php_empty(parsed.get('tool_calls')):
                    state['messages'].append({
                        'role': 'assistant',
                        'content': parsed.get('text'),
                        'tool_calls': parsed['tool_calls'],
                    })
                    for tc in parsed['tool_calls']:
                        function = tc.get('function') if isinstance(tc.get('function'), dict) else None
                        func_name = function.get('name') if isinstance(function, dict) else None
                        if func_name is not None:
                            name = func_name
                        elif tc.get('name') is not None:
                            name = tc['name']
                        else:
                            name = 'function'
                        content = self._executeServerTool(tc, state['tools_filter'])
                        state['messages'].append({
                            'role': 'tool',
                            'tool_call_id': tc.get('id'),
                            'name': name,
                            'content': content if isinstance(content, str) else php_json_encode(content),
                        })
                    # needs another round
                else:
                    state['completed'] = True
                    state['success'] = True
                    state['output'] = parsed.get('text') if parsed.get('text') is not None else ''
                    state['usage'] = parsed.get('usage')
                    self._finalize(key, state, results)

        # Any agent that never finished within the round cap.
        for key, state in agent_states.items():
            if key in results:
                continue
            state['success'] = False
            state['output'] = state['output'] if state['output'] != '' else 'Agent did not finish within the tool-round limit.'
            self._finalize(key, state, results)

        return results

    def _finalize(self, key, state: dict, results: dict) -> None:
        """ParallelAgentExecutor.php 114-134. Mutates `results` in place —
        Python dicts are reference types, so this reproduces PHP's `&$results`."""
        agent = state['agent']
        if self.recordExecutions and not php_empty(state.get('execution_id')):
            rt = (time.time() - state['start_time']) * 1000
            self.agentRunner.recordExecutionComplete(php_intval(state['execution_id']), {
                'text': state.get('output') if state.get('output') is not None else '',
                'usage': state.get('usage') if state.get('usage') is not None else {},
                'tool_calls': [],
            }, rt)
        results[key] = {
            'agent_id': agent.getId(),
            'agent_name': agent.getName(),
            'input': state.get('input') if state.get('input') is not None else '',
            'output': state.get('output'),
            'success': php_bool(state.get('success')),
            'usage': state.get('usage'),
            'execution_id': state.get('execution_id'),
        }

    def buildToolsFor(self, agent, tools_filter: list | None) -> list:
        """ParallelAgentExecutor.php 136-141."""
        all_tools = self.agentRunner.getToolsManager().getToolDefinitions()
        if php_empty(tools_filter):
            return all_tools
        return [t for t in all_tools if t.get('name') in tools_filter]

    def _executeServerTool(self, tool_call: dict, tools_filter: list | None) -> str:
        """ParallelAgentExecutor.php 143-153."""
        function = tool_call.get('function') if isinstance(tool_call.get('function'), dict) else {}
        name = function.get('name') if function.get('name') is not None else ''
        arguments = function.get('arguments') if function.get('arguments') is not None else '{}'
        args = php_json_decode(arguments)
        if args is None:
            args = []
        try:
            result = self.agentRunner.getToolsManager().execute(name, args)
            return result if isinstance(result, str) else php_json_encode(result)
        except Exception as e:
            return php_json_encode({'error': str(e)})

    def runConcurrentRound(self, states: dict) -> dict:
        """ParallelAgentExecutor.php 155-163. Public entry for callers (e.g.
        GraphWorkflowRunner) that keep their own round loop but want the
        shared, concurrency-capped multi-provider LLM round."""
        return self.callLLMs(states)

    def callLLMs(self, agent_states: dict) -> dict:
        """ParallelAgentExecutor.php 173-186. `protected` in PHP (overridden
        by test subclasses) -> left unprefixed here for the same reason."""
        responses: dict = {}
        chunks = _array_chunk_preserve_keys(agent_states, max(1, self.maxConcurrency))

        for chunk in chunks:
            # Union merge (dict.update, not overwrite-then-renumber) to
            # preserve the string/int state keys across chunks.
            responses.update(self.dispatchChunk(chunk))

        return responses

    def dispatchChunk(self, chunk: dict) -> dict:
        """ParallelAgentExecutor.php 194-304. `protected` in PHP -> unprefixed.

        Dispatch a single capped chunk of agent states as one concurrent
        batch (curl_multi in PHP; ThreadPoolExecutor here). Returns
        key => {'success': bool, 'parsed': dict|None, 'error': str|None}
        for the chunk, in the chunk's original key order (see module
        docstring for the ordering rule)."""
        prepared: dict = {}
        for node_id, state in chunk.items():
            request = self._buildAgentLLMRequestWithTools(state['agent'], state['messages'], state['tools'])
            if not request:
                continue

            # Force the skill call until it has run once. The parallel path
            # builds requests via ProviderRequestFactory (no tool_choice
            # param), so inject the provider-shaped value into the payload.
            if not php_empty(state.get('force_skill')) and php_empty(state.get('skill_ran')):
                tool_choice = SkillToolChoice.forProvider(request['provider'])
                if tool_choice is not None:
                    request['payload']['tool_choice'] = tool_choice

            prepared[node_id] = request

        if not prepared:
            return {}

        def _fetch(node_id, request):
            headers = _headers_list_to_dict(request['headers'])
            body = dumps(request['payload'])
            try:
                resp = self._httpClient.post(request['url'], headers=headers, content=body.encode('utf-8'))
            except httpx.RequestError as e:
                error_log(f"[ParallelAgentExecutor] Node {node_id} CURL error: {e}")
                return {'success': False, 'error': f'CURL error: {e}'}

            http_code = resp.status_code
            response_text = resp.text

            error_log(f"[ParallelAgentExecutor] Node {node_id} HTTP {http_code}, response_len=" + str(len(response_text)))

            if http_code >= 400:
                error_log(f"[ParallelAgentExecutor] HTTP error {http_code}: " + response_text[0:500])
                error_message = f"HTTP {http_code}"
                decoded = php_json_decode(response_text)
                if decoded:
                    err = decoded.get('error') if isinstance(decoded, dict) else None
                    if isinstance(err, dict) and err.get('message') is not None:
                        error_message = err['message']
                    elif isinstance(err, dict) and err.get('type') is not None:
                        error_message = err['type'] + ': ' + (err.get('message') if err.get('message') is not None else '')
                    elif isinstance(err, dict) and err.get('status') is not None:
                        error_message = err['status'] + ': ' + (err.get('message') if err.get('message') is not None else '')
                return {'success': False, 'error': error_message}

            parsed = self._parseParallelLLMResponse(response_text, request['provider'])
            tool_call_count = len(_coalesce(parsed.get('tool_calls'), []))
            text_len = len(_coalesce(parsed.get('text'), ''))
            error_log(
                f"[ParallelAgentExecutor] Node {node_id} response: provider={request['provider']}, "
                f"tool_calls={tool_call_count}, text_len={text_len}, has_usage="
                + ('yes' if parsed.get('usage') else 'no')
            )
            if tool_call_count == 0 and text_len == 0:
                error_log(f"[ParallelAgentExecutor] Node {node_id} EMPTY response, raw: " + response_text[0:1000])

            return {'success': True, 'parsed': parsed}

        responses: dict = {}
        with ThreadPoolExecutor(max_workers=max(1, len(prepared))) as pool:
            futures = {node_id: pool.submit(_fetch, node_id, request) for node_id, request in prepared.items()}
            # Assemble in the chunk's original key order (curl_multi_getcontent
            # iteration order), not completion order — see module docstring.
            for node_id in prepared.keys():
                responses[node_id] = futures[node_id].result()

        return responses

    def _buildAgentLLMRequestWithTools(self, agent, messages: list, tools: list) -> dict | None:
        """ParallelAgentExecutor.php 311-343. Supports all providers via
        ProviderRequestFactory (Phase 2b)."""
        provider = agent.getProvider().lower()
        model = agent.getModel()
        settings = agent.getSettings()

        provider_config = self._getProviderConfigForParallel(provider)
        if not provider_config or php_empty(provider_config.get('api_key')):
            error_log(f"[ParallelAgentExecutor] Agent {agent.getName()}: No API key for provider {provider}")
            return None

        max_tokens = _idx(settings, 'max_tokens')
        if max_tokens is None:
            max_tokens = _idx(provider_config, 'max_tokens')
        if max_tokens is None:
            max_tokens = 4096

        # Fall back to the provider's stored temperature (system_llm_settings)
        # like max_tokens above — kimi stores 1.00 because kimi-k3 rejects
        # any other value ("invalid temperature: only 1 is allowed").
        temperature = _idx(settings, 'temperature')
        if temperature is None:
            temperature = _idx(provider_config, 'temperature')
        if temperature is None:
            temperature = 0.7

        model_to_use = model if not php_empty(model) else _coalesce(_idx(provider_config, 'model'), '')

        error_log(f"[ParallelAgentExecutor] Agent {agent.getName()}: provider={provider}, model={model_to_use}")

        return ProviderRequestFactory.buildRequest(
            provider, model_to_use, messages, tools, provider_config, max_tokens, temperature,
        )

    def _parseParallelLLMResponse(self, response: str, provider: str) -> dict:
        """ParallelAgentExecutor.php 349-359."""
        decoded = php_json_decode(response)
        if php_empty(decoded):
            error_log(f"[ParallelAgentExecutor] Failed to decode response for provider {provider}")
            return {'text': '', 'tool_calls': [], 'usage': None}

        return ProviderRequestFactory.parseResponse(provider, decoded)

    def _getProviderConfigForParallel(self, name: str) -> dict | None:
        """ParallelAgentExecutor.php 365-422. Handles provider aliases
        (anthropic/claude, google/gemini): DB `system_llm_settings` row
        first, config-file fallback, DB-missing-column falls back to the
        config value."""
        name = name.lower()
        primary_name = _PROVIDER_ALIASES.get(name, name)
        # array_search($name, $aliases) ?: null — the alias KEY whose value
        # equals $name (only set when $name is itself already a primary name).
        alternate_name = None
        for alias_key, primary_val in _PROVIDER_ALIASES.items():
            if primary_val == name:
                alternate_name = alias_key
                break

        def _resolve_config_settings():
            cs = _idx(self.config, primary_name)
            if cs is None:
                cs = _idx(_idx(self.config, 'providers'), primary_name)
            if cs is None and alternate_name:
                cs = _idx(self.config, alternate_name)
                if cs is None:
                    cs = _idx(_idx(self.config, 'providers'), alternate_name)
            return cs

        try:
            row = self.db.fetch_one(
                "SELECT * FROM system_llm_settings WHERE provider_key IN (:key1, :key2) AND enabled = 1 LIMIT 1",
                {'key1': primary_name, 'key2': alternate_name if alternate_name is not None else primary_name},
            )
            config_settings = _resolve_config_settings()

            if row:
                db_api_key = row.get('api_key')
                db_api_key = db_api_key if db_api_key is not None else ''
                config_api_key = _idx(config_settings, 'api_key')
                config_api_key = config_api_key if config_api_key is not None else ''

                db_model = row.get('model')
                db_base_url = row.get('base_url')
                db_max_tokens = row.get('max_tokens')
                db_chat_endpoint = row.get('chat_endpoint')
                db_temp = row.get('temperature')
                cfg_temp = _idx(config_settings, 'temperature')
                cfg_max_tokens = _idx(config_settings, 'max_tokens')

                return {
                    'api_key': db_api_key if not php_empty(db_api_key) else config_api_key,
                    'model': db_model if not php_empty(db_model) else _coalesce(_idx(config_settings, 'model'), ''),
                    'base_url': db_base_url if not php_empty(db_base_url) else _coalesce(_idx(config_settings, 'base_url'), ''),
                    'max_tokens': php_intval(db_max_tokens) if not php_empty(db_max_tokens)
                        else php_intval(cfg_max_tokens if cfg_max_tokens is not None else 4096),
                    # Temperature was omitted here, so callers' providerConfig
                    # fallback could never see the stored value (kimi needs 1.00).
                    'temperature': (
                        php_floatval(db_temp) if (db_temp is not None and db_temp != '')
                        else (php_floatval(cfg_temp) if cfg_temp is not None else None)
                    ),
                    'chat_endpoint': db_chat_endpoint if not php_empty(db_chat_endpoint)
                        else _coalesce(_idx(config_settings, 'chat_endpoint'), '/v1/chat/completions'),
                }

            # No DB config, try config file
            if config_settings:
                return config_settings
        except Exception as e:
            error_log(f"[ParallelAgentExecutor] Error loading provider config: {e}")

        # Fallback to config array
        return _resolve_config_settings()
