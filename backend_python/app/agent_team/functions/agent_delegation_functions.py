"""Port of AgentTeam/Functions/AgentDelegationFunctions.php (648 lines).

Provides tools for manager agents to delegate tasks to worker agents.
These functions are registered with ToolsManager and can be called by LLMs.

Tools provided:
- delegate_to_agent: Delegate a task to a specific agent
- list_available_agents: List agents that can be delegated to
- run_agents_parallel: Run multiple agents in parallel
- complete_task: Signal that the manager's workflow is complete

Phase 2c ported only the static `getToolNames()`. This (Phase 5, Task 2)
ports the full class: constructor (`AgentRepository`, `AgentRunner`) and all
instance handlers, now that `AgentRunner`/`AgentRepository` exist.

`private` PHP methods -> `_name`. `AgentRunner`/`AgentRepository`/
`StreamContext` are imported only under TYPE_CHECKING to avoid a circular
import (AgentRunner.getDelegationFunctions() constructs an
AgentDelegationFunctions, and AgentRunner is this module's own type hint) —
`from __future__ import annotations` makes the annotations lazy strings, so
no runtime import is needed for typing purposes. StreamContext IS imported
at runtime because `_extractStreamContext` needs a real `isinstance` check.
"""
from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING

import pymysql.err

from app.agent_team.services.stream_context import StreamContext
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval, php_trim
from app.support.phpjson import php_json_encode

if TYPE_CHECKING:
    from app.agent_team.models.agent import Agent
    from app.agent_team.services.agent_repository import AgentRepository
    from app.agent_team.services.agent_runner import AgentRunner


# Local approximation of PHP's str_word_count() default mode (word count
# only) -- used solely for the diagnostic `result_word_count` field
# (AgentDelegationFunctions.php:354), not asserted by any oracle test, so an
# exact locale-dependent reproduction of PHP's C implementation isn't
# required. app.support.phpcompat has no str_word_count helper (checked);
# this is a small local addition, not a re-implementation of an existing one.
_WORD_RE = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*")


def _str_word_count(s: str) -> int:
    return len(_WORD_RE.findall(s))


def _safe_json_log(value) -> str:
    """DEBUG-log-only wrapper around php_json_encode. PHP's json_encode()
    can't serialize a Closure (StreamContext's private onEvent callback) and
    returns `false` instead of throwing; `error_log($msg . json_encode(...))`
    then string-concatenates that `false` as an empty string, so PHP never
    crashes logging `context` once it carries a `stream_context` entry
    (AgentDelegationFunctions.php:174, `json_encode($context)`). php_json_
    encode (json.dumps) raises TypeError instead -- this reproduces PHP's
    graceful "encode failure -> empty string" behavior for these DEBUG
    lines only; their exact text is not part of any contract."""
    try:
        return php_json_encode(value)
    except TypeError:
        return ''


class AgentDelegationFunctions:
    """Agent Delegation Functions."""

    def __init__(self, repository: 'AgentRepository', runner: 'AgentRunner'):
        self.repository = repository
        self.runner = runner

    @staticmethod
    def getToolNames() -> list:
        """Get the names of all delegation tools (static method for use
        without instantiation)."""
        return [
            'delegate_to_agent',
            'list_available_agents',
            'run_agents_parallel',
        ]

    def getAllFunctions(self) -> dict:
        """Get all delegation functions with their handlers and schemas
        (PHP 55-161)."""
        return {
            'delegate_to_agent': {
                'handler': self.delegateToAgent,
                'schema': {
                    'description': 'Delegate a task to a specialized sub-agent. The sub-agent will execute the task and return results. Use this to break down complex tasks and assign them to specialists. You can specify the agent by ID or name.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'agent_id': {
                                'type': 'integer',
                                'description': 'ID of the agent to delegate to (use either agent_id or agent_name)',
                            },
                            'agent_name': {
                                'type': 'string',
                                'description': 'Name of the agent to delegate to (use either agent_id or agent_name)',
                            },
                            'task': {
                                'type': 'string',
                                'description': 'The task description to send to the sub-agent. Be specific and clear about what you need.',
                            },
                            'context': {
                                'type': 'string',
                                'description': 'Optional additional context from previous agent outputs or research to help the sub-agent.',
                            },
                        },
                        'required': ['task'],
                    },
                },
            },

            'list_available_agents': {
                'handler': self.listAvailableAgents,
                'schema': {
                    'description': 'List all agents that this manager can delegate tasks to. Returns agent names, descriptions, and capabilities. Use this to understand your team before delegating.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'agent_type': {
                                'type': 'string',
                                'description': 'Optional filter by agent type: worker, standard, or all',
                                'enum': ['worker', 'standard', 'all'],
                            },
                        },
                        'required': [],
                    },
                },
            },

            'run_agents_parallel': {
                'handler': self.runAgentsParallel,
                'schema': {
                    'description': 'Run multiple agents in parallel and collect their results. Useful for gathering information from multiple specialists simultaneously. Results are returned together once all agents complete.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'delegations': {
                                'type': 'array',
                                'description': 'Array of delegation objects, each with agent_name and task',
                                'items': {
                                    'type': 'object',
                                    'properties': {
                                        'agent_name': {
                                            'type': 'string',
                                            'description': 'Name of the agent to delegate to',
                                        },
                                        'task': {
                                            'type': 'string',
                                            'description': 'The task for this agent',
                                        },
                                        'context': {
                                            'type': 'string',
                                            'description': 'Optional context for this agent',
                                        },
                                    },
                                    'required': ['agent_name', 'task'],
                                },
                            },
                        },
                        'required': ['delegations'],
                    },
                },
            },

            'complete_task': {
                'handler': self.completeTask,
                'schema': {
                    'description': 'Signal that the workflow is complete and you are ready to provide your final response to the user. Call this ONLY when you have gathered all necessary information from your agents and are ready to synthesize the final answer. After calling this, respond directly to the user with your findings.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'reason': {
                                'type': 'string',
                                'description': 'Brief explanation of why the workflow is complete (e.g., "All research gathered and verified", "User question fully answered")',
                            },
                            'summary': {
                                'type': 'string',
                                'description': 'Optional brief summary of what was accomplished during the workflow',
                            },
                        },
                        'required': ['reason'],
                    },
                },
            },
        }

    # ------------------------------------------------------------------
    # delegate_to_agent
    # ------------------------------------------------------------------

    def delegateToAgent(self, params: dict, context=None) -> dict:
        """Delegate a task to another agent (PHP 170-378)."""
        error_log("[DELEGATION] delegateToAgent called with params: " + php_json_encode(params))
        error_log("[DELEGATION] Context received: " + _safe_json_log(context))

        userId = self._extractUserId(context)
        currentAgentId = self._extractCurrentAgentId(context)
        parentExecutionId = self._extractParentExecutionId(context)

        error_log(f"[DELEGATION] Extracted: userId={userId}, currentAgentId={currentAgentId}, parentExecutionId={parentExecutionId}")

        task = php_trim(params.get('task') if params.get('task') is not None else '')
        if php_empty(task):
            error_log("[DELEGATION] EARLY RETURN: empty task")
            return {
                'success': False,
                'error': 'Task description is required',
            }

        agentId = params.get('agent_id')
        agentName = params.get('agent_name')

        if not agentId and not agentName:
            error_log("[DELEGATION] EARLY RETURN: no agent_id or agent_name")
            return {
                'success': False,
                'error': 'Either agent_id or agent_name is required',
            }

        error_log("[DELEGATION] Looking for agent: id=" + (str(agentId) if agentId else 'null')
                  + ", name=" + (str(agentName) if agentName else 'null'))

        try:
            # Get fresh repository with valid DB connection. This handles
            # cases where connection went stale during long-running operations.
            freshRepo = self.runner.getFreshRepository()
            agent = freshRepo.findById(php_intval(agentId)) if agentId else freshRepo.findByName(agentName, userId)
        except pymysql.err.OperationalError as e:
            error_log("[DELEGATION] DATABASE ERROR in findByName: " + str(e))
            return {
                'success': False,
                'error': 'Database connection error while finding agent. Please retry.',
                'retry': True,
            }
        except Exception as e:  # noqa: BLE001
            error_log("[DELEGATION] ERROR in findByName: " + str(e))
            return {
                'success': False,
                'error': f'Error finding agent: {e}',
            }

        error_log("[DELEGATION] Agent found: " + (f"{agent.getName()} (id={agent.getId()})" if agent else "NULL"))

        if not agent:
            # Get list of available agents to help LLM self-correct
            availableAgents = []
            if currentAgentId:
                freshRepo = self.runner.getFreshRepository()
                workers = freshRepo.findWorkerAgents(currentAgentId)
                for worker in workers:
                    availableAgents.append(worker.getName())

            errorMsg = "Agent not found: " + (agentName if agentName else f"ID {agentId}")
            if not php_empty(availableAgents):
                errorMsg += ". Available agents you can delegate to: " + ', '.join(f'"{n}"' for n in availableAgents)

            error_log("[DELEGATION] Agent not found. Available: " + php_json_encode(availableAgents))

            return {
                'success': False,
                'error': errorMsg,
                'available_agents': availableAgents,
            }

        # Check if agent is enabled
        if not agent.isEnabled():
            error_log(f"[DELEGATION] EARLY RETURN: agent '{agent.getName()}' is disabled")
            return {
                'success': False,
                'error': f"Agent '{agent.getName()}' is disabled",
            }

        error_log("[DELEGATION] Agent enabled check passed")

        # Check delegation permission (use fresh repo to avoid stale connection)
        if currentAgentId:
            try:
                manager = freshRepo.findById(currentAgentId)
                if manager and not manager.canDelegateToAgent(agent.getId()):
                    error_log(f"[DELEGATION] EARLY RETURN: Manager cannot delegate to agent '{agent.getName()}'")
                    return {
                        'success': False,
                        'error': f"Manager cannot delegate to agent '{agent.getName()}'",
                    }
            except pymysql.err.OperationalError as e:
                error_log("[DELEGATION] DB ERROR in delegation permission check: " + str(e))
                # Re-fetch fresh repo and retry once
                freshRepo = self.runner.getFreshRepository()
                manager = freshRepo.findById(currentAgentId)
                if manager and not manager.canDelegateToAgent(agent.getId()):
                    return {
                        'success': False,
                        'error': f"Manager cannot delegate to agent '{agent.getName()}'",
                    }

        error_log("[DELEGATION] Delegation permission check passed")

        # Build input with context
        input_ = task
        additionalContext = php_trim(params.get('context') if params.get('context') is not None else '')
        if not php_empty(additionalContext):
            input_ = f"## Context from Previous Analysis\n{additionalContext}\n\n## Your Task\n{task}"

        # Get stream context from execution context for real-time events
        streamContext = self._extractStreamContext(context)
        error_log("[DELEGATION] StreamContext extracted: " + ('YES' if streamContext else 'NO'))

        # Emit agent_delegate event
        if streamContext:
            managerAgent = freshRepo.findById(currentAgentId) if currentAgentId else None
            streamContext.emitAgentDelegate(
                currentAgentId if currentAgentId else 0,
                managerAgent.getName() if managerAgent else 'Unknown',
                agent.getId(),
                agent.getName(),
                task,
            )

        # Pass stream context to runner for nested agent events
        if streamContext:
            self.runner.setStreamContext(streamContext)

        # Execute the agent
        error_log(f"[DELEGATION] About to call runner->run() for '{agent.getName()}'")
        try:
            result = self.runner.run(
                agent,
                input_,
                [],  # Fresh conversation for sub-agent
                userId,
                {
                    'parent_execution_id': parentExecutionId,
                    'parent_agent_id': currentAgentId,
                },
            )

            error_log(f"[DELEGATION] runner->run() returned for '{agent.getName()}', success="
                      + ('YES' if result.get('success') else 'NO'))

            if result.get('success'):
                responseText = result.get('text') if result.get('text') is not None else ''
                responseLength = len(responseText)
                error_log(f"[DELEGATION] SUCCESS from '{agent.getName()}': response length={responseLength} chars, "
                          "tools_used=" + php_json_encode(result.get('tools_used') if result.get('tools_used') is not None else []))
                error_log("[DELEGATION] Response preview: " + responseText[:200] + ('...' if responseLength > 200 else ''))

                # Get available workers for manager's next decision
                availableWorkers = self.runner.getAvailableWorkers(currentAgentId) if currentAgentId else []

                return {
                    'success': True,
                    'delegated_to': agent.getName(),
                    'agent_id': agent.getId(),
                    'agent_type': agent.getAgentType(),
                    'status': 'completed',
                    'result': responseText,
                    'result_word_count': _str_word_count(responseText),
                    'tools_used': result.get('tools_used') if result.get('tools_used') is not None else [],
                    'execution_id': result.get('execution_id'),
                    'available_agents': [w['name'] for w in availableWorkers],
                    'hint': 'Based on this result, decide: delegate to another agent, or call complete_task to finish and respond to user.',
                }
            else:
                error_log(f"[DELEGATION] FAILED from '{agent.getName()}': "
                          + (result.get('error') if result.get('error') is not None else 'Unknown error'))

                return {
                    'success': False,
                    'agent_name': agent.getName(),
                    'error': result.get('error') if result.get('error') is not None else 'Unknown error',
                }
        except Exception as e:  # noqa: BLE001
            error_log(f"[DELEGATION] EXCEPTION in delegation to '{agent.getName()}': {e}")
            return {
                'success': False,
                'agent_name': agent.getName(),
                'error': f"Delegation failed: {e}",
            }

    # ------------------------------------------------------------------
    # list_available_agents
    # ------------------------------------------------------------------

    def listAvailableAgents(self, params: dict, context=None) -> dict:
        """List agents available for delegation (PHP 387-430)."""
        userId = self._extractUserId(context)
        currentAgentId = self._extractCurrentAgentId(context)
        typeFilter = params.get('agent_type') if params.get('agent_type') is not None else 'all'

        agents: list = []

        # Use fresh repository to avoid stale DB connection
        freshRepo = self.runner.getFreshRepository()

        if currentAgentId:
            workers = freshRepo.findWorkerAgents(currentAgentId)
            for agent in workers:
                if typeFilter == 'all' or agent.getAgentType() == typeFilter:
                    agents.append(self._formatAgentInfo(agent))
        else:
            filters: dict = {}
            if typeFilter != 'all':
                filters['agent_type'] = typeFilter

            accessibleAgents = freshRepo.findAccessibleByUser(userId, filters)
            for agent in accessibleAgents:
                if agent.getAgentType() != 'manager':
                    agents.append(self._formatAgentInfo(agent))

        return {
            'success': True,
            'count': len(agents),
            'agents': agents,
            'message': (f"Found {len(agents)} agents available for delegation"
                        if len(agents) > 0 else "No agents available for delegation"),
        }

    # ------------------------------------------------------------------
    # run_agents_parallel
    # ------------------------------------------------------------------

    def runAgentsParallel(self, params: dict, context=None) -> dict:
        """Run multiple agents in parallel (PHP 439-554)."""
        delegations = params.get('delegations') if params.get('delegations') is not None else []
        if php_empty(delegations) or not isinstance(delegations, (list, dict)):
            return {'success': False, 'error': 'No delegations provided'}

        # PHP `foreach ($delegations as $index => $d)` walks a list keyed
        # 0..n-1 in the normal (array) case; JSON always decodes an array
        # payload to a Python list, so enumerate() mirrors that.
        delegationItems = list(enumerate(delegations)) if isinstance(delegations, list) else list(delegations.items())

        userId = self._extractUserId(context)
        currentAgentId = self._extractCurrentAgentId(context)
        streamContext = self._extractStreamContext(context)

        if streamContext:
            streamContext.emit({
                'type': 'parallel_start',
                'count': len(delegationItems),
                'agents': [d.get('agent_name') if isinstance(d, dict) and d.get('agent_name') is not None else 'unknown'
                           for _, d in delegationItems],
                'timestamp': time.time(),
            })

        repo = self.runner.getFreshRepository()
        executor = self.runner.createParallelExecutor(True)  # record executions; no observer/bridge
        manager = repo.findById(currentAgentId) if currentAgentId else None

        # Build one state per valid delegation; collect index errors separately.
        states: list = []
        indexByKey: dict = {}
        errors: dict = {}
        for index, d in delegationItems:
            if not isinstance(d, dict):
                d = {}
            agentName = d.get('agent_name')
            task = d.get('task')
            if not agentName or not task:
                errors[index] = {
                    'index': index, 'agent': agentName if agentName is not None else 'unknown',
                    'task': d.get('task'), 'success': False, 'result': None,
                    'error': 'Missing agent_name or task', 'execution_id': None,
                }
                continue
            agent = repo.findByName(agentName, userId)
            if not agent or not agent.isEnabled():
                errors[index] = {
                    'index': index, 'agent': agentName,
                    'task': d.get('task'), 'success': False, 'result': None,
                    'error': f'Agent not found or disabled: {agentName}', 'execution_id': None,
                }
                continue
            if agent.isManager():
                errors[index] = {
                    'index': index, 'agent': agentName,
                    'task': d.get('task'), 'success': False, 'result': None,
                    'error': 'Cannot run a manager agent in a parallel batch', 'execution_id': None,
                }
                continue
            if manager and not manager.canDelegateToAgent(agent.getId()):
                errors[index] = {
                    'index': index, 'agent': agentName,
                    'task': d.get('task'), 'success': False, 'result': None,
                    'error': f"Manager cannot delegate to '{agentName}'", 'execution_id': None,
                }
                continue

            input_ = task
            ctx = php_trim(d.get('context') if d.get('context') is not None else '')
            if ctx != '':
                input_ = f"## Context from Previous Analysis\n{ctx}\n\n## Your Task\n{task}"

            states.append({
                'key': index,
                'agent': agent,
                'input': input_,
                'user_id': userId,
                'messages': [
                    {'role': 'system', 'content': agent.buildSystemPrompt()},
                    {'role': 'user', 'content': input_},
                ],
                'tools': executor.buildToolsFor(agent, agent.getTools() if agent.getTools() else None),
                'tools_filter': agent.getTools() if agent.getTools() else None,
            })
            indexByKey[index] = task

        execResults = executor.run(states) if states else {}

        # Merge executor results with pre-flight errors, preserving delegation order.
        results: list = []
        successCount = 0
        failCount = 0
        for index, d in delegationItems:
            if not isinstance(d, dict):
                d = {}
            if index in errors:
                results.append(errors[index])
                failCount += 1
                continue
            r = execResults.get(index) if execResults.get(index) is not None else {'success': False, 'output': None, 'execution_id': None}
            ok = bool(r.get('success') if r.get('success') is not None else False)
            results.append({
                'index': index,
                'agent': d.get('agent_name'),
                'task': indexByKey.get(index) if indexByKey.get(index) is not None else (d.get('task') if d.get('task') is not None else ''),
                'success': ok,
                'result': r.get('output'),
                'error': None if ok else (r.get('error') if r.get('error') is not None else (r.get('output') if r.get('output') is not None else 'Agent did not complete')),
                'execution_id': r.get('execution_id'),
            })
            if ok:
                successCount += 1
            else:
                failCount += 1

        if streamContext:
            streamContext.emit({
                'type': 'parallel_complete',
                'successful': successCount, 'failed': failCount, 'timestamp': time.time(),
            })

        return {
            'success': failCount == 0,
            'total_agents': len(delegationItems),
            'successful': successCount,
            'failed': failCount,
            'results': results,
            'message': f"Completed {successCount} of {len(delegationItems)} delegations",
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _formatAgentInfo(self, agent: 'Agent') -> dict:
        """PHP 559-569 (`formatAgentInfo`)."""
        return {
            'id': agent.getId(),
            'name': agent.getName(),
            'description': agent.getDescription(),
            'type': agent.getAgentType(),
            'provider': agent.getProvider(),
            'tools': agent.getTools(),
        }

    def _extractUserId(self, context) -> int:
        """PHP 574-583 (`extractUserId`)."""
        if isinstance(context, dict):
            return php_intval(context.get('user_id') if context.get('user_id') is not None else 0)
        if isinstance(context, int) and not isinstance(context, bool):
            return context
        return 0

    def _extractCurrentAgentId(self, context) -> int | None:
        """PHP 588-594 (`extractCurrentAgentId`)."""
        if isinstance(context, dict) and context.get('current_agent_id') is not None:
            return php_intval(context['current_agent_id'])
        return None

    def _extractParentExecutionId(self, context) -> int | None:
        """PHP 599-605 (`extractParentExecutionId`) — reads the CURRENT
        agent's own `execution_id`, which becomes the parent id for the
        delegated sub-agent's execution row."""
        if isinstance(context, dict) and context.get('execution_id') is not None:
            return php_intval(context['execution_id'])
        return None

    def _extractStreamContext(self, context) -> 'StreamContext | None':
        """PHP 610-618 (`extractStreamContext`)."""
        if isinstance(context, dict) and context.get('stream_context') is not None:
            sc = context['stream_context']
            return sc if isinstance(sc, StreamContext) else None
        return None

    # ------------------------------------------------------------------
    # complete_task
    # ------------------------------------------------------------------

    def completeTask(self, params: dict, context=None) -> dict:
        """Complete the workflow and allow manager to respond to user
        (PHP 632-647)."""
        reason = params.get('reason') if params.get('reason') is not None else 'Workflow complete'
        summary = params.get('summary') if params.get('summary') is not None else ''

        error_log(f"[DELEGATION] complete_task called: reason={reason}")

        return {
            'success': True,
            'status': 'workflow_complete',
            'marker': '___WORKFLOW_COMPLETE___',
            'reason': reason,
            'summary': summary,
            'instruction': 'You may now synthesize all results and respond to the user with your final answer.',
        }
