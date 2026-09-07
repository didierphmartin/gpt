"""Port of Controllers/GenesisController.php (20-507).

GenesisController — server-side enforcement gate + promotion store for
skill genesis (spec: docs/specs/2026-07-14-skill-genesis-design.md §6-7).

Mirrors HealController's philosophy: the build LOOP runs client-side
(skill folder written via the browser's local-FS handle; optional SkillOpt
hardening in Pyodide), but whether it may SPEND, and how much, is decided
here. Ledger: heal_spend with kind='genesis' (heal rows default 'heal').

No-runtime-DDL (spec §3): PHP's `ensureTables()` used to
`CREATE TABLE IF NOT EXISTS skill_promotions`, `CREATE TABLE IF NOT EXISTS
heal_spend`, and probe-then-`ALTER TABLE heal_spend ADD COLUMN kind ...`.
The live DB already has both tables with every column these controllers read
(verified: skill_promotions has all 13 columns; heal_spend has user_id, day,
spent_usd, kind with PK (user_id, day, kind) — 2026-09-07). Ported as
presence checks only (tracker in `ensureTables`).
"""
from __future__ import annotations

import json
import re

from app.support.logger import error_log
from app.support.phpcompat import mb_substr, php_array, php_empty, php_floatval, php_intval, php_trim
from app.support.phpjson import php_json_encode


def _is_php_array(v) -> bool:
    return isinstance(v, (list, dict))


class GenesisController:
    def __init__(self, db, config: dict | None = None):
        self.db = db
        self.config = config or {}
        self._tablesEnsured = False
        self._presence: dict[str, bool] = {}

    # ─── pure decision (precedent: HealController.decide) ──────────────────

    def decide(self, mode: str, estimate: float, remaining: float, ceiling: float,
               bornThisWeek: int, weeklyMax: int, approved: bool) -> dict:
        """Pure decision: may this promotion build run? Extracted for testability.
        Returns {allowed: bool, requires_approval: bool, reason: str}
        """
        if mode == 'off':
            return {'allowed': False, 'requires_approval': False, 'reason': 'mode_off'}
        if mode == 'suggest':
            return {'allowed': False, 'requires_approval': False, 'reason': 'suggest_only'}
        if estimate > remaining:
            return {'allowed': False, 'requires_approval': False, 'reason': 'over_budget'}
        if bornThisWeek >= weeklyMax:
            return {'allowed': False, 'requires_approval': False, 'reason': 'weekly_throttle'}
        if mode == 'ask':
            if approved:
                return {'allowed': True, 'requires_approval': False, 'reason': 'ask_approved'}
            return {'allowed': False, 'requires_approval': True, 'reason': 'ask'}
        # auto: must also clear the per-skill ceiling.
        if estimate > ceiling:
            return {'allowed': False, 'requires_approval': True, 'reason': 'over_ceiling'}
        return {'allowed': True, 'requires_approval': False, 'reason': 'auto'}

    # ─── no-runtime-DDL presence checks (spec §3) ──────────────────────────

    def _tableExists(self, table: str) -> bool:
        cache_key = 't:' + table
        if cache_key not in self._presence:
            self._presence[cache_key] = len(self.db.fetch_all(f"SHOW TABLES LIKE '{table}'")) > 0
        return self._presence[cache_key]

    def _columnExists(self, table: str, column: str) -> bool:
        cache_key = f'c:{table}.{column}'
        if cache_key not in self._presence:
            try:
                rows = self.db.fetch_all(f"SHOW COLUMNS FROM `{table}` LIKE '{column}'")
            except Exception:  # noqa: BLE001 — missing table => missing column
                rows = []
            self._presence[cache_key] = len(rows) > 0
        return self._presence[cache_key]

    def ensureTables(self) -> None:
        if self._tablesEnsured or self.db is None:
            return
        if not self._tableExists('skill_promotions'):
            error_log('[GenesisController] skill_promotions missing — PHP creates it on demand')
        if not self._tableExists('heal_spend'):
            error_log('[GenesisController] heal_spend missing — PHP creates it on demand')
        elif not self._columnExists('heal_spend', 'kind'):
            error_log('[GenesisController] heal_spend.kind missing — PHP creates it on demand')
        self._tablesEnsured = True

    # ─── endpoints ───────────────────────────────────────────────────────────

    def listPromotions(self, request) -> dict:
        """GET /api/v1/genesis/promotions?status=proposed"""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        self.ensureTables()
        q = request['query'] if request.get('query') is not None else {}
        status = str(q['status']) if q.get('status') is not None else ''
        sql = 'SELECT * FROM skill_promotions WHERE user_id = :u'
        params = {':u': userId}
        if status != '':
            sql += ' AND status = :s'
            params[':s'] = status
        sql += ' ORDER BY created_at DESC LIMIT 100'
        rows = self.db.fetch_all(sql, params)
        for r in rows:
            try:
                decoded = json.loads(r['eval_queries']) if r.get('eval_queries') else None
            except Exception:  # noqa: BLE001
                decoded = None
            r['eval_queries'] = decoded if decoded else []

            if r.get('parameter_schema') is not None:
                try:
                    decodedPs = json.loads(r['parameter_schema'])
                except Exception:  # noqa: BLE001
                    decodedPs = None
                r['parameter_schema'] = decodedPs if decodedPs else None
            else:
                r['parameter_schema'] = None
        return {'success': True, 'promotions': rows, 'status_code': 200}

    def authorize(self, request) -> dict:
        """POST /api/v1/genesis/authorize {promotion_id, estimate_usd, approved?}"""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        self.ensureTables()
        b = request['body'] if request.get('body') is not None else {}
        promotionId = php_intval(b['promotion_id'] if b.get('promotion_id') is not None else 0)
        estimate = max(0.0, php_floatval(b['estimate_usd'] if b.get('estimate_usd') is not None else 0))
        approved = not php_empty(b.get('approved'))

        if not self._promotionBelongsToUser(promotionId, userId):
            return {'success': False, 'error': 'Promotion not found', 'status_code': 404}

        vals = self.db.fetch_column('SELECT status FROM skill_promotions WHERE id = ? AND user_id = ?',
                                     [promotionId, userId])
        currentStatus = str(vals[0]) if vals and vals[0] is not None else ''
        if currentStatus not in ('proposed', 'approved'):
            return {'success': False, 'error': 'Promotion already decided', 'status_code': 409}

        cfg = self._genesisConfig(userId)
        spent = self._spentToday(userId)
        remaining = max(0.0, cfg['budget'] - spent)
        born = self._bornThisWeek(userId)

        decision = self.decide(cfg['mode'], estimate, remaining, cfg['ceiling'], born, cfg['weekly_max'], approved)

        if decision['allowed']:
            self.db.execute("UPDATE skill_promotions SET status = 'approved' WHERE id = ? AND user_id = ?",
                             [promotionId, userId])

        return {
            'success': True,
            'mode': cfg['mode'],
            'estimate_usd': round(estimate, 4),
            'spent_today_usd': round(spent, 4),
            'budget_usd': cfg['budget'],
            'remaining_usd': round(remaining, 4),
            'ceiling_usd': cfg['ceiling'],
            'born_this_week': born,
            'weekly_max': cfg['weekly_max'],
            **decision,
            'status_code': 200,
        }

    def record(self, request) -> dict:
        """POST /api/v1/genesis/record {promotion_id, actual_usd, outcome, skill_dir?}"""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        self.ensureTables()
        b = request['body'] if request.get('body') is not None else {}
        promotionId = php_intval(b['promotion_id'] if b.get('promotion_id') is not None else 0)
        actual = max(0.0, php_floatval(b['actual_usd'] if b.get('actual_usd') is not None else 0))
        outcome = b['outcome'] if b.get('outcome') in ('born', 'failed', 'merged') else 'failed'
        skillDir = str(b['skill_dir']) if b.get('skill_dir') is not None else None

        if not self._promotionBelongsToUser(promotionId, userId):
            return {'success': False, 'error': 'Promotion not found', 'status_code': 404}

        try:
            self.db.begin()
            self.db.execute(
                'UPDATE skill_promotions'
                ' SET status = :st, born_skill_dir = :dir, decided_at = NOW()'
                ' WHERE id = :id AND user_id = :u',
                {':st': outcome, ':dir': skillDir if outcome == 'born' else None,
                 ':id': promotionId, ':u': userId},
            )
            self.db.execute(
                "INSERT INTO heal_spend (user_id, day, kind, spent_usd) VALUES (:u, CURDATE(), 'genesis', :s)"
                ' ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2',
                {':u': userId, ':s': actual, ':s2': actual},
            )
            self.db.commit()
        except Exception as e:  # noqa: BLE001
            try:
                self.db.rollback()
            except Exception:  # noqa: BLE001
                pass
            error_log('[GenesisController] record failed: ' + str(e))
            return {'success': False, 'error': 'record failed', 'status_code': 500}
        return {'success': True, 'spent_today_usd': round(self._spentToday(userId), 4), 'status_code': 200}

    def dismiss(self, request, id: int) -> dict:
        """POST /api/v1/genesis/promotions/{id}/dismiss"""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        self.ensureTables()
        n = self.db.execute(
            "UPDATE skill_promotions SET status = 'dismissed', decided_at = NOW()"
            ' WHERE id = ? AND user_id = ?',
            [id, userId],
        )
        if n == 0:
            return {'success': False, 'error': 'Promotion not found', 'status_code': 404}
        return {'success': True, 'status_code': 200}

    def createProposal(self, request) -> dict:
        """POST /api/v1/genesis/proposals
        {source:'conversation'|'workflow'|'prompt', context_id?|workflow_id?|prompt_id?, catalog?:[{name,description}]}
        Runs ONE reflection LLM call (via ChatController.agent so provider
        settings/keys/quota apply) and stores the proposal as a promotion row.
        """
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        self.ensureTables()
        b = request['body'] if request.get('body') is not None else {}
        source = str(b['source']) if b.get('source') is not None else ''
        catalog = b['catalog'] if isinstance(b.get('catalog'), (list, dict)) else []

        proposal = None
        prompt = None
        class_ = None
        sourceRef = None

        if source == 'conversation':
            contextId = php_intval(b['context_id'] if b.get('context_id') is not None else 0)
            vals = self.db.fetch_column(
                'SELECT context_data FROM conversation_contexts WHERE id = ? AND user_id = ?',
                [contextId, userId],
            )
            if not vals:
                return {'success': False, 'error': 'Context not found', 'status_code': 404}
            ctxRaw = vals[0]
            s = ctxRaw if isinstance(ctxRaw, str) else ('' if ctxRaw is None else str(ctxRaw))
            try:
                decoded = json.loads(s) if s != '' else None
            except Exception:  # noqa: BLE001
                decoded = None
            data = decoded if decoded else {}
            msgsField = data.get('messages') if isinstance(data, dict) else None
            messages = msgsField if _is_php_array(msgsField) else (data if _is_php_array(data) else [])
            if php_empty(messages):
                return {'success': False, 'error': 'Context has no messages', 'status_code': 400}
            from app.services.genesis_proposer import GenesisProposer
            prompt = GenesisProposer.buildConversationPrompt(messages, catalog)
            class_ = 1
            sourceRef = f'context:{contextId}'

        elif source == 'workflow':
            workflowId = php_intval(b['workflow_id'] if b.get('workflow_id') is not None else 0)
            wf = self.db.fetch_one('SELECT id, name, description, steps FROM agent_workflows WHERE id = ? AND user_id = ?',
                                    [workflowId, userId])
            if not wf:
                return {'success': False, 'error': 'Workflow not found', 'status_code': 404}
            # Editor-built workflows always persist steps = [] — the real graph lives in
            # workflow_nodes (AgentTeam/Services/WorkflowGraphRepository.php). Ownership was
            # already checked on the agent_workflows row above; workflow_nodes has no user_id
            # column of its own, so we scope by the already-verified workflow_id only.
            nodeRows = self.db.fetch_all('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id', [workflowId])
            nodes = []
            for row in nodeRows:
                cfgDecoded = {}
                if not php_empty(row.get('config')):
                    try:
                        d = json.loads(row['config'])
                    except Exception:  # noqa: BLE001
                        d = None
                    if isinstance(d, (dict, list)):
                        cfgDecoded = d
                node = {'type': row['node_type'] if row.get('node_type') is not None else 'agent'}
                cget = cfgDecoded.get if isinstance(cfgDecoded, dict) else (lambda *_: None)
                name = cget('agent_name')
                if name is None:
                    name = cget('name')
                if name is None:
                    name = cget('title')
                if isinstance(name, str) and name != '':
                    node['name'] = name
                nodes.append(node)
            wf['nodes'] = nodes

            # Manual on-ramp = an explicit user decision, and the workflow's
            # structure is already fully declared (name, description, nodes).
            # Nothing here needs LLM judgment — build the proposal
            # DETERMINISTICALLY: instant, free, and immune to reflection
            # failures. The LLM reflection below stays only for sources that
            # require extraction from unstructured text (conversation, prompt).
            agentNames = []
            for n in nodes:
                if n.get('type') == 'agent' and not php_empty(n.get('name')):
                    agentNames.append(n['name'])
            wfNameRaw = php_trim(wf.get('name'))
            wfName = wfNameRaw if wfNameRaw != '' else f'workflow {workflowId}'
            name = wfName.lower()
            name = re.sub(r'[^a-z0-9]+', '-', name)
            name = re.sub(r'-+', '-', name).strip('-')
            name = (name if name != '' else f'workflow-{workflowId}')[:60]
            wfDescr = php_trim(wf.get('description'))
            if wfDescr != '':
                descr = wfDescr
            else:
                namesPart = (': ' + ', '.join(agentNames[:8])) if agentNames else ''
                descr = f"Runs the '{wfName}' agent workflow ({len(agentNames)} agents{namesPart}) on a user-supplied prompt."
            proposal = {
                'skill_name': name,
                'description': mb_substr(descr, 0, 500),
                'eval_queries': [],
                'parameter_schema': None,
                'merge_target': None,
                'rationale': 'Manual workflow promotion — structure is explicit, no reflection needed.',
                'is_merge': False,
            }
            class_ = 2
            sourceRef = f'workflow:{workflowId}'

        elif source == 'prompt':
            promptId = php_intval(b['prompt_id'] if b.get('prompt_id') is not None else 0)
            row = self.db.fetch_one(
                "SELECT id, name, content FROM prompt_library WHERE id = ? AND user_id = ? AND type = 'prompt'",
                [promptId, userId],
            )
            if not row:
                return {'success': False, 'error': 'Prompt not found', 'status_code': 404}
            content = str(row['content']) if row.get('content') is not None else ''
            if php_trim(content) == '':
                return {'success': False, 'error': 'Prompt has no content', 'status_code': 400}
            from app.services.genesis_proposer import GenesisProposer
            prompt = GenesisProposer.buildPromptLibraryPrompt(str(row['name']), content, catalog)
            class_ = 1
            sourceRef = f'prompt:{promptId}'

        else:
            return {'success': False, 'error': "source must be 'conversation', 'workflow' or 'prompt'",
                    'status_code': 400}

        # One-shot LLM reflection — only for sources whose procedure must be
        # EXTRACTED from unstructured text (conversation, prompt-library).
        # Workflow promotions arrive here with `proposal` already built.
        if proposal is None:
            from app.controllers.chat_controller import ChatController
            from app.services.genesis_proposer import GenesisProposer
            cfg = self._genesisConfig(userId)
            chat = ChatController(self.db, self.config)
            resp = chat.agent({
                'user_id': userId,
                'body': {'prompt': prompt, 'provider': cfg['provider'], 'user_id': userId},
            })
            if php_empty(resp.get('success')):
                return {'success': False,
                        'error': 'Reflection call failed: ' + str(resp['error'] if resp.get('error') is not None else 'unknown'),
                        'status_code': 502}
            text = resp['response'] if resp.get('response') is not None else (resp['text'] if resp.get('text') is not None else '')
            text = str(text)
            proposal = GenesisProposer.parseProposal(text)
            if proposal is None:
                return {'success': True, 'promotion': None,
                        'message': 'No repeatable procedure found in this material.', 'status_code': 200}

        try:
            evalsJson = php_json_encode(proposal['eval_queries'])
            paramsJson = php_json_encode(php_array(proposal['parameter_schema'])) if proposal['parameter_schema'] is not None else None
            newId = self.db.insert(
                'INSERT INTO skill_promotions'
                ' (user_id, class, status, source_ref, skill_name, description, eval_queries,'
                ' parameter_schema, merge_target, created_at)'
                " VALUES (:u, :c, 'proposed', :ref, :name, :descr, :evals, :params, :merge, NOW())"
                ' ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), class = VALUES(class),'
                ' description = VALUES(description),'
                " eval_queries = VALUES(eval_queries), parameter_schema = VALUES(parameter_schema),"
                " merge_target = VALUES(merge_target), status = 'proposed', decided_at = NULL",
                {':u': userId, ':c': class_, ':ref': sourceRef,
                 ':name': proposal['skill_name'], ':descr': proposal['description'],
                 ':evals': evalsJson, ':params': paramsJson, ':merge': proposal['merge_target']},
            )
            id_ = php_intval(newId)
        except Exception as e:  # noqa: BLE001
            error_log('[GenesisController] proposal insert failed: ' + str(e))
            return {'success': False, 'error': 'Could not store proposal', 'status_code': 500}

        return {'success': True, 'promotion': {
            'id': id_, 'class': class_, 'status': 'proposed', 'source_ref': sourceRef,
            'skill_name': proposal['skill_name'], 'description': proposal['description'],
            'eval_queries': proposal['eval_queries'],
            'parameter_schema': php_array(proposal['parameter_schema']) if proposal['parameter_schema'] is not None else None,
            'merge_target': proposal['merge_target'], 'rationale': proposal['rationale'],
            'is_merge': proposal['is_merge'],
        }, 'status_code': 200}

    # ─── internals ───────────────────────────────────────────────────────────

    def _promotionBelongsToUser(self, promotionId: int, userId: int) -> bool:
        if promotionId <= 0:
            return False
        row = self.db.fetch_one('SELECT 1 FROM skill_promotions WHERE id = ? AND user_id = ?', [promotionId, userId])
        return bool(row)

    def _genesisConfig(self, userId) -> dict:
        """Returns {mode: str, budget: float, ceiling: float, weekly_max: int, provider: str}"""
        d = {'mode': 'off', 'budget': 3.00, 'ceiling': 1.50, 'weekly_max': 2, 'provider': 'kimi'}
        try:
            row = self.db.fetch_one(
                'SELECT genesis_mode, genesis_daily_budget_usd, genesis_per_skill_ceiling_usd,'
                ' genesis_max_skills_per_week, genesis_reflection_provider'
                ' FROM users WHERE id = ?',
                [userId],
            ) or {}
            mode = row['genesis_mode'] if row.get('genesis_mode') is not None else d['mode']
            mode = mode if not php_empty(mode) else d['mode']
            budget = php_floatval(row['genesis_daily_budget_usd']) if row.get('genesis_daily_budget_usd') is not None else d['budget']
            ceiling = php_floatval(row['genesis_per_skill_ceiling_usd']) if row.get('genesis_per_skill_ceiling_usd') is not None else d['ceiling']
            weeklyMax = php_intval(row['genesis_max_skills_per_week']) if row.get('genesis_max_skills_per_week') is not None else d['weekly_max']
            provider = row['genesis_reflection_provider'] if row.get('genesis_reflection_provider') is not None else d['provider']
            provider = provider if not php_empty(provider) else d['provider']
            return {'mode': str(mode), 'budget': budget, 'ceiling': ceiling, 'weekly_max': weeklyMax,
                    'provider': str(provider)}
        except Exception:  # noqa: BLE001 — columns not created yet -> defaults
            return d

    def _spentToday(self, userId) -> float:
        try:
            vals = self.db.fetch_column(
                "SELECT COALESCE(SUM(spent_usd),0) FROM heal_spend"
                " WHERE user_id = :u AND day = CURDATE() AND kind = 'genesis'",
                {':u': userId},
            )
            return php_floatval(vals[0]) if vals else 0.0
        except Exception:  # noqa: BLE001
            return 0.0

    def _bornThisWeek(self, userId) -> int:
        try:
            vals = self.db.fetch_column(
                'SELECT COUNT(*) FROM skill_promotions'
                " WHERE user_id = :u AND status = 'born' AND decided_at >= (NOW() - INTERVAL 7 DAY)",
                {':u': userId},
            )
            return php_intval(vals[0]) if vals else 0
        except Exception:  # noqa: BLE001
            return 0
