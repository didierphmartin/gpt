"""Port of Services/RobotSkillPolicy.php.

In the corporate edition (volume mode) the robot uses public skills only. Matching is on the skill's leaf name,
as everywhere in the store.
"""
from __future__ import annotations

import json

from app.services import edition as Edition
from app.services.robot_account import RobotAccount
from app.support.phpcompat import php_intval, php_strval


def _leaf(path: str) -> str:
    return str(path).rstrip('/').rsplit('/', 1)[-1]


class RobotSkillPolicy:
    MESSAGE = 'This workflow uses private skills. The robot can only use public skills.'

    def __init__(self, db, config: dict, store):
        """store: a SkillStore, or None (folder mode)."""
        self.db = db
        self.config = config
        self.store = store

    @classmethod
    def refusal(cls, skills: list) -> dict:
        """The 409 every refusal answers with. skills: [{path, owner_id, owner_name[, missing: True]}]."""
        return {'success': False, 'code': 'private_skills', 'message': cls.MESSAGE,
                'error': cls.MESSAGE, 'data': {'skills': skills}, 'status_code': 409}

    def privateSkills(self, workflowId: int) -> list:
        """[{path, owner_id, owner_name[, missing]}]: empty unless corporate + volume mode."""
        robot = RobotAccount.id(self.db)
        if self.store is None or robot is None or not Edition.is_corporate(self.config):
            return []
        public = {_leaf(row['path']) for row in self.store.list(robot, True)}
        out: dict = {}
        for d in self._boundSkills(workflowId):
            leaf = _leaf(d)
            if leaf in public or leaf in out:
                continue
            found = self.store.findPrivate(leaf)
            out[leaf] = {'path': found['path'] if found else d, 'owner_id': found['owner_id'] if found else 0,
                         'owner_name': '' if found is None else self._ownerName(found['owner_id']),
                         **({'missing': True} if found is None else {})}
        return list(out.values())

    def privateSkillsForOwner(self, ownerId: int, workflowId: int) -> list:
        """privateSkills() for a workflow run on behalf of ownerId: only the robot's runs are held to public skills."""
        return self.privateSkills(workflowId) if RobotAccount.id(self.db) == ownerId else []

    def robotWorkflowsUsing(self, leafName: str) -> list:
        """[{id, name}]: the robot's workflows whose nodes bind the skill leafName."""
        robot = RobotAccount.id(self.db)
        if robot is None:
            return []
        out: dict = {}
        for r in self.db.fetch_all('SELECT w.id, w.name, n.config FROM agent_workflows w JOIN workflow_nodes n ON n.workflow_id = w.id\n'
                                   '            WHERE w.user_id = ? ORDER BY w.name, w.id', [robot]):
            for d in self._dirs(php_strval(r['config'])):
                if _leaf(d) == leafName:
                    out[php_intval(r['id'])] = {'id': php_intval(r['id']), 'name': php_strval(r['name'])}
        return list(out.values())

    def _boundSkills(self, workflowId: int) -> list:
        dirs = []
        for config in self.db.fetch_column('SELECT config FROM workflow_nodes WHERE workflow_id = ?', [workflowId]):
            dirs += self._dirs(php_strval(config))
        return dirs

    @staticmethod
    def _dirs(config: str) -> list:
        from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
        try:
            cfg = json.loads(config)
        except ValueError:
            cfg = None
        return [s['dir'] for s in (WorkflowGraphAnalyzer.skillsFromConfig(cfg) if isinstance(cfg, dict) else [])
                if isinstance(s, dict) and s.get('dir') is not None]

    def _ownerName(self, userId: int) -> str:
        r = self.db.fetch_one('SELECT first_name, last_name FROM users WHERE id = ?', [userId])
        return (php_strval(r['first_name']) + ' ' + php_strval(r['last_name'])).strip(' \t\n\r\0\x0b') if r else ''
