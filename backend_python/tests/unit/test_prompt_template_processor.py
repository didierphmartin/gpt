"""No PHP oracle test exists for PromptTemplateProcessor (see
backend/src/AgentTeam/Services/PromptTemplateProcessor.php) — cases per the
Phase 5 task-1 brief: each placeholder in a fixed timezone (America/New_York)
with a frozen `now`, custom variable precedence, hasPlaceholders,
getAvailablePlaceholders exact list.

Frozen "now": php_date()'s dt=None path calls the module-level `_now(tz)`
seam in app.support.phpcompat, so tests monkeypatch that instead of the
real clock (mirrors PHP's `new \\DateTime('now', $tz)` deterministically).
"""
from datetime import datetime
from zoneinfo import ZoneInfo

import app.support.phpcompat as phpcompat
from app.agent_team.services.prompt_template_processor import PromptTemplateProcessor

FROZEN = datetime(2026, 4, 7, 15, 45, 30, tzinfo=ZoneInfo('America/New_York'))


def _freeze(monkeypatch):
    # FROZEN is already America/New_York; astimezone(tz) re-expresses it in
    # whatever tz the processor asks for (matching PHP's DateTime('now', $tz)).
    monkeypatch.setattr(phpcompat, '_now', lambda tz: FROZEN.astimezone(tz))


def _proc(monkeypatch, tz='America/New_York'):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor()
    p.setTimezone(tz)
    return p


def test_date_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[date]') == 'April 7, 2026'


def test_time_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[time]') == '3:45 PM'


def test_datetime_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[datetime]') == 'April 7, 2026 3:45 PM'


def test_year_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[year]') == '2026'


def test_month_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[month]') == 'April'


def test_month_num_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[month_num]') == '4'


def test_day_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[day]') == '7'


def test_weekday_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[weekday]') == 'Tuesday'


def test_timezone_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[timezone]') == 'America/New_York'


def test_iso_date_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[iso_date]') == '2026-04-07'


def test_iso_datetime_placeholder(monkeypatch):
    p = _proc(monkeypatch)
    assert p.process('[iso_datetime]') == '2026-04-07T15:45:30-04:00'


def test_username_placeholder_default_and_set(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor()
    assert p.process('[username]') == 'User'
    p.setContext({'username': 'Didier'})
    assert p.process('[username]') == 'Didier'


def test_user_email_placeholder(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor().setContext({'user_email': 'a@b.com'})
    assert p.process('[user_email]') == 'a@b.com'
    assert PromptTemplateProcessor().process('[user_email]') == ''


def test_user_id_placeholder_casts_to_string(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor().setContext({'user_id': 42})
    assert p.process('[user_id]') == '42'
    assert PromptTemplateProcessor().process('[user_id]') == ''


def test_user_locale_placeholder_default_and_set(monkeypatch):
    _freeze(monkeypatch)
    assert PromptTemplateProcessor().process('[user_locale]') == 'en-US'
    p = PromptTemplateProcessor().setContext({'user_locale': 'fr-FR'})
    assert p.process('[user_locale]') == 'fr-FR'


def test_workflow_placeholders(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor().setContext({
        'workflow_name': 'Dispatcher demo',
        'workflow_id': 44,
        'agent_name': 'Receptionist',
        'node_name': 'Node A',
        'node_id': 7,
        'user_prompt': 'hi there',
        'previous_output': 'prior text',
    })
    assert p.process('[workflow_name]') == 'Dispatcher demo'
    assert p.process('[workflow_id]') == '44'
    assert p.process('[agent_name]') == 'Receptionist'
    assert p.process('[node_name]') == 'Node A'
    assert p.process('[node_id]') == '7'
    assert p.process('[user_prompt]') == 'hi there'
    assert p.process('[previous_output]') == 'prior text'
    empty = PromptTemplateProcessor()
    assert empty.process('[workflow_name]') == ''
    assert empty.process('[workflow_id]') == ''
    assert empty.process('[agent_name]') == ''
    assert empty.process('[node_name]') == ''
    assert empty.process('[node_id]') == ''
    assert empty.process('[user_prompt]') == ''
    assert empty.process('[previous_output]') == ''


def test_app_placeholders_default_and_set(monkeypatch):
    _freeze(monkeypatch)
    assert PromptTemplateProcessor().process('[app_name]') == 'AI Assistant'
    assert PromptTemplateProcessor().process('[app_version]') == '1.0'
    p = PromptTemplateProcessor().setContext({'app_name': 'SynergyAI', 'app_version': '2.3'})
    assert p.process('[app_name]') == 'SynergyAI'
    assert p.process('[app_version]') == '2.3'


def test_unknown_placeholder_returned_as_is(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor()
    assert p.process('[bogus]') == '[bogus]'


def test_multiple_placeholders_in_one_prompt(monkeypatch):
    p = _proc(monkeypatch)
    p.setContext({'username': 'Didier'})
    assert p.process('Hi [username], today is [date].') == 'Hi Didier, today is April 7, 2026.'


def test_custom_variable_precedence_custom_vars_over_workflow_vars(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor().setContext({
        'custom_vars': {'region': 'EMEA'},
        'workflow_vars': {'region': 'APAC', 'tier': 'gold'},
    })
    # custom_vars wins when both define the same name
    assert p.process('[var:region]') == 'EMEA'
    # falls back to workflow_vars when custom_vars doesn't have it
    assert p.process('[var:tier]') == 'gold'
    # unknown variable name -> placeholder echoed back
    assert p.process('[var:missing]') == '[var:missing]'


def test_custom_variable_casts_non_string_values(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor().setContext({'custom_vars': {'count': 5}})
    assert p.process('[var:count]') == '5'


def test_has_placeholders():
    assert PromptTemplateProcessor.hasPlaceholders('Hello [username]') is True
    assert PromptTemplateProcessor.hasPlaceholders('Hello [var:x]') is True
    assert PromptTemplateProcessor.hasPlaceholders('No placeholders here') is False
    assert PromptTemplateProcessor.hasPlaceholders('') is False


def test_get_available_placeholders_exact_list():
    assert PromptTemplateProcessor.getAvailablePlaceholders() == {
        'Date/Time': {
            '[date]': 'Current date (e.g., "April 7, 2026")',
            '[time]': 'Current time (e.g., "3:45 PM")',
            '[datetime]': 'Full date and time',
            '[year]': 'Current year (e.g., "2026")',
            '[month]': 'Current month name (e.g., "April")',
            '[month_num]': 'Current month number (e.g., "4")',
            '[day]': 'Day of month (e.g., "7")',
            '[weekday]': 'Day of week (e.g., "Monday")',
            '[timezone]': 'Current timezone',
            '[iso_date]': 'ISO date format (YYYY-MM-DD)',
            '[iso_datetime]': 'ISO 8601 datetime format',
        },
        'User Context': {
            '[username]': "Current user's name",
            '[user_email]': "User's email address",
            '[user_id]': "User's ID",
            '[user_locale]': 'User\'s locale (e.g., "en-US")',
        },
        'Workflow Context': {
            '[workflow_name]': 'Name of current workflow',
            '[workflow_id]': 'ID of current workflow',
            '[agent_name]': "This agent's name",
            '[node_name]': 'Current node name',
            '[node_id]': 'Current node ID',
            '[user_prompt]': 'Original user input/prompt',
            '[previous_output]': 'Output from previous node',
        },
        'System': {
            '[app_name]': 'Application name',
            '[app_version]': 'Application version',
        },
        'Custom Variables': {
            '[var:name]': 'Custom workflow variable (replace "name" with variable name)',
        },
    }


def test_invalid_timezone_falls_back_to_utc(monkeypatch):
    _freeze(monkeypatch)
    p = PromptTemplateProcessor().setTimezone('Not/AZone')
    assert p.process('[timezone]') == 'Not/AZone'  # getTimezone() returns the raw string as set
    # but date formatting falls back to UTC rather than raising
    assert p.process('[iso_date]') == FROZEN.astimezone(ZoneInfo('UTC')).strftime('%Y-%m-%d')


def test_default_timezone_falls_back_to_php_tz(monkeypatch):
    monkeypatch.setenv('PHP_TIMEZONE', 'Europe/Berlin')
    _freeze(monkeypatch)
    p = PromptTemplateProcessor()
    assert p.process('[timezone]') == 'Europe/Berlin'
