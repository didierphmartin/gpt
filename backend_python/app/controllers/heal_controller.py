"""Port of Controllers/HealController.php (20-206).

HealController — the server-side enforcement gate for self-healing.

The healing LOOP runs client-side (SkillOpt scripts in Pyodide), but whether
it is allowed to spend, and how much, is decided HERE so a client bug can
never bypass the user's cost controls. Reads the per-user heal settings
(users.heal_*) and a daily spend ledger (heal_spend).

  POST /api/v1/heal/authorize { skill_dir, estimate_usd } -> {allowed, mode, ...}
  POST /api/v1/heal/record    { actual_usd }              -> records spend
  GET  /api/v1/heal/status                                 -> {mode, spent_today, ...}

Spec: docs/specs/2026-06-13-self-healing-design.md §4.4

No-runtime-DDL (spec §3): PHP's `ensureSpendTable()` used to
`CREATE TABLE IF NOT EXISTS heal_spend (...)`; the live table already has
that shape (verified: user_id, day, spent_usd, kind — PRIMARY KEY includes
kind). Ported as a presence check only (§3 tracker below).
"""
from __future__ import annotations

from app.support.db_presence import DbPresence
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_floatval, php_round


class HealController:
    def __init__(self, db, config: dict | None = None):
        self.db = db
        self._spendTableEnsured = False
        self._presence = DbPresence(db, 'HealController')

    # ─── no-runtime-DDL presence checks (spec §3) ──────────────────────────
    # Tracker: heal_spend table + heal_spend.kind column — both present on the
    # live DB (verified via SHOW COLUMNS FROM heal_spend, 2026-09-07).

    def _ensureSpendTable(self) -> None:
        if self._spendTableEnsured:
            return
        self._presence.table('heal_spend')
        self._spendTableEnsured = True

    # ─── endpoints ──────────────────────────────────────────────────────────

    def authorize(self, request) -> dict:
        """Decide whether a heal may run, per mode + budget + ceiling."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        b = request['body'] if request.get('body') is not None else {}
        estimate = max(0.0, php_floatval(b['estimate_usd'] if b.get('estimate_usd') is not None else 0))
        skillDir = str(b['skill_dir']) if b.get('skill_dir') is not None else ''

        cfg = self._healConfig(userId)
        spent = self._spentToday(userId)
        remaining = max(0.0, cfg['budget'] - spent)

        base = {
            'success': True,
            'mode': cfg['mode'],
            'skill_dir': skillDir,
            'estimate_usd': php_round(estimate, 4),
            'spent_today_usd': php_round(spent, 4),
            'budget_usd': cfg['budget'],
            'remaining_usd': php_round(remaining, 4),
            'ceiling_usd': cfg['ceiling'],
        }
        return {**base, **self.decide(cfg['mode'], estimate, remaining, cfg['ceiling']), 'status_code': 200}

    def decide(self, mode: str, estimate: float, remaining: float, ceiling: float) -> dict:
        """Pure decision: given mode + estimate + remaining budget + ceiling,
        decide whether a heal may run. Extracted for testability.
        Returns {allowed: bool, requires_approval: bool, reason: str}
        """
        if mode == 'off':
            return {'allowed': False, 'requires_approval': False, 'reason': 'mode_off'}
        if estimate > remaining:
            return {'allowed': False, 'requires_approval': False, 'reason': 'over_budget'}
        if mode == 'ask':
            # Allowed, but the client must show the approval overlay first.
            return {'allowed': True, 'requires_approval': True, 'reason': 'ask'}
        # auto: must also be under the per-heal ceiling.
        if estimate > ceiling:
            return {'allowed': False, 'requires_approval': True, 'reason': 'over_ceiling'}
        return {'allowed': True, 'requires_approval': False, 'reason': 'auto'}

    def record(self, request) -> dict:
        """Record actual heal spend against today's ledger."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        b = request['body'] if request.get('body') is not None else {}
        actual = max(0.0, php_floatval(b['actual_usd'] if b.get('actual_usd') is not None else 0))
        self._ensureSpendTable()
        try:
            # kind-scoped when the column exists (added by GenesisController);
            # fall back to the legacy shape on installs that pre-date it. (Ported
            # as a presence check per spec §3 rather than PHP's PDOException
            # probe-and-fallback — same net behaviour, testable without faking
            # a DB error.)
            if self._presence.column('heal_spend', 'kind'):
                self.db.execute(
                    "INSERT INTO heal_spend (user_id, day, kind, spent_usd) VALUES (:u, CURDATE(), 'heal', :s)"
                    " ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2",
                    {':u': userId, ':s': actual, ':s2': actual},
                )
            else:
                self.db.execute(
                    "INSERT INTO heal_spend (user_id, day, spent_usd) VALUES (:u, CURDATE(), :s)"
                    " ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2",
                    {':u': userId, ':s': actual, ':s2': actual},
                )
        except Exception as e:  # noqa: BLE001
            error_log('[HealController] record failed: ' + str(e))
            return {'success': False, 'error': 'record failed', 'status_code': 500}
        return {'success': True, 'spent_today_usd': php_round(self._spentToday(userId), 4), 'status_code': 200}

    def status(self, request) -> dict:
        """Current mode + today's spend, for the UI."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        cfg = self._healConfig(userId)
        spent = self._spentToday(userId)
        return {
            'success': True,
            'mode': cfg['mode'],
            'budget_usd': cfg['budget'],
            'ceiling_usd': cfg['ceiling'],
            'spent_today_usd': php_round(spent, 4),
            'remaining_usd': php_round(max(0.0, cfg['budget'] - spent), 4),
            'status_code': 200,
        }

    # ─── internals ──────────────────────────────────────────────────────────

    def _healConfig(self, userId) -> dict:
        """Read this user's heal mode/budget/ceiling (defaults if columns absent)."""
        out = {'mode': 'off', 'budget': 5.0, 'ceiling': 1.0}
        try:
            row = self.db.fetch_one(
                'SELECT heal_mode, heal_daily_budget_usd, heal_per_heal_ceiling_usd FROM users WHERE id = ?',
                [userId],
            )
            if row:
                if row.get('heal_mode') in ('off', 'ask', 'auto'):
                    out['mode'] = row['heal_mode']
                if row.get('heal_daily_budget_usd') is not None:
                    out['budget'] = php_floatval(row['heal_daily_budget_usd'])
                if row.get('heal_per_heal_ceiling_usd') is not None:
                    out['ceiling'] = php_floatval(row['heal_per_heal_ceiling_usd'])
        except Exception:  # noqa: BLE001 — columns may not exist yet -> defaults
            pass
        return out

    def _spentToday(self, userId) -> float:
        self._ensureSpendTable()
        try:
            if self._presence.column('heal_spend', 'kind'):
                vals = self.db.fetch_column(
                    "SELECT spent_usd FROM heal_spend WHERE user_id = ? AND day = CURDATE() AND kind = 'heal'",
                    [userId],
                )
            else:
                vals = self.db.fetch_column(
                    'SELECT spent_usd FROM heal_spend WHERE user_id = ? AND day = CURDATE()',
                    [userId],
                )
            return php_floatval(vals[0]) if vals else 0.0
        except Exception:  # noqa: BLE001
            return 0.0
