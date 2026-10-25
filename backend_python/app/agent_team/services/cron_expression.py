"""Port of backend/src/AgentTeam/Services/CronExpression.php.

A standard 5-field cron expression (minute hour day-of-month month day-of-week), server timezone.
Fields take *, n, a-b, and /step on either, comma-separated. Day-of-week 0 and 7 are Sunday.
When both day fields are restricted, a day matches either (standard cron).

Times are naive wall-clock datetimes (PHP's DateTimeImmutable in the default timezone); PHP's
modify('+1 hour') across a DST change is not reproduced (parity: wall-clock minutes only).
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from app.exceptions.invalid_argument import InvalidArgumentException

_FIELD_ITEM = re.compile(r'^(\*|\d+(?:-\d+)?)(?:/(\d+))?$')


class CronExpression:
    RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
    # Day steps bound the search at about 164 years: enough for a leap day, bounded for never-firing input.
    MAX_STEPS = 60000

    def __init__(self, expr: str):
        parts = re.split(r'\s+', expr.strip())
        if len(parts) != 5:
            raise InvalidArgumentException('cron needs 5 fields: minute hour day-of-month month day-of-week')
        self.sets: list[set[int]] = []
        for i, p in enumerate(parts):
            self.sets.append(self._field(p, self.RANGES[i][0], self.RANGES[i][1]))
        if 7 in self.sets[4]:
            self.sets[4].add(0)
            self.sets[4].discard(7)
        self.domStar = parts[2] == '*'
        self.dowStar = parts[4] == '*'

    @classmethod
    def isValid(cls, expr) -> bool:
        try:
            cls(str(expr)).nextAfter(datetime.now())
            return True
        except (InvalidArgumentException, RuntimeError):
            return False

    @staticmethod
    def _field(f: str, lo: int, hi: int) -> set[int]:
        out: set[int] = set()
        for item in f.split(','):
            m = _FIELD_ITEM.match(item)
            if not m:
                raise InvalidArgumentException(f"bad cron field '{f}'")
            if m.group(1) == '*':
                a, b = lo, hi
            elif '-' in m.group(1):
                a, b = (int(x) for x in m.group(1).split('-'))
            else:
                a = b = int(m.group(1))
                if m.group(2) is not None:
                    b = hi   # "5/10" = from 5, every 10
            step = int(m.group(2)) if m.group(2) is not None else 1
            if a < lo or b > hi or a > b or step < 1:
                raise InvalidArgumentException(f"cron field '{f}' is out of range {lo}-{hi}")
            out.update(range(a, b + 1, step))
        return out

    def matches(self, t: datetime) -> bool:
        return self._dayMatches(t) and t.hour in self.sets[1] and t.minute in self.sets[0]

    def _dayMatches(self, t: datetime) -> bool:
        if t.month not in self.sets[3]:
            return False
        dom = t.day in self.sets[2]
        dow = (t.isoweekday() % 7) in self.sets[4]   # PHP format('w'): 0 = Sunday
        return (dom and dow) if (self.domStar or self.dowStar) else (dom or dow)

    def nextAfter(self, after: datetime) -> datetime:
        """The first minute strictly after `after` that matches."""
        t = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
        for _ in range(self.MAX_STEPS):
            if not self._dayMatches(t):
                t = t.replace(hour=0, minute=0) + timedelta(days=1)
                continue
            if t.hour not in self.sets[1]:
                t = t.replace(minute=0) + timedelta(hours=1)
                continue
            for m in range(t.minute, 60):
                if m in self.sets[0]:
                    return t.replace(minute=m)
            t = t.replace(minute=0) + timedelta(hours=1)
        raise RuntimeError('cron expression never fires')
