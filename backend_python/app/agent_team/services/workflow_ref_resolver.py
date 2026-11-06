"""Port of backend/src/AgentTeam/Services/WorkflowRefResolver.php and UnresolvedRefsException.php.

Turns the names a compiled workflow graph uses (playbook_ref = pkey, code_component_ref / start_option_ref =
component name, edge from_port_name = exit name) into the ids and ports the graph repository stores.
Resolution is against the workflow owner's own rows, then the robot's (shared with robot-permitted users).
"""
from __future__ import annotations

import json

from app.agent_team.services.start_option_graph import StartOptionGraph
from app.code_component.code_component_store import CodeComponentStore
from app.support.phpcompat import is_numeric, php_empty, php_intval, php_strval


class UnresolvedRefsException(RuntimeError):
    """A workflow graph names playbooks, components or exits that do not exist for its owner."""

    def __init__(self, missing: list[str]):
        super().__init__('unknown references: ' + '; '.join(missing))
        self.missing = missing


class WorkflowRefResolver:
    PLAYBOOK_EXITS = ['done', 'failed']

    def __init__(self, db):
        self.db = db

    def resolve(self, userId: int, nodes, edges, robotId: int | None = None) -> dict:
        """{nodes, edges} with the names replaced; raises UnresolvedRefsException listing every name that did not resolve."""
        nodes = [dict(n) if isinstance(n, dict) else n for n in self._items(nodes)]
        edges = [dict(e) if isinstance(e, dict) else e for e in self._items(edges)]
        missing: list[str] = []
        exitsByNode: dict[str, list] = {}   # node id => list of exit names the node's out-edges are named against

        for i, node in enumerate(nodes):
            if not isinstance(node, dict):
                continue
            cfg = node.get('config') if node.get('config') is not None else node.get('data')
            if not isinstance(cfg, (dict, list)):
                continue
            cfg = dict(cfg) if isinstance(cfg, dict) else dict(enumerate(cfg))
            key = 'config' if node.get('config') is not None else 'data'
            id = php_strval(node.get('id') if node.get('id') is not None else '')

            if cfg.get('playbook_ref') is not None:
                ref = php_strval(cfg['playbook_ref'])
                pid = self._playbookId(userId, ref, robotId)
                if pid is None:
                    missing.append(f"playbook '{ref}'")
                else:
                    cfg['playbook_id'] = pid
                cfg.pop('playbook_ref', None)
                exitsByNode[id] = self.PLAYBOOK_EXITS
            if cfg.get('code_component_ref') is not None:
                ref = php_strval(cfg['code_component_ref'])
                c = self._component(userId, ref, robotId)
                if c is None:
                    missing.append(f"code component '{ref}'")
                else:
                    cfg['code_component_id'] = c['id']
                    exitsByNode[id] = c['exits']
                cfg.pop('code_component_ref', None)
            if cfg.get('start_option_ref') is not None:
                ref = php_strval(cfg['start_option_ref'])
                c = self._component(userId, ref, robotId)
                if c is None:
                    missing.append(f"start option component '{ref}'")
                else:
                    cfg['start_option'] = c['id']
                    exitsByNode[id] = c['exits']
                cfg.pop('start_option_ref', None)
            nodes[i][key] = cfg

        for i, edge in enumerate(edges):
            if not isinstance(edge, dict) or 'from_port_name' not in edge:
                continue
            name = php_strval(edge['from_port_name'])
            frm = edge.get('from') if edge.get('from') is not None else edge.get('from_node_id')
            frm = php_strval(frm if frm is not None else '')
            exits = exitsByNode.get(frm)
            at = exits.index(name) if exits is not None and name in exits else None
            if at is None:
                missing.append(f"exit '{name}' on node '{frm}'")
            else:
                edge['from_port'] = f'output_{at + 1}'
            del edge['from_port_name']
            edges[i] = edge

        if missing:
            raise UnresolvedRefsException(list(dict.fromkeys(missing)))
        return {'nodes': nodes, 'edges': edges}

    @staticmethod
    def _items(v) -> list:
        if isinstance(v, dict):
            return list(v.values())
        return list(v) if isinstance(v, list) else []

    def foreignToRobot(self, robotId: int, nodes) -> list[str]:
        """The links of a robot workflow's (resolved) nodes the robot cannot use: another user's code component, Start
        option or playbook (the robot's published playbook copies included), or an agent neither the robot's nor
        public/workspace. Named "code component #8" and so on; [] when every link is the robot's."""
        missing: list[str] = []

        def has(sql: str, id: int) -> bool:
            return self.db.fetch_one(sql, [id, robotId]) is not None

        for node in self._items(nodes):
            if not isinstance(node, dict):
                continue
            cfg = node.get('config') if node.get('config') is not None else node.get('data')
            cfg = cfg if isinstance(cfg, dict) else {}
            t = node.get('node_type')
            if t is None:
                t = node.get('type')
            if t is None:
                t = cfg.get('type')
            type_ = php_strval(t if t is not None else '')
            if (CodeComponentStore.isCodeNode(type_, cfg) and not php_empty(cfg.get('code_component_id'))
                    and not has('SELECT 1 FROM code_components WHERE id = ? AND user_id = ?', php_intval(cfg['code_component_id']))):
                missing.append(f"code component #{php_intval(cfg['code_component_id'])}")
            option = StartOptionGraph.optionId({'node_type': type_, 'config': cfg})
            if option is not None and not has('SELECT 1 FROM code_components WHERE id = ? AND user_id = ?', option):
                missing.append(f'start option component #{option}')
            if (not php_empty(cfg.get('playbook_id'))
                    and not has('SELECT 1 FROM playbooks WHERE id = ? AND user_id = ? AND source_id IS NULL', php_intval(cfg['playbook_id']))):
                missing.append(f"playbook #{php_intval(cfg['playbook_id'])}")
            agent = node.get('agent_id')
            if is_numeric(agent) and php_intval(agent) > 0 and not has(
                    "SELECT 1 FROM agents WHERE id = ?\n                    AND (user_id = ? OR visibility IN ('public', 'workspace'))",
                    php_intval(agent)):
                missing.append(f'agent #{php_intval(agent)}')
        return list(dict.fromkeys(missing))

    def _playbookId(self, userId: int, pkey: str, robotId: int | None = None) -> int | None:
        owners = [userId] if robotId is None else list(dict.fromkeys([userId, robotId]))
        for owner in owners:
            # the robot's published copies (source_id set, the ServiceNow bridge's) are not shared rows
            col = self.db.fetch_column('SELECT id FROM playbooks WHERE user_id = ? AND pkey = ?'
                                       + (' AND source_id IS NULL' if owner == robotId else '') + ' ORDER BY id LIMIT 1',
                                       [owner, pkey])
            if col:
                return php_intval(col[0])
        return None

    def _component(self, userId: int, name: str, robotId: int | None = None) -> dict | None:
        row = None
        for owner in ([userId] if robotId is None else [userId, robotId]):
            row = self.db.fetch_one('SELECT id, exits FROM code_components WHERE user_id = ? AND name = ? ORDER BY id LIMIT 1',
                                    [owner, name])
            if row:
                break
        if not row:
            return None
        try:
            exits = json.loads(php_strval(row['exits']))
        except ValueError:
            exits = None
        if isinstance(exits, dict):
            exits = list(exits.values())
        return {'id': php_intval(row['id']), 'exits': exits if isinstance(exits, list) else []}
