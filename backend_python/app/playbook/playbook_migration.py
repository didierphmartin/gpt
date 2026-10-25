"""Port of backend/src/Playbook/PlaybookMigration.php.

One-time move of playbook text from playbook agents and playbook workflow nodes into the playbook collection.
Runs in one transaction: committed when `write`, rolled back otherwise (a dry run), so the report is the same
either way.
"""
from __future__ import annotations

import json

from app.playbook.playbook_document import PlaybookDocument
from app.playbook.playbook_store import PlaybookStore
from app.support.phpcompat import php_empty, php_intval, php_strval, php_trim


class PlaybookMigration:
    DEFAULT_POLICY = {'writes_enabled': False, 'on_unbound': 'handoff', 'on_failure': 'continue_then_handoff'}

    def __init__(self, db):
        self.db = db
        self.store = PlaybookStore(db)
        self.report: dict = {}

    def run(self, write: bool) -> dict:
        self.report = {'created': [], 'suffixed': [], 'dropped_bindings': [], 'dropped_policy': [],
                       'agents_linked': 0, 'nodes_linked': 0, 'errors': []}
        self.db.begin()
        try:
            self._migrateAgents()
            self._migrateNodes()
        except BaseException:
            self.db.rollback()
            raise
        if write:
            self.db.commit()
        else:
            self.db.rollback()
        return self.report

    def _migrateAgents(self) -> None:
        rows = self.db.fetch_all("SELECT id, user_id, name, instructions FROM agents\n"
                                 "            WHERE agent_type = 'playbook' AND playbook_id IS NULL AND instructions IS NOT NULL AND TRIM(instructions) <> ''\n"
                                 "            ORDER BY id")
        for r in rows:
            frm = f'agent #{r["id"]} "{r["name"]}"'
            pb = self._create(php_intval(r['user_id']), php_strval(r['instructions']), frm)
            if pb is None:
                continue
            self.db.execute("UPDATE agents SET playbook_id = ?, instructions = '' WHERE id = ?", [pb, r['id']])
            self.report['agents_linked'] += 1

    def _migrateNodes(self) -> None:
        rows = self.db.fetch_all("SELECT n.id, n.agent_id, n.config, w.user_id, w.name AS wname\n"
                                 "            FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id\n"
                                 "            WHERE n.node_type = 'playbook' ORDER BY n.id")
        for r in rows:
            try:
                cfg = json.loads(php_strval(r['config']))
            except ValueError:
                cfg = None
            if not isinstance(cfg, dict) or not php_empty(cfg.get('playbook_id')):
                continue
            owner = php_intval(r['user_id'])
            frm = f'node #{r["id"]} "' + php_strval(cfg.get('name') if cfg.get('name') is not None else 'Playbook') \
                + f'" in workflow "{r["wname"]}"'
            # The config's agent_id, else the node row's agent_id column.
            agent = cfg.get('agent_id') if cfg.get('agent_id') is not None else r.get('agent_id')
            pb = self._agentPlaybook(owner, php_intval(agent if agent is not None else 0))
            if pb is None:
                runSettings: dict = {}
                pb = self._fromNodePlaybook(owner, cfg.get('playbook'), frm, runSettings)
                if pb is None:
                    continue
                cfg = {**runSettings, **{k: v for k, v in cfg.items() if k not in runSettings}}   # $runSettings + $cfg
            cfg.pop('playbook', None)
            cfg.pop('playbook_missing', None)
            cfg['playbook_id'] = pb
            self.db.execute('UPDATE workflow_nodes SET config = ? WHERE id = ?',
                            [json.dumps(cfg, ensure_ascii=False, separators=(',', ':')), r['id']])
            self.report['nodes_linked'] += 1
            self.nodeLinked(php_intval(r['id']))

    def nodeLinked(self, nodeId: int) -> None:
        """Hook after each node is linked (a test seam; does nothing)."""

    def _agentPlaybook(self, owner: int, agentId: int) -> int | None:
        """The playbook already linked to the owner's own agent (migrated above or linked before); None for another user's agent."""
        if agentId == 0:
            return None
        v = self.db.fetch_column('SELECT playbook_id FROM agents WHERE id = ? AND user_id = ? AND playbook_id IS NOT NULL',
                                 [agentId, owner])
        return None if not v else php_intval(v[0])

    def _fromNodePlaybook(self, owner: int, playbook, frm: str, runSettings: dict) -> int | None:
        """The collection playbook for a node's own playbook; a JSON one with a non-default policy or approvers
        reports them (dropped_policy) and hands them back in runSettings for the node config."""
        if isinstance(playbook, (dict, list)):
            try:
                doc = PlaybookDocument.fromArray(playbook if isinstance(playbook, dict) else {})
            except ValueError as e:
                self.report['errors'].append({'from': frm, 'error': str(e)})
                return None
            bindings = doc.bindings if isinstance(doc.bindings, dict) else dict(enumerate(doc.bindings or []))
            for action, tool in bindings.items():
                if tool is not None and tool != '':
                    self.report['dropped_bindings'].append({'title': doc.title, 'action': php_strval(action), 'tool': php_strval(tool)})
            if doc.policy != self.DEFAULT_POLICY or doc.approvers not in ([], {}):
                self.report['dropped_policy'].append({'title': doc.title, 'policy': doc.policy, 'approvers': doc.approvers})
                runSettings.update({'policy': doc.policy, 'approvers': doc.approvers})
            return self._create(owner, self._render(doc), frm)
        if not isinstance(playbook, str) or php_trim(playbook) == '':
            self.report['errors'].append({'from': frm, 'error': 'The node has no playbook text.'})
            return None
        return self._create(owner, playbook, frm)

    @staticmethod
    def _render(d: PlaybookDocument) -> str:
        out = (f"Title: {d.title}\nTrigger: {d.trigger['description']}\nInstructions:\n{d.instructions}\n"
               + 'Tools used: ' + '; '.join(d.toolsUsed) + "\n"
               + 'Actions used: ' + '; '.join(d.actionsUsed) + "\n")
        return out if d.domain == '' else out + f'Domain: {d.domain}\n'

    def _create(self, userId: int, text: str, frm: str) -> int | None:
        """Create the playbook (key from the title, suffixed on a clash); None and an error entry when the text does not parse."""
        try:
            title = PlaybookDocument.fromConsoleText(text).title
        except ValueError as e:
            self.report['errors'].append({'from': frm, 'error': str(e)})
            return None
        base = PlaybookStore.keyFromTitle(title)
        key = self.store.freeKey(userId, base)
        row = self.store.save(userId, None, text, key)
        if key != base:
            self.report['suffixed'].append({'title': title, 'pkey': key})
        self.report['created'].append({'user_id': userId, 'pkey': key, 'title': title, 'from': frm})
        return row['id']
