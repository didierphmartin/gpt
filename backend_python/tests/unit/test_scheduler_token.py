"""Port of backend/tests/Unit/AgentTeam/SchedulerTokenTest.php.

Without a signed-in user, /scheduler/run needs the configured token; a blank SCHEDULER_TOKEN never matches."""
from __future__ import annotations

import pytest
from starlette.datastructures import Headers

from app.agent_team.controllers.scheduler_controller import SchedulerController


def run(configured: str, body: dict, headers: dict | None = None) -> dict:
    c = SchedulerController(None, {'scheduler': {'token': configured}})
    c._executeScheduler = lambda: pytest.fail('the scheduler must not run')
    return c.run({'body': body, 'headers': Headers(headers or {})})


def test_blank_configured_token_refuses_every_token():
    assert run('', {'token': ''})['status_code'] == 401
    assert run('', {})['status_code'] == 401
    assert run('', {}, {'X-Scheduler-Token': ''})['status_code'] == 401


def test_wrong_or_non_string_token_is_refused():
    assert run('s3cret', {'token': 'nope'})['status_code'] == 401
    assert run('s3cret', {'token': ['s3cret']})['status_code'] == 401
