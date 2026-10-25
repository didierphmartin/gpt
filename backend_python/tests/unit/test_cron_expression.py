"""Port of backend/tests/Unit/CronExpressionTest.php."""
from __future__ import annotations

from datetime import datetime

from app.agent_team.services.cron_expression import CronExpression


def at(s: str) -> datetime:
    return datetime.fromisoformat(s)


def fmt(t: datetime) -> str:
    return t.strftime('%Y-%m-%d %H:%M')


def test_simple_creation():
    assert CronExpression('*/2 * * * *') is not None


def test_every_two_minutes():
    c = CronExpression('*/2 * * * *')
    assert fmt(c.nextAfter(at('2026-10-07 10:42:30'))) == '2026-10-07 10:44'
    assert fmt(c.nextAfter(at('2026-10-07 10:43:00'))) == '2026-10-07 10:44'


def test_weekdays_office_hours():
    c = CronExpression('*/5 8-18 * * 1-5')
    # Friday 18:57 -> Monday 08:00 (2026-10-09 is a Friday)
    assert fmt(c.nextAfter(at('2026-10-09 18:57'))) == '2026-10-12 08:00'
    assert fmt(c.nextAfter(at('2026-10-09 18:50'))) == '2026-10-09 18:55'


def test_sunday_as_seven():
    c = CronExpression('0 9 * * 7')
    assert fmt(c.nextAfter(at('2026-10-07 00:00'))) == '2026-10-11 09:00'


def test_day_of_month_or_day_of_week_when_both_restricted():
    # Standard cron: both restricted -> either matches. 1st of month OR Monday.
    c = CronExpression('0 0 1 * 1')
    assert fmt(c.nextAfter(at('2026-10-07 00:00'))) == '2026-10-12 00:00'


def test_lists_ranges_and_steps():
    c = CronExpression('5,35 9-17/4 * * *')
    assert c.matches(at('2026-10-07 13:35'))
    assert not c.matches(at('2026-10-07 11:35'))
    assert c.matches(at('2026-10-07 17:05'))


def test_invalid_expressions():
    for bad in ['', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '* * * * * *']:
        assert CronExpression.isValid(bad) is False, bad
    assert CronExpression.isValid('*/2 * * * *') is True


def test_never_firing_expression_is_invalid():
    assert CronExpression.isValid('0 0 31 2 *') is False
    assert CronExpression.isValid('0 0 29 2 *') is True   # leap day fires within 4 years
