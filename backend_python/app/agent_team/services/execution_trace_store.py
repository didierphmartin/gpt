"""Port of AgentTeam/Services/ExecutionTraceStore.php.

ExecutionTraceStore — Phase 0 of the self-healing design.

Captures ONE structured, classified, outcome-labelled record per skill/agent
execution (a workflow node, or a chat skill invocation). This is the shared
substrate the three healers read (skill / workflow / foundation). No healing,
no LLM calls — capture + deterministic classification only.

Spec: docs/specs/2026-06-13-phase0-trace-store.md
      docs/specs/2026-06-13-self-healing-design.md (§3, §4.1-4.2, §6)

Ruling (2026-09-07 Phase 2d): `ensureTable()` performs NO runtime DDL here —
the `execution_traces` table already exists in the live DB. The PHP DDL is
kept below as a docstring note only, for reference:

    CREATE TABLE IF NOT EXISTS `execution_traces` (
      `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      `run_id` VARCHAR(40) NOT NULL DEFAULT '',
      `ts` DATETIME NOT NULL,
      `env` VARCHAR(16) NOT NULL DEFAULT 'workflow',
      `invocation_mode` VARCHAR(20) NOT NULL DEFAULT 'workflow_node',
      `workflow_id` INT DEFAULT NULL,
      `node_id` INT DEFAULT NULL,
      `provider` VARCHAR(40) DEFAULT NULL,
      `skill_dir` VARCHAR(255) DEFAULT NULL,
      `success` TINYINT(1) NOT NULL DEFAULT 0,
      `error_class` VARCHAR(32) NOT NULL DEFAULT 'ok',
      `error_text` TEXT DEFAULT NULL,
      `outcome_quality` VARCHAR(16) NOT NULL DEFAULT 'unknown',
      `tokens_in` INT NOT NULL DEFAULT 0,
      `tokens_out` INT NOT NULL DEFAULT 0,
      `cost_usd` DECIMAL(12,6) DEFAULT NULL,
      `user_action` VARCHAR(12) NOT NULL DEFAULT 'none',
      `payload` LONGTEXT DEFAULT NULL,
      `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_skill_dir` (`skill_dir`),
      KEY `idx_workflow` (`workflow_id`, `node_id`),
      KEY `idx_error_class` (`error_class`),
      KEY `idx_run` (`run_id`),
      KEY `idx_ts` (`ts`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""
from __future__ import annotations

import re

from app.exceptions import PricingUnavailableException
from app.services.pricing_resolver import PricingResolver
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval
from app.support import phpjson

_RE_TRANSIENT = re.compile(
    r'\b(429|503|500|overloaded|rate.?limit|service unavailable|quota exceeded|temporarily|try again)\b')
_RE_FOUNDATION = re.compile(
    r'not registered|undefined variable|provider .* not found|thought_signature|reasoning_content'
    r'|must be passed back|unsupported|fatal error|call to undefined|\.php on line')
_RE_APOLOGY = re.compile(
    r"\b(i'?m unable|i am unable|i cannot|i can'?t|apolog|not available in (my|this))")


def _strtolower(v) -> str:
    """strtolower((string) $v) — coerce then lowercase, PHP-style."""
    if v is None:
        return ''
    if isinstance(v, bool):
        return ('1' if v else '').lower()
    return str(v).lower()


class ExecutionTraceStore:
    def __init__(self, db):
        self.db = db
        self._tableEnsured = False
        # provider => (priceIn, priceOut) per 1M
        self._pricingCache: dict[str, tuple] = {}

    def ensureTable(self) -> None:
        """Idempotently check the traces table exists (cached per instance).
        No runtime DDL — ruled 2026-09-07: the table exists in the live DB.
        """
        if self._tableEnsured:
            return
        try:
            rows = self.db.fetch_all("SHOW TABLES LIKE 'execution_traces'")
            if php_empty(rows):
                error_log('[ExecutionTraceStore] execution_traces missing — '
                           'create it with backend/… (PHP creates it on demand)')
        except Exception as e:  # noqa: BLE001
            error_log('[ExecutionTraceStore] ensureTable failed: ' + str(e))
        self._tableEnsured = True

    def insert(self, t: dict) -> int | None:
        """Classify + label a trace and insert it. Tolerant of missing keys.
        Returns the inserted id, or None on failure (never throws — tracing
        must not break a workflow run).
        """
        try:
            self.ensureTable()

            # Classify on the FULL record (these signals live in $t and the
            # payload, not in their own columns).
            t = dict(t)
            t['error_class'] = self.classify(t)
            t['outcome_quality'] = self.outcomeQuality(t, t['error_class'])

            # Queryable columns (NOT user_action — its DEFAULT 'none' applies;
            # it is backfilled later via setUserAction()).
            kept = [
                'run_id', 'ts', 'env', 'invocation_mode', 'workflow_id', 'node_id',
                'provider', 'skill_dir', 'success', 'error_class', 'error_text',
                'outcome_quality', 'tokens_in', 'tokens_out', 'cost_usd',
            ]
            # Everything bulky folds into one JSON blob.
            payload = {
                'model': t.get('model'),
                'latency_ms': t.get('latency_ms'),
                'script': t.get('script'),
                'argv': t.get('argv') if t.get('argv') is not None else [],
                'input_snapshot': t.get('input_snapshot'),
                'tool_calls': t.get('tool_calls') if t.get('tool_calls') is not None else [],
                'skill_exit_code': t.get('skill_exit_code'),
                'skill_stdout': t.get('skill_stdout'),
                'skill_log_messages': t.get('skill_log_messages'),
                'output_files': t.get('output_files') if t.get('output_files') is not None else [],
                'final_text': t.get('final_text'),
                'rounds': t.get('rounds'),
                'round_limit_hit': not php_empty(t.get('round_limit_hit')),
                'loop_detected': not php_empty(t.get('loop_detected')),
            }

            cols = kept + ['payload']
            placeholders = ', '.join(':' + c for c in cols)
            sql = 'INSERT INTO `execution_traces` (`' + '`, `'.join(cols) + '`) VALUES (' + placeholders + ')'

            params = {}
            for c in kept:
                params[':' + c] = self._coerce(c, t.get(c))
            params[':payload'] = phpjson.dumps(payload)

            return self.db.insert(sql, params)
        except Exception as e:  # noqa: BLE001
            error_log('[ExecutionTraceStore] insert failed: ' + str(e))
            return None

    def setUserAction(self, runId: str, action: str, nodeId: int | None = None) -> None:
        """Backfill a user action (accept|retry|abort) onto a run's traces."""
        try:
            self.ensureTable()
            sql = 'UPDATE `execution_traces` SET `user_action` = :a WHERE `run_id` = :r'
            params = {':a': action, ':r': runId}
            if nodeId is not None:
                sql += ' AND `node_id` = :n'
                params[':n'] = nodeId
            self.db.execute(sql, params)
        except Exception as e:  # noqa: BLE001
            error_log('[ExecutionTraceStore] setUserAction failed: ' + str(e))

    # ─── Deterministic classifier (no LLM) ──────────────────────────────────

    def classify(self, t: dict) -> str:
        """Assign error_class. First match wins. See spec §4.1."""
        err = _strtolower(t.get('error_text') if t.get('error_text') is not None else '')
        logs = _strtolower(t.get('skill_log_messages') if t.get('skill_log_messages') is not None else '')
        body = _strtolower((t.get('final_text') if t.get('final_text') is not None else '')
                            + ' ' + (t.get('skill_stdout') if t.get('skill_stdout') is not None else ''))
        success = not php_empty(t.get('success'))
        exit_ = t.get('skill_exit_code')
        argv = t.get('argv')
        argv_str = argv if isinstance(argv, str) else phpjson.dumps(argv if argv is not None else [])
        argv_lower = _strtolower(argv_str)

        # e — transient / external (provider outage, rate limit)
        if _RE_TRANSIENT.search(err):
            return 'e_transient_external'
        # d — foundation / plumbing bug (NOT fixable by a skill edit)
        if _RE_FOUNDATION.search(err):
            return 'd_foundation_code'
        # b — skill script error
        if (exit_ is not None and php_intval(exit_) != 0) or 'traceback (most recent call last)' in logs:
            return 'b_skill_script'
        # a — skill-prompt weakness: ran "successfully" but misbehaved
        helpProbe = ('"-h"' in argv_lower) or ('"--help"' in argv_lower)
        apology = bool(_RE_APOLOGY.search(body))
        if success and (not php_empty(t.get('loop_detected')) or not php_empty(t.get('round_limit_hit'))
                        or helpProbe or apology):
            return 'a_skill_prompt'
        # c — workflow-config: failed inside a workflow node, not obviously a/b/d/e
        if not success and (t.get('env') if t.get('env') is not None else '') == 'workflow':
            return 'c_workflow_config'
        if not success:
            return 'a_skill_prompt'
        return 'ok'

    def outcomeQuality(self, t: dict, cls: str | None = None) -> str:
        """Derive outcome_quality from free signals only. See spec §4.2."""
        success = not php_empty(t.get('success'))
        if not success:
            return 'failed'
        loop = not php_empty(t.get('loop_detected')) or not php_empty(t.get('round_limit_hit'))
        body = _strtolower((t.get('final_text') if t.get('final_text') is not None else '')
                            + ' ' + (t.get('skill_stdout') if t.get('skill_stdout') is not None else ''))
        apology = bool(_RE_APOLOGY.search(body))
        if loop or apology or cls == 'a_skill_prompt':
            return 'degraded'
        exit_ = t.get('skill_exit_code')
        if exit_ is None or php_intval(exit_) == 0:
            return 'good'
        return 'unknown'

    # ─── Read surface (Phase 0 = queries only) ──────────────────────────────

    def skillWeaknesses(self, skillDir: str, sinceDays: int = 30) -> list:
        """Skill reader: recurring degraded/failed runs for a skill, grouped."""
        return self._query(
            "SELECT error_class, invocation_mode, provider, COUNT(*) AS n "
            "FROM execution_traces "
            "WHERE skill_dir = :d AND outcome_quality IN ('degraded','failed') "
            "  AND ts >= (NOW() - INTERVAL :days DAY) "
            "GROUP BY error_class, invocation_mode, provider "
            "ORDER BY n DESC",
            {':d': skillDir, ':days': sinceDays}
        )

    def workflowTrace(self, workflowId: int, runId: str | None = None) -> list:
        """Workflow reader: per-node trace of one run (credit assignment)."""
        sql = ("SELECT node_id, provider, skill_dir, success, outcome_quality, error_class, "
               "       error_text, tokens_in, tokens_out, cost_usd "
               "FROM execution_traces WHERE workflow_id = :w")
        params = {':w': workflowId}
        if runId is not None:
            sql += ' AND run_id = :r'
            params[':r'] = runId
        sql += ' ORDER BY node_id'
        return self._query(sql, params)

    def foundationBugs(self, sinceDays: int = 30) -> list:
        """Foundation reader: recurring class-d bugs, ranked by frequency."""
        return self._query(
            "SELECT provider, LEFT(error_text, 120) AS signature, COUNT(*) AS n "
            "FROM execution_traces "
            "WHERE error_class = 'd_foundation_code' "
            "  AND ts >= (NOW() - INTERVAL :days DAY) "
            "GROUP BY provider, signature "
            "ORDER BY n DESC",
            {':days': sinceDays}
        )

    # ─── Diagnosis layer (read-only, no LLM) — design §4 ────────────────────

    def diagnose(self, sinceDays: int = 30) -> dict:
        """Turn raw traces into an actionable diagnosis: per skill that has any
        degraded/failed runs, a verdict (which layer/loop should fix it) using
        the invocation-mode ablation, plus a heal-cost estimate for the
        skill-text cases. This is what the approval overlay and the miner read.
        """
        rows = self._query(
            "SELECT skill_dir, invocation_mode, error_class, outcome_quality, provider, COUNT(*) AS n "
            "FROM execution_traces "
            "WHERE skill_dir IS NOT NULL AND skill_dir <> '' "
            "  AND ts >= (NOW() - INTERVAL :d DAY) "
            "GROUP BY skill_dir, invocation_mode, error_class, outcome_quality, provider",
            {':d': sinceDays}
        )

        skills: dict = {}
        for r in rows:
            sd = r['skill_dir']
            if sd not in skills:
                skills[sd] = {'skill_dir': sd, 'total': 0, 'bad': 0,
                               'by_mode': {}, 'by_class': {}, 'providers': {}}
            n = php_intval(r['n'])
            bad = r['outcome_quality'] in ('degraded', 'failed')
            skills[sd]['total'] += n
            mode = r['invocation_mode'] if not php_empty(r['invocation_mode']) else 'unknown'
            if mode not in skills[sd]['by_mode']:
                skills[sd]['by_mode'][mode] = {'total': 0, 'bad': 0}
            skills[sd]['by_mode'][mode]['total'] += n
            if bad:
                skills[sd]['bad'] += n
                skills[sd]['by_mode'][mode]['bad'] += n
                skills[sd]['by_class'][r['error_class']] = skills[sd]['by_class'].get(r['error_class'], 0) + n
                prov = r['provider'] if not php_empty(r['provider']) else 'unknown'
                skills[sd]['providers'][prov] = skills[sd]['providers'].get(prov, 0) + n

        out = []
        for s in skills.values():
            if s['bad'] == 0:
                continue  # only report skills with problems
            verdict = self._verdict(s)
            rec = self._recommend(verdict)
            s['verdict'] = verdict
            s['recommended'] = rec
            if verdict in ('skill_description', 'skill_body'):
                provs = list(s['providers'].keys()) or ['claude']
                s['estimate'] = self.estimateHealCost(provs)
            out.append(s)
        out.sort(key=lambda s: s['bad'], reverse=True)

        return {
            'window_days': sinceDays,
            'skills': out,
            'foundation_bugs': self.foundationBugs(sinceDays),
        }

    def _verdict(self, s: dict) -> str:
        """Decide which layer/loop should fix a skill, using class + the ablation."""
        cls = s['by_class']
        if cls:
            top = max(cls, key=lambda k: cls[k])
        else:
            top = 'a_skill_prompt'
        if top == 'e_transient_external':
            return 'transient_external'
        if top == 'd_foundation_code':
            return 'foundation_code'
        if top == 'b_skill_script':
            return 'skill_script'
        if top == 'c_workflow_config':
            return 'workflow_config'

        # a_skill_prompt: use the invocation-mode ablation to split
        # description (selection) faults from body (execution) faults.
        def rate(m):
            return (m['bad'] / m['total']) if (m and m['total'] > 0) else None

        ra = rate(s['by_mode'].get('auto_discovery'))
        rf = rate(s['by_mode'].get('forced'))
        rw = rate(s['by_mode'].get('workflow_node'))
        # Bad when discovered, but fine when explicitly selected → description.
        if ra is not None and ra > 0.3 and ((rf is not None and rf < 0.2) or (rw is not None and rw < 0.2)):
            return 'skill_description'
        return 'skill_body'

    def _recommend(self, verdict: str) -> dict:
        """Map a verdict to a layer + loop + human action."""
        table = {
            'skill_description': {'layer': 'skill', 'loop': 'run_loop',
                                   'action': 'Optimize the skill DESCRIPTION (it is being mis-discovered).'},
            'skill_body': {'layer': 'skill', 'loop': 'run_body_loop',
                           'action': 'Optimize the skill BODY (it runs but misbehaves).'},
            'skill_script': {'layer': 'skill', 'loop': None,
                              'action': 'Fix the Python script (code, but isolated to the skill).'},
            'workflow_config': {'layer': 'workflow', 'loop': None,
                                 'action': 'Adjust workflow node config (provider / topology / forcing).'},
            'foundation_code': {'layer': 'foundation', 'loop': None,
                                 'action': 'File a PR — runtime/plumbing bug, NOT auto-healable.'},
            'transient_external': {'layer': 'none', 'loop': None,
                                    'action': 'Retry/backoff — external outage, nothing to fix.'},
        }
        return table.get(verdict, {'layer': 'skill', 'loop': 'run_body_loop',
                                    'action': 'Optimize the skill body.'})

    # ─── Cost estimate (for the future approval overlay, design §4.4) ───────

    def estimateHealCost(
        self,
        providers: list,
        Q: int = 10,
        R: int = 3,
        I: int = 3,  # noqa: E741 - mirrors PHP param name
        evalProvider: str = 'kimi',
        proposerProvider: str = 'claude',
        avgEvalTokens: int = 4000,
        avgProposerTokens: int = 9000,
    ) -> dict:
        """Forecast the token + USD cost of a heal loop. Pure function.
        calls = Q*R*2*(1+I) + I ; eval calls priced on the (cheap) eval model,
        the I proposer calls on the (strong) proposer model.

        providers: providers the loop will optimize (loop runs per provider)
        """
        nProv = max(1, len(providers))
        proposerCalls = I * nProv
        evalCalls = (Q * R * 2 * (1 + I)) * nProv
        totalCalls = evalCalls + proposerCalls

        evalTokens = evalCalls * avgEvalTokens
        proposerTokens = proposerCalls * avgProposerTokens
        tokens = evalTokens + proposerTokens

        # ~80% input / 20% output blend.
        usd = self._blendedCost(evalProvider, evalTokens) + self._blendedCost(proposerProvider, proposerTokens)

        return {
            'calls': totalCalls,
            'tokens': tokens,
            'usd': round(usd, 4),
            'usd_range': [round(usd * 0.7, 4), round(usd * 1.4, 4)],
            'assumptions': {
                'providers': providers, 'Q': Q, 'R': R, 'I': I,
                'evalProvider': evalProvider, 'proposerProvider': proposerProvider,
            },
        }

    def _blendedCost(self, provider: str, tokens: int) -> float:
        pin, pout = self._pricing(provider)
        pin = pin if pin is not None else 0.0
        pout = pout if pout is not None else 0.0
        return (0.8 * tokens * pin + 0.2 * tokens * pout) / 1_000_000

    def _pricing(self, provider: str) -> tuple:
        """Per-1M [in,out] USD via PricingResolver (single source of truth).
        (None, None) when pricing is unavailable — never a hardcoded number,
        never a throw. Mirrors GraphWorkflowRunner::getProviderPricing.
        """
        provider = provider.lower()
        key = {'anthropic': 'claude', 'google': 'gemini'}.get(provider, provider)
        if key in self._pricingCache:
            return self._pricingCache[key]
        try:
            resolver = PricingResolver(self.db)
            in_, out_ = resolver.resolve(key)
        except PricingUnavailableException:
            in_, out_ = None, None
        self._pricingCache[key] = (in_, out_)
        return (in_, out_)

    # ─── helpers ────────────────────────────────────────────────────────────

    def _query(self, sql: str, params: dict) -> list:
        try:
            self.ensureTable()
            rows = self.db.fetch_all(sql, params)
            return rows if rows else []
        except Exception as e:  # noqa: BLE001
            error_log('[ExecutionTraceStore] query failed: ' + str(e))
            return []

    def _coerce(self, col: str, v):
        """Coerce a kept-column value to a DB-storable scalar."""
        if col == 'success':
            return 1 if not php_empty(v) else 0
        if isinstance(v, (list, dict)):
            return phpjson.dumps(v)
        return v
