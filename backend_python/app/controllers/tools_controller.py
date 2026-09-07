"""Port of Controllers/ToolsController.php (20-366).

Tools Controller

Provides API endpoints for listing and managing available tools/functions
that can be passed to LLM providers.

Endpoints:
- GET  /api/v1/tools                  - List all available tools (builtin + MCP)
- POST /api/v1/tools/execute          - Execute a single tool by name
- POST /api/v1/tools/classify-intent  - Ask a cheap LLM whether a given
                                        transcript implied a tool call
                                        (used by the realtime runner as a
                                        language-agnostic safety net when
                                        the speaking LLM forgot to emit
                                        the function call itself).
"""
from __future__ import annotations

import json
import re

from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.llm_provider_resolver import LLMProviderResolver
from app.services.mcp_tools_loader import MCPToolsLoader
from app.services.package_resolver import PackageResolver
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_array, php_empty, php_intval, php_strval, php_trim


def _is_php_array(v) -> bool:
    return isinstance(v, (list, dict))


def _php_values(v) -> list:
    """foreach ($v as $item) over a decoded JSON value that may be a PHP
    list-array or an associative array — both iterate values only."""
    if isinstance(v, dict):
        return list(v.values())
    if isinstance(v, list):
        return v
    return []


class ToolsController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config

    # ─── GET /api/v1/tools ──────────────────────────────────────────────────

    def list(self, request) -> dict:
        """List all available tools that can be used in chat requests.
        Returns both built-in tools and MCP server tools.
        """
        query = request.get('query') if request.get('query') is not None else {}
        typeFilter = query.get('type') if query.get('type') is not None else 'all'
        searchTerm = query.get('search')

        if typeFilter not in ('all', 'builtin', 'mcp'):
            return {
                'success': False,
                'error': 'Invalid type filter. Must be: all, builtin, or mcp',
                'status_code': 400,
            }

        builtinTools: list = []
        mcpTools: list = []

        # Get built-in tools
        if typeFilter in ('all', 'builtin'):
            config = LLMProviderResolver.applyDbSettings(self.db, self.config)
            assistant = AIPortfolioAssistant(config)
            try:
                toolsManager = assistant.getToolsManager()
                builtinDefinitions = toolsManager.getToolDefinitions()

                for tool in builtinDefinitions:
                    builtinTools.append({
                        'name': tool['name'],
                        'description': tool.get('description') if tool.get('description') is not None else '',
                        'type': 'builtin',
                        'input_schema': tool.get('input_schema') if tool.get('input_schema') is not None else {},
                    })
            finally:
                # Python-only: PHP has no equivalent — Guzzle clients die
                # with the request.
                try:
                    assistant.close()
                except Exception as closeErr:  # noqa: BLE001
                    error_log(f"[ToolsController] assistant.close() failed: {closeErr}")

        # Get MCP tools (filtered by the caller's role-based package allowlist
        # so the workflow editor's agent-form tool picker only shows servers
        # the caller is permitted to use).
        if typeFilter in ('all', 'mcp'):
            mcpLoader = None
            try:
                mcpLoader = MCPToolsLoader(self.db)
                allowlist = self._resolvePackageMcpAllowlist(request)
                # Load the CALLER's registry (globals + their own servers). With
                # None only global servers came back, so the agent form's tool
                # checklist could never show/tick a user-registered server's
                # tools (Okta, Workday, GitHub… — seen on playbook agents, 2026-09-03).
                uid = request.get('user_id')
                mcpLoader.loadToolsForUser(None if (uid is None or uid == '') else php_strval(uid), allowlist)

                if mcpLoader.hasTools():
                    mcpDefinitions = mcpLoader.getToolDefinitions()

                    for tool in mcpDefinitions:
                        # Extract server name from description if present
                        description = tool.get('description') if tool.get('description') is not None else ''
                        serverName = None
                        m = re.match(r'^\[MCP:([^\]]+)\]', description)
                        if m:
                            serverName = m.group(1)
                            description = php_trim(re.sub(r'^\[MCP:[^\]]+\]\s*', '', description))

                        mcpTools.append({
                            'name': tool['name'],
                            'description': description,
                            'type': 'mcp',
                            'server': serverName,
                            'input_schema': tool.get('input_schema') if tool.get('input_schema') is not None else {},
                        })
            except Exception as e:  # noqa: BLE001
                error_log("[ToolsController] Failed to load MCP tools: " + str(e))
            finally:
                # Python-only (see above).
                if mcpLoader is not None:
                    try:
                        mcpLoader.close()
                    except Exception as closeErr:  # noqa: BLE001
                        error_log(f"[ToolsController] mcpLoader.close() failed: {closeErr}")

        # Combine tools
        allTools = builtinTools + mcpTools

        # Apply search filter if provided
        if searchTerm is not None and searchTerm != '':
            searchLower = str(searchTerm).lower()

            def _matches(tool) -> bool:
                name = tool['name'] if tool.get('name') is not None else ''
                desc = tool.get('description') if tool.get('description') is not None else ''
                nameMatch = searchLower in str(name).lower()
                descMatch = searchLower in str(desc).lower()
                return nameMatch or descMatch

            allTools = [t for t in allTools if _matches(t)]

        return {
            'success': True,
            'tools': allTools,
            'counts': {
                'builtin': len(builtinTools),
                'mcp': len(mcpTools),
                'total': len(allTools),
            },
            'status_code': 200,
        }

    # ─── POST /api/v1/tools/execute ─────────────────────────────────────────

    def execute(self, request) -> dict:
        """Execute a single tool by name. Used by the realtime audio workflow
        runner on the frontend — when a voice agent calls a user-selected
        function, the runner POSTs here, gets the result, and feeds it back
        to the LLM via the realtime WebSocket.

        Body: { "tool_name": "search_web", "parameters": { ... } }
        Returns: { "success": bool, "result": <json>, "error"?: string }
        """
        body = request.get('body') if request.get('body') is not None else {}
        userId = request.get('user_id') if request.get('user_id') is not None else 'demo-user'

        toolName = body.get('tool_name') if body.get('tool_name') is not None else body.get('name')
        parameters = body.get('parameters') if body.get('parameters') is not None else body.get('args')
        if parameters is None:
            parameters = {}
        if not isinstance(parameters, (dict, list)):
            parameters = {}

        if php_empty(toolName):
            return {
                'success': False,
                'error': 'Missing tool_name',
                'status_code': 400,
            }

        # Try built-in tools first.
        config = LLMProviderResolver.applyDbSettings(self.db, self.config)
        assistant = AIPortfolioAssistant(config)
        try:
            toolsManager = assistant.getToolsManager()
            if toolsManager.hasFunction(toolName):
                try:
                    result = toolsManager.execute(toolName, parameters, userId)
                    return {'success': True, 'result': result, 'status_code': 200}
                except Exception as e:  # noqa: BLE001
                    error_log(f"[ToolsController] Built-in tool {toolName} failed: {e}")
                    return {'success': False, 'error': str(e), 'status_code': 500}
        finally:
            # Python-only (see list()).
            try:
                assistant.close()
            except Exception as closeErr:  # noqa: BLE001
                error_log(f"[ToolsController] assistant.close() failed: {closeErr}")

        # Fall back to MCP tools (restricted by the caller's package allowlist
        # so you can't execute a tool whose server the role isn't permitted to see).
        mcpLoader = None
        try:
            mcpLoader = MCPToolsLoader(self.db)
            mcpLoader.loadToolsForUser(None, self._resolvePackageMcpAllowlist(request))
            if mcpLoader.isMCPTool(toolName):
                result = mcpLoader.executeTool(toolName, parameters)
                return {'success': True, 'result': result, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            error_log(f"[ToolsController] MCP tool {toolName} failed: {e}")
            return {'success': False, 'error': str(e), 'status_code': 500}
        finally:
            if mcpLoader is not None:
                try:
                    mcpLoader.close()
                except Exception as closeErr:  # noqa: BLE001
                    error_log(f"[ToolsController] mcpLoader.close() failed: {closeErr}")

        return {
            'success': False,
            'error': f"Unknown tool: {toolName}",
            'status_code': 404,
        }

    # ─── POST /api/v1/tools/classify-intent ─────────────────────────────────

    def classifyIntent(self, request) -> dict:
        """Given what an audio agent just said and the list of tools it had
        available, ask a cheap LLM whether the agent intended to call one of
        those tools. Used by the Gemini adapter as a multilingual safety net
        when Gemini narrates a transfer but forgets to emit the function call.

        Body:
          { "transcript": "...", "tools": [{"name": ..., "description": ...,
            "parameters": {"properties": {"target": {"enum": [...]}}}}, ...] }
        Returns:
          { "success": true, "tool": "handoff_to", "args": {"target": "billing"} }
        or
          { "success": true, "tool": null }
        """
        body = request.get('body') if request.get('body') is not None else {}
        transcript = php_trim(php_strval(body.get('transcript') if body.get('transcript') is not None else ''))
        tools = body.get('tools') if body.get('tools') is not None else []
        userId = request.get('user_id') if request.get('user_id') is not None else 'demo-user'

        if transcript == '' or not _is_php_array(tools) or len(tools) == 0:
            return {'success': True, 'tool': None, 'status_code': 200}

        # Build a compact description of each tool the agent had available.
        toolLines = []
        for t in _php_values(tools):
            name = t.get('name') if isinstance(t, dict) and t.get('name') is not None else '?'
            desc = t.get('description') if isinstance(t, dict) and t.get('description') is not None else ''
            enum = None
            if isinstance(t, dict):
                parameters = t.get('parameters')
                properties = parameters.get('properties') if isinstance(parameters, dict) else None
                target = properties.get('target') if isinstance(properties, dict) else None
                enum = target.get('enum') if isinstance(target, dict) else None
            line = f"- {name}: {desc}"
            if isinstance(enum, list) and len(enum) > 0:
                line += " (valid target values: " + ', '.join(str(x) for x in enum) + ")"
            toolLines.append(line)

        systemPrompt = (
            "You are a function-call classifier for a voice assistant.\n"
            "An AI agent just said something to a caller but did NOT emit a function call. "
            "Decide whether the agent's utterance implies it intended to call one of the tools below, "
            "and if so, pick exactly one tool and fill in its arguments. "
            "Respond with JSON ONLY, no other text, using this schema:\n"
            "  { \"tool\": \"<tool name or null>\", \"args\": {<arguments>} }\n"
            "Rules:\n"
            "- If the utterance is normal conversation (answering a question, greeting, etc.) "
            "and does NOT imply a tool call, respond with {\"tool\": null, \"args\": {}}.\n"
            "- If the utterance announces a transfer / end-of-call / completion, pick the matching tool.\n"
            "- For handoff_to, pick the target whose description best matches where the agent is sending the caller. "
            "The utterance may be in any language (English, French, Spanish, etc.) — reason about the meaning.\n\n"
            "Tools available to the agent:\n" + "\n".join(toolLines)
        )

        userMessage = (
            "Agent's utterance:\n\"\"\"\n" + transcript + "\n\"\"\"\n\n"
            "Respond with JSON only."
        )

        assistant = None
        try:
            config = LLMProviderResolver.applyDbSettings(self.db, self.config)
            assistant = AIPortfolioAssistant(config)
            # Use a cheap/fast provider when configured; fall back to default.
            # Tools=[] keeps the classifier from calling anything itself.
            response = assistant.getLLMManager().chat(
                userMessage,
                [],
                {
                    'user_id': userId,
                    'system_prompt': systemPrompt,
                    'tools': [],
                    'temperature': 0,
                    'max_tokens': 120,
                },
            )
            text = response.get('text') if response.get('text') is not None else (
                response.get('content') if response.get('content') is not None else '')
            text = php_strval(text)
            # Extract the first {...} block — LLM sometimes wraps in ```json.
            m = re.search(r'\{.*\}', text, re.DOTALL)
            if m:
                try:
                    parsed = json.loads(m.group(0))
                except (ValueError, TypeError):
                    parsed = None
                if _is_php_array(parsed):
                    tool = parsed.get('tool') if isinstance(parsed, dict) else None
                    args = parsed.get('args') if isinstance(parsed, dict) and parsed.get('args') is not None else {}
                    # Validate tool exists in the provided list.
                    valid = False
                    for t in _php_values(tools):
                        tName = t.get('name') if isinstance(t, dict) else None
                        if tName == tool:
                            valid = True
                            break
                    if not php_empty(tool) and valid:
                        return {
                            'success': True,
                            'tool': tool,
                            'args': php_array(args),
                            'status_code': 200,
                        }
                    return {'success': True, 'tool': None, 'status_code': 200}
            return {'success': True, 'tool': None, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            error_log("[ToolsController] classifyIntent failed: " + str(e))
            return {
                'success': False,
                'tool': None,
                'error': str(e),
                'status_code': 500,
            }
        finally:
            # Python-only (see list()).
            if assistant is not None:
                try:
                    assistant.close()
                except Exception as closeErr:  # noqa: BLE001
                    error_log(f"[ToolsController] assistant.close() failed: {closeErr}")

    # ─── internals ───────────────────────────────────────────────────────────

    def _resolvePackageMcpAllowlist(self, request) -> list | None:
        """Resolve the MCP server allowlist for the caller's role-based package.
        Returns None (no restriction), a list of allowed server names, or
        an empty list (allow nothing). Suitable to pass straight to
        MCPToolsLoader.loadToolsForUser().
        """
        userId = request.get('user_id')
        try:
            resolver = PackageResolver(self.db)
            return resolver.allowedMcpServers(php_intval(userId) if is_numeric(userId) else None)
        except Exception as e:  # noqa: BLE001
            error_log("[ToolsController] Package allowlist failed: " + str(e))
            return None
