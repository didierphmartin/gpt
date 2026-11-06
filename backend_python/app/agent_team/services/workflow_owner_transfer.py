"""Port of backend/src/AgentTeam/Services/WorkflowOwnerTransfer.php and WorkflowTransferError.php.

Owner -> Robot (one way): the workflow and everything it uses that its owner owns (code components incl. the Start
option's, playbooks, agents and their playbooks) are moved to the robot in place, same ids, nothing copied; then
its schedule rows. Other users' rows (a public agent, a robot component) are left as they are.
"""
from __future__ import annotations

import json

from app.agent_team.services.active_workflow_service import ActiveWorkflowService
from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.start_option_graph import StartOptionGraph
from app.code_component.code_component_store import CodeComponentStore
from app.support.phpcompat import php_empty, php_intval, php_strval


class WorkflowTransferError(RuntimeError):
    """A refused Owner -> Robot transfer: kind (forbidden, not_found, clash) for the editor, status for the API."""

    def __init__(self, kind: str, message: str, status: int, clashes: list | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.clashes = clashes or []   # the robot's rows in the way (kind clash)


def _decode(raw):
    try:
        return json.loads(php_strval(raw if raw is not None else ''))
    except ValueError:
        return None


def _unique(items: list) -> list:
    return list(dict.fromkeys(items))


class WorkflowOwnerTransfer:
    def __init__(self, db, ownership, skills=None):
        """ownership: a RobotOwnership; skills: a RobotSkillPolicy (the robot uses public skills only), or None."""
        self.db = db
        self.ownership = ownership
        self.skills = skills

    def _assertPublicSkills(self, workflowId: int) -> None:
        """The robot uses public skills only (corporate): a workflow binding a private one is not handed over."""
        if self.skills is not None:
            private = self.skills.privateSkills(workflowId)
            if private:
                from app.services.private_skills_refused import PrivateSkillsRefused
                raise PrivateSkillsRefused(private)

    def preview(self, callerId: int, workflowId: int) -> dict:
        """{needs_servers: [names], shared_with: [{id, name}], clashes: [{kind, name}]}."""
        robot, owner, name = self._load(callerId, workflowId)
        self._assertPublicSkills(workflowId)
        links = self._links(workflowId)
        if owner == robot:
            return {'needs_servers': self._missingServers(robot, links['servers']), 'shared_with': [], 'clashes': []}
        plan = self._plan(owner, links)
        return {'needs_servers': self._missingServers(robot, links['servers']),
                'shared_with': self._sharedWith(owner, workflowId, plan),
                'clashes': self._clashes(robot, workflowId, name, plan)}

    def toRobot(self, callerId: int, workflowId: int) -> dict:
        """{workflow_id, moved: {components, playbooks, agents, schedules}}. An already robot-owned workflow only has
        its schedule rows moved again (a repair)."""
        robot, owner, name = self._load(callerId, workflowId)
        self._assertPublicSkills(workflowId)
        moved = {'components': [], 'playbooks': [], 'agents': []}
        if owner != robot:
            moved = self._plan(owner, self._links(workflowId))
            clashes = self._clashes(robot, workflowId, name, moved)
            if clashes:
                published = [c for c in clashes if c.get('published')]
                named = [c for c in clashes if not c.get('published')]

                def say(cs):
                    return ', '.join(f'{c["kind"]} "{c["name"]}"' for c in cs)
                parts = (([] if not named else [f'The robot already has {say(named)}: rename yours first.'])
                         + [f'The playbook "{c["name"]}" is published to the robot: unpublish it first.' for c in published])
                raise WorkflowTransferError('clash', ' '.join(parts), 409, clashes)
            self.db.begin()
            try:
                ActiveWorkflowService(self.db).deactivate(owner, workflowId)
                self.db.execute('UPDATE agent_workflows SET user_id = ? WHERE id = ? AND user_id = ?', [robot, workflowId, owner])
                for kind, table in (('components', 'code_components'), ('playbooks', 'playbooks'), ('agents', 'agents')):
                    if moved[kind]:
                        self.db.execute(f'UPDATE {table} SET user_id = ? WHERE user_id = ? AND id IN (' + self._marks(moved[kind]) + ')',
                                        [robot, owner, *moved[kind]])
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
        # scheduled_workflows is MyISAM: outside the transaction, and re-run on a robot workflow to repair it.
        schedules = [php_intval(v) for v in self._column(
            'SELECT id FROM scheduled_workflows WHERE workflow_id = ? AND user_id <> ? ORDER BY id', [workflowId, robot])]
        if schedules:
            self.db.execute('UPDATE scheduled_workflows SET user_id = ? WHERE id IN (' + self._marks(schedules) + ')', [robot, *schedules])
        return {'workflow_id': workflowId, 'moved': {**moved, 'schedules': schedules}}

    def _load(self, callerId: int, workflowId: int) -> tuple:
        """(robot id, owner id, workflow name): the caller may use the robot and owns the workflow, or the robot does."""
        robot = self.ownership.robotFor(callerId)
        if robot is None:
            raise WorkflowTransferError('forbidden', "Your role can't use the robot", 403)
        row = self.db.fetch_one('SELECT user_id, name FROM agent_workflows WHERE id = ?', [workflowId])
        if not row or php_intval(row['user_id']) not in (callerId, robot):
            raise WorkflowTransferError('not_found', f'Workflow #{workflowId} not found', 404)
        return robot, php_intval(row['user_id']), php_strval(row['name'])

    def _links(self, workflowId: int) -> dict:
        """What the workflow's nodes and schedule rows link to, whoever owns it: {components, playbooks, agents, servers}."""
        components: list = []
        playbooks: list = []
        agents: list = []
        servers: list = []
        for n in self.db.fetch_all('SELECT * FROM workflow_nodes WHERE workflow_id = ?', [workflowId]):
            cfg = _decode(n.get('config'))
            cfg = cfg if isinstance(cfg, dict) else {}
            if CodeComponentStore.isCodeNode(n.get('node_type'), cfg):
                if not php_empty(cfg.get('code_component_id')):
                    components.append(php_intval(cfg['code_component_id']))
                elif isinstance(cfg.get('mcp_servers'), list):
                    servers.extend(cfg['mcp_servers'])   # an inline code node ticks its own
            option = StartOptionGraph.optionId({'node_type': n.get('node_type') or '', 'config': cfg})
            if option is not None:
                components.append(option)
            if (n.get('node_type') or '') == 'playbook' and not php_empty(cfg.get('playbook_id')):
                playbooks.append(php_intval(cfg['playbook_id']))
            if not php_empty(n.get('agent_id')):
                agents.append(php_intval(n['agent_id']))
        for id in self._column('SELECT trigger_component_id FROM scheduled_workflows WHERE workflow_id = ? AND trigger_component_id IS NOT NULL',
                               [workflowId]):
            components.append(php_intval(id))
        components = _unique(components)
        if components:
            for raw in self._column('SELECT mcp_servers FROM code_components WHERE id IN (' + self._marks(components) + ')', components):
                decoded = _decode(raw)
                servers.extend(decoded if isinstance(decoded, list) else (list(decoded.values()) if isinstance(decoded, dict) else []))
        return {'components': components, 'playbooks': _unique(playbooks), 'agents': _unique(agents), 'servers': servers}

    def _plan(self, owner: int, links: dict) -> dict:
        """The owner's rows among the links, ids sorted: what moves. A moved agent's playbook moves with it."""
        agents = self._owned('agents', owner, links['agents'])
        playbooks = list(links['playbooks'])
        if agents:
            for id in self._column('SELECT playbook_id FROM agents WHERE playbook_id IS NOT NULL AND id IN (' + self._marks(agents) + ')', agents):
                playbooks.append(php_intval(id))
        return {'components': self._owned('code_components', owner, links['components']),
                'playbooks': self._owned('playbooks', owner, _unique(playbooks)), 'agents': agents}

    def _owned(self, table: str, owner: int, ids: list) -> list:
        if not ids:
            return []
        return [php_intval(v) for v in self._column(
            f'SELECT id FROM {table} WHERE user_id = ? AND id IN (' + self._marks(ids) + ') ORDER BY id', [owner, *ids])]

    def _clashes(self, robot: int, workflowId: int, name: str, plan: dict) -> list:
        """The robot's rows with the unique key (per owner) of one being moved: [{kind, name}]."""
        clashes = []
        if self._column('SELECT 1 FROM agent_workflows WHERE user_id = ? AND name = ? AND id <> ?', [robot, name, workflowId]):
            clashes.append({'kind': 'workflow', 'name': name})
        for kind, table, key, planKey in (('component', 'code_components', 'name', 'components'), ('playbook', 'playbooks', 'pkey', 'playbooks'),
                                          ('agent', 'agents', 'name', 'agents')):
            ids = plan[planKey]
            if not ids:
                continue
            # a robot playbook with a source_id is a published copy (the ServiceNow bridge's): unpublished, not renamed
            published = 'r.source_id IS NOT NULL' if kind == 'playbook' else '0'
            for r in self.db.fetch_all(f'SELECT m.{key} AS name, {published} AS published FROM {table} m JOIN {table} r ON r.{key} = m.{key} AND r.user_id = ?\n'
                                       f'                WHERE m.id IN (' + self._marks(ids) + f') ORDER BY m.{key}', [robot, *ids]):
                clashes.append({'kind': kind, 'name': php_strval(r['name']), **({'published': True} if php_intval(r['published']) else {})})
        return clashes

    def _sharedWith(self, owner: int, workflowId: int, plan: dict) -> list:
        """The owner's other workflows linking a moved item: they keep working, on the robot's rows."""
        shared = []
        for w in self.db.fetch_all('SELECT id, name FROM agent_workflows WHERE user_id = ? AND id <> ? ORDER BY name, id', [owner, workflowId]):
            links = self._links(php_intval(w['id']))
            for kind in ('components', 'playbooks', 'agents'):
                if set(links[kind]) & set(plan[kind]):
                    shared.append({'id': php_intval(w['id']), 'name': php_strval(w['name'])})
                    break
        return shared

    def _missingServers(self, robotId: int, names: list) -> list:
        """The servers (by name, sorted) the robot has no enabled row for, as code nodes resolve them: by slug, its own or shared."""
        have = {CodeNodeEmit.slug(php_strval(n)) for n in self._column(
            'SELECT name FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)', [str(robotId)])}
        return sorted(_unique([n for n in names if CodeNodeEmit.slug(php_strval(n)) not in have]))

    @staticmethod
    def _marks(ids: list) -> str:
        return ', '.join(['?'] * len(ids))

    def _column(self, sql: str, args: list) -> list:
        return self.db.fetch_column(sql, args)
