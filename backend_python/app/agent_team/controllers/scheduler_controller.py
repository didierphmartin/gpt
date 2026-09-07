"""Port of backend/src/AgentTeam/Controllers/SchedulerController.php
(238 lines).

Provides API access to the workflow scheduler — an alternative to the
direct cron script (`backend_python/scripts/` — a Phase 8 sibling task, not
this file), allowing authenticated admin access OR a shared scheduler token
to trigger due-schedule execution.

`run` (PHP 43-76): the internal-token check reads `config['scheduler']['token']`
(SchedulerController.php:50), which `app/config.py` already exposes from the
same env var PHP does (`ai_config.php:165`: `$_ENV['SCHEDULER_TOKEN']` ->
`config.py:108`: `'scheduler': {'token': _e('SCHEDULER_TOKEN'), ...}` — no
config.py change needed). The route `/api/v1/scheduler/run` is public on
both backends (PHP: MiddlewareProcessor::PUBLIC_ROUTES line 36; Python:
app/middleware/processor.py PUBLIC_ROUTES, already present pre-Task-2)
precisely so a cron job with only the token (no user session) can call it.
Token comparison is plain `!=` (PHP uses `!==`, not `hash_equals` —
SchedulerController.php:53), per constraints.md.

`executeScheduler` (PHP 120-237, `private` -> `_executeScheduler` here)
builds the same AIPortfolioAssistant/AgentRunner/WorkflowRunner/
GraphWorkflowRunner stack WorkflowController.__init__ builds (Phase 5), but
per-call (inside this method, not the constructor) exactly as PHP does —
matching PHP's own comment that this is a request-scoped assistant, not a
shared one. `self.assistant` is a Python-only attribute (PHP has no
equivalent — Guzzle clients die with the request) so `run()`'s outer
`finally` can close its provider httpx.Client(s), same rule as
WorkflowController.run/runStream (Phase 5).
"""
from __future__ import annotations

from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.agent_runner import AgentRunner
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.scheduled_workflow_service import ScheduledWorkflowService
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.agent_team.services.workflow_runner import WorkflowRunner
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.llm_provider_resolver import LLMProviderResolver
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval, php_now, php_tz


class SchedulerController:
    def __init__(self, db, config):
        """PHP 31-36."""
        self.db = db
        self.config = config
        self.scheduleService = ScheduledWorkflowService(db)
        # Python-only cleanup ref — see module docstring.
        self.assistant = None

    # ========================================================================
    # POST /api/v1/scheduler/run
    # ========================================================================

    def run(self, request) -> dict:
        """PHP 43-76."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        body = request['body'] if request.get('body') is not None else {}

        # Check for scheduler token in body (allows cron/external trigger)
        schedulerToken = body.get('token')
        if schedulerToken is None:
            schedulerToken = request['headers'].get('X-Scheduler-Token')
        schedulerCfg = self.config.get('scheduler')
        expectedToken = (schedulerCfg.get('token') if isinstance(schedulerCfg, dict) else None)
        if expectedToken is None:
            expectedToken = ''

        # Either need valid user auth or valid scheduler token
        if not userId and schedulerToken != expectedToken:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            results = self._executeScheduler()
            return {'success': True, 'data': results, 'status_code': 200}
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
            return {'success': False, 'error': str(e), 'status_code': 500}
        finally:
            # Python-only cleanup — see module docstring.
            if self.assistant is not None:
                try:
                    self.assistant.close()
                except Exception as closeErr:  # noqa: BLE001
                    error_log(f'[SchedulerController] assistant.close() failed: {closeErr}')

    # ========================================================================
    # GET /api/v1/scheduler/status
    # ========================================================================

    def status(self, request) -> dict:
        """PHP 82-115."""
        userId = request['user_id'] if request.get('user_id') is not None else 0

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            dueSchedules = self.scheduleService.getDueSchedules()
            userStats = self.scheduleService.getStats(userId)

            return {
                'success': True,
                'data': {
                    'due_count': len(dueSchedules),
                    'user_stats': userStats,
                    'server_time': php_now(),
                    'timezone': php_tz().key,
                },
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # Execute the scheduler logic — PHP 120-237 (`private function
    # executeScheduler`)
    # ========================================================================

    def _executeScheduler(self) -> dict:
        workflowRepository = WorkflowRepository(self.db)
        graphRepository = workflowRepository.getGraphRepository()
        agentRepository = AgentRepository(self.db)

        # Create AI assistant for LLM and tools. DB-overlay so providers from
        # system_llm_settings register correctly (post-cutover the file no
        # longer carries provider blocks).
        config = LLMProviderResolver.applyDbSettings(self.db, self.config)
        self.assistant = AIPortfolioAssistant(config)
        self.assistant.setDatabase(self.db)
        mcpToolsLoader = MCPToolsLoader(self.db)

        agentRunner = AgentRunner(
            self.assistant.getLLMManager(),
            self.assistant.getToolsManager(),
            mcpToolsLoader,
            self.db,
            self.config,
        )

        graphWorkflowRunner = GraphWorkflowRunner(
            self.db,
            agentRepository,
            agentRunner,
            graphRepository,
            self.config,
        )

        workflowRunner = WorkflowRunner(
            self.db,
            agentRepository,
            agentRunner,
            self.config,
        )

        # Get due schedules
        dueSchedules = self.scheduleService.getDueSchedules()

        results = {
            'timestamp': php_now(),
            'due_count': len(dueSchedules),
            'executed': [],
            'failed': [],
        }

        for schedule in dueSchedules:
            scheduleId = php_intval(schedule['id'])
            workflowId = php_intval(schedule['workflow_id'])
            userId = php_intval(schedule['user_id'])
            inputPrompt = schedule['input_prompt']

            try:
                # Mark as running
                self.scheduleService.markRunning(scheduleId)

                # Load workflow
                workflow = workflowRepository.findById(workflowId)

                if not workflow:
                    raise Exception(f'Workflow #{workflowId} not found')

                if not workflow.isEnabled():
                    raise Exception(f'Workflow #{workflowId} is disabled')

                # Prepare input variables
                inputVariables = {}
                if not php_empty(inputPrompt):
                    inputVariables['user_prompt'] = inputPrompt
                    inputVariables['prompt'] = inputPrompt

                # Check if graph-based workflow
                hasGraphNodes = graphRepository.getNodes(workflowId)
                isGraphWorkflow = not php_empty(hasGraphNodes)

                # Execute workflow
                if isGraphWorkflow:
                    result = graphWorkflowRunner.run(workflow, userId, inputVariables)
                else:
                    result = workflowRunner.run(workflow, userId, inputVariables)

                if result.get('success'):
                    self.scheduleService.markCompleted(scheduleId)
                    results['executed'].append({
                        'schedule_id': scheduleId,
                        'workflow_id': workflowId,
                        'workflow_name': schedule['workflow_name'],
                        'execution_id': result.get('execution_id'),
                    })
                else:
                    raise Exception(
                        result['error'] if result.get('error') is not None else 'Workflow execution failed'
                    )

            except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
                errorMessage = str(e)
                self.scheduleService.markFailed(scheduleId, errorMessage)

                results['failed'].append({
                    'schedule_id': scheduleId,
                    'workflow_id': workflowId,
                    'workflow_name': (
                        schedule['workflow_name'] if schedule.get('workflow_name') is not None else 'Unknown'
                    ),
                    'error': errorMessage,
                })

                error_log(
                    f'Scheduled workflow failed: Schedule #{scheduleId}, '
                    f'Workflow #{workflowId}: {errorMessage}'
                )

        results['executed_count'] = len(results['executed'])
        results['failed_count'] = len(results['failed'])

        return results
