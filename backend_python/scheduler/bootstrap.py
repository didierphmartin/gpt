"""Port of backend/scheduler/bootstrap.php.

What the scheduler's CLI scripts share (run_scheduled_workflows.py, run_schedule.py): config, the CONTEXTS
database, the schedule service and the callable that runs one schedule's workflow once.

PHP's bootstrap throws a RuntimeException ('Configuration file not found' / 'Database connection failed: ...');
this one raises RuntimeError with the same texts (the config is env-based here: a ConfigError stands in for the
missing file). `close()` releases the assistant's HTTP clients and the connection (PHP's process just exits).
"""
from __future__ import annotations

from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.agent_runner import AgentRunner
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.schedule_tick import ScheduleTick
from app.agent_team.services.scheduled_workflow_service import ScheduledWorkflowService
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.agent_team.services.workflow_runner import WorkflowRunner
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.config import ConfigError, load_config
from app.db import open_primary
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support.logger import error_log


def boot() -> dict:
    try:
        config = load_config()
    except ConfigError as e:
        raise RuntimeError(str(e)) from e
    try:
        db = open_primary(config)
    except Exception as e:  # noqa: BLE001 -- PHP: catch (PDOException $e)
        raise RuntimeError(f'Database connection failed: {e}') from e

    workflowRepository = WorkflowRepository(db)
    graphRepository = workflowRepository.getGraphRepository()
    agentRepository = AgentRepository(db)
    assistant = AIPortfolioAssistant(config)
    assistant.setDatabase(db)
    agentRunner = AgentRunner(assistant.getLLMManager(), assistant.getToolsManager(), MCPToolsLoader(db), db, config)

    def close() -> None:
        try:
            assistant.close()
        except Exception as closeErr:  # noqa: BLE001
            error_log(f'[scheduler] assistant.close() failed: {closeErr}')
        db.close()

    return {
        'config': config,
        'pdo': db,
        'schedules': ScheduledWorkflowService(db),
        'runSchedule': ScheduleTick.workflowRunner(
            workflowRepository, graphRepository,
            GraphWorkflowRunner(db, agentRepository, agentRunner, graphRepository, config),
            WorkflowRunner(db, agentRepository, agentRunner, config)),
        'close': close,
    }
