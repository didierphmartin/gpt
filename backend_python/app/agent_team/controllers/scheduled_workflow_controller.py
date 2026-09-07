"""Port of backend/src/AgentTeam/Controllers/ScheduledWorkflowController.php
(436 lines).

CRUD + lifecycle (pause/resume) for scheduled workflow runs, plus
per-workflow listing and aggregate stats. Every method delegates to
`ScheduledWorkflowService` (Task 1, scheduled_workflow_service.py) for the
actual DB work; this controller only does auth/validation/ownership and
response shaping, exactly like PHP. Same method names, same validation
strings, same status codes.

Ported: index, create, show, update, destroy, pause, resume, stats,
byWorkflow. No private helpers in the PHP source for this class.
"""
from __future__ import annotations

from app.agent_team.services.scheduled_workflow_service import ScheduledWorkflowService
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.support.phpcompat import php_empty, php_intval

_VALID_REPEAT_TYPES = ('none', 'hourly', 'daily', 'weekly', 'monthly')


class ScheduledWorkflowController:
    def __init__(self, db, config):
        """PHP 23-29."""
        self.db = db
        self.config = config
        self.scheduleService = ScheduledWorkflowService(db)
        self.workflowRepository = WorkflowRepository(db)

    # ========================================================================
    # GET /api/v1/schedules
    # ========================================================================

    def index(self, request) -> dict:
        """PHP 35-63."""
        userId = request['user_id'] if request.get('user_id') is not None else 0

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            schedules = self.scheduleService.findByUser(userId)
            return {'success': True, 'data': schedules, 'count': len(schedules), 'status_code': 200}
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # POST /api/v1/schedules
    # ========================================================================

    def create(self, request) -> dict:
        """PHP 69-142."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if php_empty(body.get('workflow_id')):
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        if php_empty(body.get('scheduled_time')):
            return {'success': False, 'error': 'Scheduled time is required', 'status_code': 400}

        # Verify the workflow exists and belongs to the user
        workflow = self.workflowRepository.findById(php_intval(body['workflow_id']))
        if not workflow or workflow.getUserId() != userId:
            return {'success': False, 'error': 'Workflow not found', 'status_code': 404}

        # Validate repeat_type if provided
        repeatType = body.get('repeat_type')
        if not php_empty(repeatType) and repeatType not in _VALID_REPEAT_TYPES:
            return {
                'success': False,
                'error': 'Invalid repeat type. Must be one of: ' + ', '.join(_VALID_REPEAT_TYPES),
                'status_code': 400,
            }

        try:
            schedule = self.scheduleService.create({
                'user_id': userId,
                'workflow_id': php_intval(body['workflow_id']),
                'input_prompt': body.get('input_prompt'),
                'scheduled_time': body['scheduled_time'],
                'repeat_type': body['repeat_type'] if body.get('repeat_type') is not None else 'none',
                'repeat_interval': php_intval(body['repeat_interval']) if body.get('repeat_interval') is not None else 1,
            })

            return {
                'success': True,
                'data': schedule,
                'message': 'Schedule created successfully',
                'status_code': 201,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/schedules/{id}
    # ========================================================================

    def show(self, request, id: int = 0) -> dict:
        """PHP 148-184."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        scheduleId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            schedule = self.scheduleService.findById(scheduleId)

            if not schedule or schedule['user_id'] != userId:
                return {'success': False, 'error': 'Schedule not found', 'status_code': 404}

            return {'success': True, 'data': schedule, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # PUT /api/v1/schedules/{id}
    # ========================================================================

    def update(self, request, id: int = 0) -> dict:
        """PHP 190-240."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        scheduleId = php_intval(id)
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        # Validate repeat_type if provided
        if not php_empty(body.get('repeat_type')):
            if body['repeat_type'] not in _VALID_REPEAT_TYPES:
                return {'success': False, 'error': 'Invalid repeat type', 'status_code': 400}

        try:
            schedule = self.scheduleService.update(scheduleId, userId, body)

            if not schedule:
                return {'success': False, 'error': 'Schedule not found', 'status_code': 404}

            return {
                'success': True,
                'data': schedule,
                'message': 'Schedule updated successfully',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # DELETE /api/v1/schedules/{id}
    # ========================================================================

    def destroy(self, request, id: int = 0) -> dict:
        """PHP 246-282."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        scheduleId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            deleted = self.scheduleService.delete(scheduleId, userId)

            if not deleted:
                return {'success': False, 'error': 'Schedule not found', 'status_code': 404}

            return {'success': True, 'message': 'Schedule deleted successfully', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # POST /api/v1/schedules/{id}/pause
    # ========================================================================

    def pause(self, request, id: int = 0) -> dict:
        """PHP 288-324."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        scheduleId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            paused = self.scheduleService.pause(scheduleId, userId)

            if not paused:
                return {
                    'success': False,
                    'error': 'Schedule not found or cannot be paused',
                    'status_code': 404,
                }

            return {'success': True, 'message': 'Schedule paused successfully', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # POST /api/v1/schedules/{id}/resume
    # ========================================================================

    def resume(self, request, id: int = 0) -> dict:
        """PHP 330-366."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        scheduleId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            resumed = self.scheduleService.resume(scheduleId, userId)

            if not resumed:
                return {
                    'success': False,
                    'error': 'Schedule not found or not paused',
                    'status_code': 404,
                }

            return {'success': True, 'message': 'Schedule resumed successfully', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/schedules/stats
    # ========================================================================

    def stats(self, request) -> dict:
        """PHP 372-399."""
        userId = request['user_id'] if request.get('user_id') is not None else 0

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            stats = self.scheduleService.getStats(userId)
            return {'success': True, 'data': stats, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/workflows/{id}/schedules
    # ========================================================================

    def byWorkflow(self, request, id: int = 0) -> dict:
        """PHP 405-434."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            schedules = self.scheduleService.findByWorkflow(workflowId, userId)
            return {'success': True, 'data': schedules, 'count': len(schedules), 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}
