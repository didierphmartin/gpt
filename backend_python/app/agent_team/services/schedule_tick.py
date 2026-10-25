"""Port of backend/src/AgentTeam/Services/ScheduleTick.php.

One scheduler tick: run every due schedule once, or, for a run that did work after a code node
(drain), again at once until it reports nothing to do, at most MAX_RUNS_PER_TICK times.
Shared by SchedulerController (HTTP) and scheduler/run_scheduled_workflows.py (cron CLI).
"""
from __future__ import annotations

from collections.abc import Callable

from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval, php_now


class ScheduleTick:
    MAX_RUNS_PER_TICK = 20

    def __init__(self, schedules, runSchedule: Callable[[dict], dict], log: Callable[[str], None] | None = None):
        self.schedules = schedules
        self.runSchedule = runSchedule
        self.log = log if log is not None else (lambda line: None)

    def run(self, workflowIds: list | None = None) -> dict:
        """`workflowIds`: run only these workflows' due rows (the active schedule-mode ones); None runs every due row."""
        due = self.schedules.getDueSchedules(workflowIds)
        results = {'timestamp': php_now(), 'due_count': len(due), 'executed': [], 'failed': [], 'quiet_count': 0}
        self.log(f'Found {len(due)} due schedule(s)')

        for schedule in due:
            id = php_intval(schedule['id'])
            if not self.schedules.claim(id):
                continue   # another tick took it
            try:
                r = self.drain(lambda: self.runSchedule(schedule), lambda: self.schedules.touchRunning(id))
                results['quiet_count'] += r['quiet_count']
                for executionId in r['execution_ids']:
                    results['executed'].append({
                        'schedule_id': id, 'workflow_id': php_intval(schedule['workflow_id']),
                        'workflow_name': schedule.get('workflow_name'), 'execution_id': executionId})
                self.schedules.markCompleted(id)
                self.log(f"✓ Schedule #{id}: {r['runs']} run(s)")
            except Exception as e:  # noqa: BLE001 -- PHP catch (\Throwable)
                self.schedules.markFailed(id, str(e))
                results['failed'].append({
                    'schedule_id': id, 'workflow_id': php_intval(schedule['workflow_id']),
                    'workflow_name': schedule.get('workflow_name') if schedule.get('workflow_name') is not None else 'Unknown',
                    'error': str(e)})
                self.log(f'✗ Schedule #{id} failed: {e}')
                error_log(f"Scheduled workflow failed: Schedule #{id}, Workflow #{schedule['workflow_id']}: {e}")

        results['executed_count'] = len(results['executed'])
        results['failed_count'] = len(results['failed'])
        return results

    @classmethod
    def drain(cls, runOnce: Callable[[], dict], touch: Callable[[], None] | None = None) -> dict:
        """Run once, or, for a run that did work after a code node (drain), again at once until it reports
        nothing to do, at most MAX_RUNS_PER_TICK times. Shared by the tick and scheduler/run_schedule.py."""
        runs = 0
        quietCount = 0
        executionIds = []
        while True:
            if touch is not None:
                touch()   # a long drain stays claimed
            result = runOnce()
            runs += 1
            if php_empty(result.get('success')):
                raise RuntimeError(result['error'] if result.get('error') is not None else 'Workflow execution failed')
            quiet = not php_empty(result.get('quiet'))
            if quiet:
                quietCount += 1
            else:
                executionIds.append(result.get('execution_id'))
            # Drain only when a code node ran and the run found work.
            if not (not quiet and not php_empty(result.get('drain')) and runs < cls.MAX_RUNS_PER_TICK):
                break
        return {'runs': runs, 'quiet_count': quietCount, 'execution_ids': executionIds}

    @staticmethod
    def workflowRunner(workflows, graphRepository, graphRunner, linearRunner) -> Callable[[dict], dict]:
        """The runSchedule callable both entry points use: load the workflow and run it once."""
        def run(schedule: dict) -> dict:
            workflowId = php_intval(schedule['workflow_id'])
            workflow = workflows.findById(workflowId)
            if not workflow:
                return {'success': False, 'error': f'Workflow #{workflowId} not found'}
            if not workflow.isEnabled():
                return {'success': False, 'error': f'Workflow #{workflowId} is disabled'}
            input = {}
            if not php_empty(schedule.get('input_prompt')):
                input['user_prompt'] = schedule['input_prompt']
                input['prompt'] = schedule['input_prompt']
            userId = php_intval(schedule['user_id'])
            return (graphRunner.run(workflow, userId, input) if not php_empty(graphRepository.getNodes(workflowId))
                    else linearRunner.run(workflow, userId, input))
        return run
