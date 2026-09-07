"""Port of backend/scheduler/run-scheduled-workflows.php (CLI branch only).

This script executes due scheduled workflows. It exists solely to be
invoked by cron:

    * * * * * cd /path/to/backend_python && .venv/bin/python \\
        -m scheduler.run_scheduled_workflows >> /var/log/workflow-scheduler.log 2>&1

(the PHP original's crontab comment used `php /path/to/run-scheduled-workflows.php`;
this is its Python twin — DO NOT install this crontab line yourself, it is
documentation only).

Ad-hoc run from a shell:

    cd backend_python && .venv/bin/python -m scheduler.run_scheduled_workflows

**HTTP branch not ported.** PHP's source file doubles as an HTTP endpoint
(`php_sapi_name() !== 'cli'` branch: token-gated via
`$config['scheduler']['token']`, JSON response). That branch is superseded
in this port by `SchedulerController::run`'s HTTP route (Phase 8 Task 2,
`app/agent_team/controllers/scheduler_controller.py`), which is registered
in `app/routes.py` by its own task — routes.py is out of this task's scope
(constraints.md: "Touch no other files"). This module is CLI-only, matching
the brief's "Runnable as `cd backend_python && .venv/bin/python -m
scheduler.run_scheduled_workflows [flags]`".

**CLI flags: none.** PHP's source has no `getopt()`/`$argv` parsing at all —
every invocation runs the same full scheduler pass, and any command-line
arguments are silently ignored. This module mirrors that with an
`argparse.ArgumentParser(add_help=False)` fed through `parse_known_args`,
so it likewise accepts (and ignores) any arguments, INCLUDING `-h`/`--help`
(PHP has no help text to print, so neither does this module — `--help`
just runs the scheduler, exactly like every other argv value).

**Lock/overlap protection: none, by design (matches PHP).** The PHP source
has no `flock()`/lock-file mechanism anywhere in this script (confirmed:
grepped the whole `backend/scheduler/` tree and the file's one-commit git
history — no lock code ever existed). Overlap protection is left entirely
to `ScheduledWorkflowService.getDueSchedules()`'s `WHERE status = 'pending'`
filter and `markRunning()` flipping the row to `status = 'running'` before
work starts: two concurrent cron ticks can both SELECT the same due row in
the (small) race window before either UPDATEs it, but a real overlap
requires that race, not a file lock. This module reproduces that exact
absence of a lock rather than inventing one PHP does not have.

**PHP's `set_error_handler`, not ported.** PHP installs a callback that
catches PHP-level warnings/notices (not exceptions) and mirrors them to
STDERR (CLI) + `error_log()`. Python has no equivalent concept (there is no
non-fatal "warning" channel a callback intercepts) — genuine failures here
already surface as Python exceptions and are handled by the same
try/except + `error_log()` calls this module already has for the PHP
`catch (Exception $e)` blocks.

**Config-not-found / DB-connect-failure messages.** PHP checks
`file_exists($configPath)` for `config/ai_config.php` and prints
"Configuration file not found" specifically for that. This port's
bootstrap is env-var based (`app/config.py: load_config`), per the task
brief ("bootstraps the Python app's config/DB the way `app/main.py` does") —
there is no `ai_config.php` file to check for. A `ConfigError` (missing
required env vars) is printed to stderr and exits 1, in the same structural
position PHP's file-not-found check occupies. The DB-connect failure branch
IS a literal port: PHP catches `PDOException` and prints
"Database connection failed: {message}"; this module catches the
`open_primary()` exception and prints the same text.
"""
from __future__ import annotations

import argparse
import sys

from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.agent_runner import AgentRunner
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.scheduled_workflow_service import ScheduledWorkflowService
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.agent_team.services.workflow_runner import WorkflowRunner
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.config import ConfigError, load_config
from app.db import open_primary
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support.logger import error_log
from app.support.phpcompat import php_coalesce, php_empty, php_intval, php_now


def _build_arg_parser() -> argparse.ArgumentParser:
    """PHP has no getopt()/$argv parsing in this script at all — every
    argument (including -h/--help) is silently ignored and the full
    scheduler pass runs regardless. `add_help=False` + `parse_known_args`
    (see `main()`) reproduces that: no flag this parser doesn't know about
    (which is all of them) ever aborts the run."""
    return argparse.ArgumentParser(prog='run_scheduled_workflows', add_help=False)


def main(argv: list[str] | None = None) -> int:
    """PHP 20-95 (bootstrap) — CLI branch only (see module docstring)."""
    _build_arg_parser().parse_known_args(argv if argv is not None else sys.argv[1:])

    try:
        config = load_config()
    except ConfigError as e:
        print(str(e), file=sys.stderr)
        return 1

    try:
        db = open_primary(config)
    except Exception as e:  # noqa: BLE001 — PHP: catch (PDOException $e)
        print(f'Database connection failed: {e}', file=sys.stderr)
        return 1

    try:
        return _run(db, config)
    finally:
        db.close()


def _run(db, config: dict) -> int:
    """PHP 98-232 (service/runner construction + the due-schedules loop)."""
    schedule_service = ScheduledWorkflowService(db)
    workflow_repository = WorkflowRepository(db)
    graph_repository = workflow_repository.getGraphRepository()
    agent_repository = AgentRepository(db)

    # Create AI assistant for LLM and tools (PHP 105-109). No DB-settings
    # overlay here — PHP's cron script never calls anything like
    # LLMProviderResolver::applyDbSettings (unlike WorkflowController /
    # AgentController), so this doesn't either; ported literally.
    assistant = AIPortfolioAssistant(config)
    assistant.setDatabase(db)
    mcp_tools_loader = MCPToolsLoader(db)

    agent_runner = AgentRunner(
        assistant.getLLMManager(),
        assistant.getToolsManager(),
        mcp_tools_loader,
        db,
        config,
    )

    graph_workflow_runner = GraphWorkflowRunner(
        db, agent_repository, agent_runner, graph_repository, config,
    )
    workflow_runner = WorkflowRunner(db, agent_repository, agent_runner, config)

    due_schedules = schedule_service.getDueSchedules()

    executed: list[dict] = []
    failed: list[dict] = []

    print(f"[{php_now()}] Found {len(due_schedules)} due schedule(s)")

    for schedule in due_schedules:
        schedule_id = php_intval(schedule['id'])
        workflow_id = php_intval(schedule['workflow_id'])
        user_id = php_intval(schedule['user_id'])
        input_prompt = schedule['input_prompt']

        print(f"[{php_now()}] Executing schedule #{schedule_id} (workflow #{workflow_id})")

        try:
            schedule_service.markRunning(schedule_id)

            workflow = workflow_repository.findById(workflow_id)

            if not workflow:
                raise Exception(f"Workflow #{workflow_id} not found")

            if not workflow.isEnabled():
                raise Exception(f"Workflow #{workflow_id} is disabled")

            input_variables: dict = {}
            if input_prompt:
                input_variables['user_prompt'] = input_prompt
                input_variables['prompt'] = input_prompt

            has_graph_nodes = graph_repository.getNodes(workflow_id)
            is_graph_workflow = not php_empty(has_graph_nodes)

            if is_graph_workflow:
                result = graph_workflow_runner.run(workflow, user_id, input_variables)
            else:
                result = workflow_runner.run(workflow, user_id, input_variables)

            if result.get('success'):
                schedule_service.markCompleted(schedule_id)
                executed.append({
                    'schedule_id': schedule_id,
                    'workflow_id': workflow_id,
                    'workflow_name': schedule['workflow_name'],
                    'execution_id': result.get('execution_id'),
                })

                print(f"[{php_now()}] ✓ Schedule #{schedule_id} completed successfully")
            else:
                raise Exception(php_coalesce(result.get('error'), 'Workflow execution failed'))

        except Exception as e:  # noqa: BLE001 — PHP: catch (Exception $e)
            error_message = str(e)
            schedule_service.markFailed(schedule_id, error_message)

            failed.append({
                'schedule_id': schedule_id,
                'workflow_id': workflow_id,
                'workflow_name': php_coalesce(schedule.get('workflow_name'), 'Unknown'),
                'error': error_message,
            })

            print(f"[{php_now()}] ✗ Schedule #{schedule_id} failed: {error_message}")

            error_log(f"Scheduled workflow failed: Schedule #{schedule_id}, "
                      f"Workflow #{workflow_id}: {error_message}")

    print(f"[{php_now()}] Completed: {len(executed)} succeeded, {len(failed)} failed")

    return 0


if __name__ == '__main__':
    sys.exit(main())
