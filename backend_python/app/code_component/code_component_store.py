"""Port of backend/src/CodeComponent/CodeComponentStore.php.

The code components collection: the only code that touches `code_components`. A component is a
code node's body (code, exits, MCP servers, timeout) under a name unique per user; workflow code
nodes link to it by config.code_component_id. Owner-scoped throughout; a robot-permitted caller also sees the robot's
rows (is_robot), shared with every such user.
"""
from __future__ import annotations

import json
import re

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.scheduled_workflow_service import ScheduledWorkflowService
from app.agent_team.services.start_option_graph import StartOptionGraph
from app.agent_team.services.start_trigger_facts import StartTriggerFacts
from app.code_component.code_component_error import CodeComponentError
from app.exceptions.invalid_argument import InvalidArgumentException
from app.support.phpcompat import php_array, php_empty, php_intval, php_strval, php_trim
from app.support.phpjson import php_json_decode, php_json_encode

_PORT = re.compile(r'^output_(\d+)$')
_PASS_ARG = re.compile(r'^[A-Za-z_]\w*$', re.ASCII)
# An argument or provided name: an identifier, matched whole (no trailing-newline loophole).
_DECL_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')


def _in_tx(db) -> bool:
    f = getattr(db, 'inTransaction', None)
    return bool(f()) if f else False


def _json_unescaped(v) -> str:
    """json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."""
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


def _decode(raw):
    """json_decode($raw, true) for a column value: None on invalid JSON."""
    try:
        return json.loads(php_strval(raw if raw is not None else ''))
    except ValueError:
        return None


def _unique_key(v):
    return php_strval(v) if not isinstance(v, (list, dict)) else 'Array'


class CodeComponentStore:
    NAME_MAX = 191
    COLS = 'id, user_id, name, description, code, exits, mcp_servers, timeout_s, start_trigger, args, provides, updated_at'
    LABEL_MAX = 60
    PASS_ARGS_MAX = 20
    DECLS_MAX = 20

    def __init__(self, db):
        self.db = db

    @staticmethod
    def _owners(userId: int, robotId: int | None) -> list[int]:
        """The owners whose rows a caller sees: the user, and the robot when the caller may use it."""
        return [userId] if robotId is None or robotId == userId else [userId, robotId]

    @staticmethod
    def _in(ids: list) -> str:
        return ','.join(['?'] * len(ids))

    def list(self, userId: int, robotId: int | None = None) -> list[dict]:
        """robotId: also the robot's rows (is_robot = True), for a caller who may use the robot."""
        o = self._owners(userId, robotId)
        rows = [self._row(r, robotId) for r in self.db.fetch_all(
            'SELECT ' + self.COLS + ' FROM code_components WHERE user_id IN (' + self._in(o) + ') ORDER BY name', o)]
        links = self._linkedNodesOf(userId, [r['id'] for r in rows], robotId)   # one scan for the whole list
        for r in rows:
            r['used_by'] = len(links[r['id']])
        return rows

    def get(self, userId: int, id: int, robotId: int | None = None) -> dict | None:
        o = self._owners(userId, robotId)
        r = self.db.fetch_one('SELECT ' + self.COLS + ' FROM code_components WHERE id = ? AND user_id IN (' + self._in(o) + ')',
                              [id, *o])
        return None if r is None else self._row(r, robotId)

    def getByName(self, userId: int, name: str, robotId: int | None = None) -> dict | None:
        o = self._owners(userId, robotId)
        found = None
        for r in self.db.fetch_all('SELECT ' + self.COLS + ' FROM code_components WHERE name = ? AND user_id IN (' + self._in(o) + ')',
                                   [name, *o]):   # the user's own row wins over the robot's
            if found is None or php_intval(r['user_id']) == userId:
                found = r
        return None if found is None else self._row(found, robotId)

    def _isRobotComponent(self, id: int, robotId: int | None) -> bool:
        if robotId is None:
            return False
        return self.db.fetch_one('SELECT 1 FROM code_components WHERE id = ? AND user_id = ?', [id, robotId]) is not None

    def _ownerOf(self, userId: int, id: int, robotId: int | None) -> int:
        """Whose row `id` is: the robot's when the caller sees it as the robot's, else the caller."""
        return robotId if (self.get(userId, id, robotId) or {}).get('is_robot') else userId

    def save(self, userId: int, id: int | None, data: dict, robotId: int | None = None) -> dict:
        """Create (id None; an existing name updates that row, as agents do) or update by id."""
        c = self._validate(data)
        caller = userId
        before = None if id is None else self.get(userId, id, robotId)
        if id is not None and before is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        # a robot component stays the robot's (updated by id); a new one is always the caller's
        userId = robotId if before is not None and before['is_robot'] else userId
        clash = self.getByName(userId, c['name'])
        if id is None and clash is not None:
            id = clash['id']
            before = clash
        elif clash is not None and clash['id'] != id:
            raise CodeComponentError('name_taken', f'A code component named "{c["name"]}" already exists.', 409)
        if before is not None and before['start_trigger'] is not None:
            t = before['start_trigger']
            if t['work_exit'] not in c['exits']:
                raise CodeComponentError('start_exit',
                                         f'Exit "{t["work_exit"]}" starts workflows: keep it or change the Start option first.', 422)
            if t['watch']['server'] not in c['mcp_servers']:
                raise CodeComponentError('start_exit',
                                         f'MCP server "{t["watch"]["server"]}" starts workflows: keep it or change the Start option first.', 422)
        if before is not None and before['exits'] != c['exits'] and php_empty(data.get('confirm_drop_links')):
            lost = self.droppedLinks(caller, id, before['exits'], c['exits'], robotId)
            if lost:
                what = [self._others(l['others']) if 'others' in l
                        else f'"{l["exit"]}" on {l["node_name"]} in "{l["workflow_name"]}"' for l in lost]
                raise CodeComponentError('links_dropped', 'Removing these exits removes the links on '
                                         + ', '.join(what) + '. Save again to confirm.', 409, lost)
        # absent args/provides keep the stored lists (a save from an older client must not wipe them)
        args = c['args'] if 'args' in c else (before['args'] if before is not None else [])
        provides = c['provides'] if 'provides' in c else (before['provides'] if before is not None else [])
        vals = [c['name'], c['description'], c['code'], php_json_encode(c['exits']), php_json_encode(c['mcp_servers']), c['timeout_s'],
                php_json_encode(args), php_json_encode(provides)]
        if id is None:
            id = int(self.db.insert('INSERT INTO code_components (user_id, name, description, code, exits, mcp_servers, timeout_s, args, provides, created_at, updated_at)\n'
                                    '                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [userId, *vals]))
        else:
            outer = not _in_tx(self.db)
            if outer:
                self.db.begin()
            try:
                self.db.execute('UPDATE code_components SET name = ?, description = ?, code = ?, exits = ?, mcp_servers = ?, timeout_s = ?, args = ?, provides = ?,\n'
                                '                    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [*vals, id, userId])
                if before['exits'] != c['exits']:
                    self._remapExits(userId, id, before['exits'], c['exits'], robotId)
                if outer:
                    self.db.commit()
            except BaseException:
                if outer:
                    self.db.rollback()
                raise
        return self.get(userId, id, robotId)

    def delete(self, userId: int, id: int, robotId: int | None = None) -> None:
        c = self.get(userId, id, robotId)
        if c is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        caller = userId
        userId = robotId if c['is_robot'] else userId
        if c['start_trigger'] is not None:
            raise CodeComponentError('is_option', 'This code component is a Start option: remove the option first.', 409)
        used = self.usedBy(caller, id, robotId)   # every link refuses; only the caller's visible ones are named
        if used:
            names = [self._others(n['others']) if 'others' in n
                     else f'node "{n["node_name"]}" in workflow "{n["workflow_name"]}"' for n in used]
            raise CodeComponentError('in_use', 'This code component is used by ' + ', '.join(names) + '.', 409)
        self.db.execute('DELETE FROM code_components WHERE id = ? AND user_id = ?', [id, userId])

    def setStartTrigger(self, userId: int, id: int, trigger: dict, robotId: int | None = None) -> dict:
        """Make the component a Start option (spec §1); the trigger is validated against the component."""
        c = self.get(userId, id, robotId)
        if c is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        userId = robotId if c['is_robot'] else userId
        t = self._validateStartTrigger(c, trigger)
        robot = c['is_robot']
        outer = not _in_tx(self.db)
        if outer:
            self.db.begin()
        try:
            self.db.execute('UPDATE code_components SET start_trigger = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
                            [_json_unescaped(t), id, userId])
            # the schedules already on this option carry a copy of its watch: an edit reaches them too
            watch = php_json_decode(_json_unescaped(t['watch']))
            rows = self.db.fetch_all('SELECT id, workflow_id FROM scheduled_workflows WHERE trigger_component_id = ?'
                                     + ('' if robot else ' AND user_id = ?'), [id] if robot else [id, userId])
            for r in rows:   # each keeps its own Start's args
                self.db.execute('UPDATE scheduled_workflows SET event_trigger = ? WHERE id = ?', [
                    ScheduledWorkflowService.eventTrigger(_json_unescaped(
                        self._watchWithStartArgs(watch, php_intval(r['workflow_id']), t['pass_args']))), r['id']])
            if outer:
                self.db.commit()
        except BaseException:
            if outer:
                self.db.rollback()
            raise
        return self.get(userId, id, robotId)

    def startTriggerImpact(self, userId: int, id: int, robotId: int | None = None) -> list[dict]:
        """The user's workflows on this option: their schedule runs on it, or their Start shows its exits."""
        caller = userId
        userId = self._ownerOf(userId, id, robotId)
        robot = self._isRobotComponent(id, robotId)   # a robot option is scheduled by any permitted user
        rows: dict[int, dict] = {}
        for r in self.db.fetch_all('SELECT DISTINCT s.workflow_id, w.name, w.user_id FROM scheduled_workflows s\n'
                                   '            JOIN agent_workflows w ON w.id = s.workflow_id\n'
                                   '            WHERE s.trigger_component_id = ?' + ('' if robot else ' AND s.user_id = ?'),
                                   [id] if robot else [id, userId]):
            rows[php_intval(r['workflow_id'])] = {'workflow_id': php_intval(r['workflow_id']), 'workflow_name': php_strval(r['name']),
                                                   'owner': php_intval(r['user_id'])}
        for n in self._linkedNodes(caller, id, robotId):
            if n['is_start']:
                rows[n['workflow_id']] = {'workflow_id': n['workflow_id'], 'workflow_name': n['workflow_name'], 'owner': n['owner']}
        shown, others = self._split(list(rows.values()), caller, robotId)
        shown.sort(key=lambda r: (r['workflow_name'], r['workflow_id']))
        out = [{'workflow_id': r['workflow_id'], 'workflow_name': r['workflow_name']} for r in shown]
        return [*out, {'others': others}] if others > 0 else out

    def clearStartTrigger(self, userId: int, id: int, robotId: int | None = None) -> list[dict]:
        """Remove the option: its schedule rows are deleted (a 'none' row would still run once at its time) and the
        component stops being an option. Start nodes on it go back to one port (revertStarts); linked code nodes stay."""
        c = self.get(userId, id, robotId)
        if c is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        impact = self.startTriggerImpact(userId, id, robotId)   # as the caller sees it
        userId = robotId if c['is_robot'] else userId
        outer = not _in_tx(self.db)
        if outer:
            self.db.begin()
        try:
            self.db.execute('DELETE FROM scheduled_workflows WHERE trigger_component_id = ?' + ('' if c['is_robot'] else ' AND user_id = ?'),
                            [id] if c['is_robot'] else [id, userId])
            if c['start_trigger'] is not None:
                self._revertStarts(userId, id, c['exits'], c['start_trigger']['work_exit'], robotId)
            self.db.execute('UPDATE code_components SET start_trigger = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
                            [id, userId])
            if outer:
                self.db.commit()
        except BaseException:
            if outer:
                self.db.rollback()
            raise
        return impact

    def scheduleBody(self, userId: int, body: dict, workflowId: int | None = None) -> dict:
        """A schedule save naming an option becomes that option's event schedule (spec §3); other bodies pass
        through. The watch is the option's, plus the Start node's start_args.tag and the start_args the option
        names in pass_args, as MCP arguments (the other start_args are not). workflowId: the workflow when the
        body does not carry it (an update)."""
        if php_empty(body.get('trigger_component_id')):
            return body
        id = php_intval(body['trigger_component_id'])
        watch = self.watchFor(userId, id)   # refuses a foreign or non-option component
        st = (self.get(userId, id) or {}).get('start_trigger') or {}
        passArgs = st.get('pass_args') if st.get('pass_args') is not None else []
        wf = body.get('workflow_id') if body.get('workflow_id') is not None else (workflowId if workflowId is not None else 0)
        watch = self._watchWithStartArgs(watch, php_intval(wf), passArgs if isinstance(passArgs, list) else [])
        out = {'repeat_type': 'event', 'event_trigger': watch, 'cron': None, 'trigger_component_id': id}
        for k, v in body.items():
            if k not in out:
                out[k] = v
        return out

    def _watchWithStartArgs(self, watch: dict, workflowId: int, passArgs: list) -> dict:
        """The watch with the workflow's Start args merged into its args (StartTriggerFacts.watchArgs); the Start's values win."""
        args = watch.get('args') if isinstance(watch.get('args'), (dict, list)) else []
        merged = StartTriggerFacts.watchArgs(args, self._startArgs(workflowId), passArgs)
        if merged != args:
            watch = {**watch, 'args': merged}
        return watch

    def _startArgs(self, workflowId: int) -> dict:
        """The workflow's Start node's start_args, or {}."""
        if workflowId <= 0:
            return {}
        col = self.db.fetch_column("SELECT config FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'start' ORDER BY id LIMIT 1",
                                   [workflowId])
        cfg = _decode(col[0] if col else None)
        args = cfg.get('start_args') if isinstance(cfg, dict) else None
        return args if isinstance(args, dict) else {}

    def watchFor(self, userId: int, id: int) -> dict:
        """The option's watch, as an event schedule stores it: {server, tool, args}."""
        c = self.get(userId, id)
        if c is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        if c['start_trigger'] is None:
            raise CodeComponentError('not_option', f'"{c["name"]}" is not a Start option.', 422)
        return c['start_trigger']['watch']

    @staticmethod
    def isCodeNode(nodeType: str | None, cfg) -> bool:
        """A workflow_nodes row is a code node. The column decides when it has a value; a DB whose node_type
        is still the old ENUM (no 'code') stores '' for one, and then the config's type decides."""
        nt = nodeType if nodeType is not None else ''
        return nt == 'code' if nt != '' else (isinstance(cfg, dict) and cfg.get('type') == 'code')

    def usedBy(self, userId: int, id: int, robotId: int | None = None) -> list[dict]:
        """The user's workflow code nodes that link to the component, and the Start nodes on its option. A robot
        component is linked from every user's workflows: only the caller's own and the robot's are named, the rest
        end the list as one {others: number of workflows}."""
        shown, others = self._split(self._linkedNodes(userId, id, robotId), userId, robotId)
        out = [{k: v for k, v in n.items() if k not in ('node_id', 'is_start', 'owner')} for n in shown]
        return [*out, {'others': others}] if others > 0 else out

    @staticmethod
    def _split(rows: list, caller: int, robotId: int | None) -> tuple[list, int]:
        """(the rows on workflows the caller may open (their own, the robot's), the number of other workflows)."""
        shown = []
        hidden: dict = {}
        for r in rows:
            if r['owner'] == caller or (robotId is not None and r['owner'] == robotId):
                shown.append(r)
            else:
                hidden[r['workflow_id']] = True
        return shown, len(hidden)

    @staticmethod
    def _others(n: int) -> str:
        """"2 other workflows", for a message."""
        return '1 other workflow' if n == 1 else f'{n} other workflows'

    def _linkedNodes(self, userId: int, id: int, robotId: int | None = None) -> list[dict]:
        """usedBy, unfiltered, plus each node's workflow_nodes.id and its workflow's owner."""
        return self._linkedNodesOf(userId, [id], robotId)[id]

    def _linkedNodesOf(self, userId: int, ids: list, robotId: int | None) -> dict:
        """_linkedNodes of several components, in one scan of the workflow nodes: id => nodes."""
        out: dict = {i: [] for i in ids}
        if not ids:
            return out
        o = self._owners(userId, robotId)
        # A robot component is linked from any permitted user's workflows: scan them all.
        robots: set = set()
        if robotId is not None:
            robots = {php_intval(v) for v in self.db.fetch_column(
                'SELECT id FROM code_components WHERE user_id = ? AND id IN (' + self._in(ids) + ')', [robotId, *ids])}
        all_ = bool(robots)
        # The link lives in the node's config JSON: decoded here, so the query stays portable (MySQL and SQLite).
        rows = self.db.fetch_all('SELECT n.id AS node_id, n.node_type, n.config, w.id AS workflow_id, w.name AS workflow_name, w.user_id AS owner\n'
                                 '            FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id'
                                 + ('' if all_ else ' WHERE w.user_id IN (' + self._in(o) + ')') + ' ORDER BY w.name, n.id',
                                 [] if all_ else [str(x) for x in o])
        for r in rows:
            cfg = _decode(r['config'])
            linked = cfg.get('code_component_id') if isinstance(cfg, dict) else None
            code = php_intval(linked if linked is not None else 0) if self.isCodeNode(r['node_type'], cfg) else 0
            start = None if (code in out or not isinstance(cfg, dict)) else StartOptionGraph.optionId(
                {'node_type': r['node_type'], 'config': cfg})
            id = code if code in out else start
            owner = php_intval(r['owner'])
            # a personal component's links are on the owners' workflows only (the full scan reads everyone's)
            if id is None or id not in out or (id not in robots and owner not in o):
                continue
            isStart = id != code
            name = cfg.get('name') if isinstance(cfg, dict) and cfg.get('name') is not None else 'Code'
            out[id].append({'workflow_id': php_intval(r['workflow_id']), 'workflow_name': php_strval(r['workflow_name']),
                            'node_name': 'Start' if isStart else php_strval(name), 'node_id': php_intval(r['node_id']),
                            'is_start': isStart, 'owner': owner})
        return out

    def droppedLinks(self, userId: int, id: int, oldExits: list, newExits: list, robotId: int | None = None) -> list[dict]:
        """The links an exit change would remove (remapExits' rules): [{workflow_id, workflow_name, node_name, exit,
        count}], one per linked node and removed exit that has links. Collapsing to one exit removes none."""
        if len(newExits) == 1 or len(oldExits) == 1:
            return []
        lost = []
        for node in self._linkedNodes(userId, id, robotId):
            for k, exit in enumerate(oldExits):
                if exit in newExits:
                    continue
                n = self.db.fetch_column('SELECT COUNT(*) FROM workflow_edges WHERE from_node_id = ? AND from_port = ?',
                                         [node['node_id'], f'output_{k + 1}'])
                n = php_intval(n[0] if n else 0)
                if n > 0:
                    lost.append({'workflow_id': node['workflow_id'], 'workflow_name': node['workflow_name'],
                                 'node_name': node['node_name'], 'exit': exit, 'count': n, 'owner': node['owner']})
        # other users' workflows are counted, not named: one {others: workflows, count: links} ends the list
        shown, others = self._split(lost, userId, robotId)
        out = [{k: v for k, v in l.items() if k != 'owner'} for l in shown]
        if others > 0:
            out.append({'others': others, 'count': sum(l['count'] for l in lost) - sum(l['count'] for l in shown)})
        return out

    def _revertStarts(self, userId: int, id: int, exits: list, workExit: str, robotId: int | None = None) -> None:
        """Start nodes on the option go back to a plain Start: one port, holding the work exit's links; the other
        exits' links are removed, and so is config.start_option."""
        work = 'output_' + str((exits.index(workExit) if workExit in exits else 0) + 1)
        for node in self._linkedNodes(userId, id, robotId):
            if not node['is_start']:
                continue
            for e in self.db.fetch_all('SELECT id, from_port FROM workflow_edges WHERE from_node_id = ?', [node['node_id']]):
                if e['from_port'] == work:
                    self.db.execute("UPDATE workflow_edges SET from_port = 'output_1' WHERE id = ?", [e['id']])
                else:
                    self.db.execute('DELETE FROM workflow_edges WHERE id = ?', [e['id']])
            col = self.db.fetch_column('SELECT config FROM workflow_nodes WHERE id = ?', [node['node_id']])
            cfg = _decode(col[0] if col else None)
            cfg = cfg if isinstance(cfg, dict) and cfg else {}
            cfg.pop('start_option', None)
            self.db.execute('UPDATE workflow_nodes SET config = ? WHERE id = ?', [php_json_encode(php_array(cfg)), node['node_id']])

    def _remapExits(self, userId: int, id: int, oldExits: list, newExits: list, robotId: int | None = None) -> None:
        """Edges are stored by port index (output_k = exit k), so an exit change moves each linked node's
        edges BY NAME, as the editor's CodeNode.remapExits does: a surviving exit keeps its edges on its
        new port, a removed exit's edges go; one exit left moves every edge onto output_1 (duplicates
        dropped); one exit before lands on output_1 unless its name survives. Ports beyond the old exits
        are left alone."""
        for node in self._linkedNodes(userId, id, robotId):
            edges = []
            for e in self.db.fetch_all('SELECT id, to_node_id, to_port, from_port FROM workflow_edges WHERE from_node_id = ? ORDER BY id',
                                       [node['node_id']]):
                m = _PORT.match(php_strval(e['from_port']))
                k = int(m.group(1)) if m else 0
                if 1 <= k <= len(oldExits):
                    edges.append({**e, 'k': k})
            # old port order, so a collapse keeps the edge of the earliest exit (as the editor does)
            edges.sort(key=lambda x: (x['k'], php_intval(x['id'])))
            seen = set()
            for e in edges:
                if len(newExits) == 1:
                    key = f"{e['to_node_id']}|{e['to_port']}"
                    if key in seen:
                        self.db.execute('DELETE FROM workflow_edges WHERE id = ?', [e['id']])
                        continue
                    seen.add(key)
                    j = 0
                else:
                    exit = oldExits[e['k'] - 1]
                    found = newExits.index(exit) if exit in newExits else None
                    j = 0 if (len(oldExits) == 1 and found is None) else (-1 if found is None else found)
                if j < 0:
                    self.db.execute('DELETE FROM workflow_edges WHERE id = ?', [e['id']])
                elif f'output_{j + 1}' != e['from_port']:
                    self.db.execute('UPDATE workflow_edges SET from_port = ? WHERE id = ?', [f'output_{j + 1}', e['id']])

    @classmethod
    def _validate(cls, d: dict) -> dict:
        """The editor's rules (CodeNode.validateConfig): a name, 1-8 unique exits, server names, 1-300 s."""
        def bad(why: str):
            raise CodeComponentError('invalid', why, 422)
        name = php_trim(php_strval(d.get('name') if d.get('name') is not None else ''))
        if name == '' or len(name) > cls.NAME_MAX:
            bad('The name is required (at most 191 characters).')
        code = d.get('code') if d.get('code') is not None else ''
        if not isinstance(code, str):
            bad('code must be text.')
        exits = d.get('exits')
        if isinstance(exits, dict):
            exits = list(exits.values())
        if (not isinstance(exits, list) or exits == [] or len(exits) > 8
                or len({_unique_key(e) for e in exits}) != len(exits)):
            bad('exits must be 1 to 8 unique names.')
        for e in exits:
            if not isinstance(e, str) or not CodeNodeEmit.EXIT_RE.match(e):
                bad('Exit names are lowercase letters, digits and _ (got ' + php_json_encode(e) + ').')
        servers = d.get('mcp_servers') if d.get('mcp_servers') is not None else []
        if isinstance(servers, dict):
            servers = list(servers.values())
        if not isinstance(servers, list) or any(not isinstance(s, str) for s in servers):
            bad('mcp_servers must be a list of MCP server names.')
        timeout = d.get('timeout_s') if d.get('timeout_s') is not None else 30
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1 or timeout > 300:
            bad('timeout_s must be 1 to 300 seconds.')
        desc = d.get('description')
        out = {'name': name, 'description': php_strval(desc if desc is not None else ''), 'code': code,
               'exits': list(exits), 'mcp_servers': list(servers), 'timeout_s': timeout}
        if 'args' in d:
            out['args'] = cls._validateDecls(d['args'], True)
        if 'provides' in d:
            out['provides'] = cls._validateDecls(d['provides'], False)
        return out

    @classmethod
    def _validateDecls(cls, items, isArgs: bool) -> list[dict]:
        """The arguments ({name, description?, default?, required?}) or provided names ({name, description?}) a component
        declares: a list of identifiers, unique, at most 20; optional keys stay as given, unknown keys are dropped."""
        def bad(why: str):
            raise CodeComponentError('invalid', why, 422)
        what = ('args must be a list of {name, description, default, required}.' if isArgs
                else 'provides must be a list of {name, description}.')
        if items == {}:   # PHP decodes an empty JSON object to [] too
            items = []
        if not isinstance(items, list):
            bad(what)
        if len(items) > cls.DECLS_MAX:
            bad(f'At most {cls.DECLS_MAX} arguments and {cls.DECLS_MAX} provided names.')
        out = []
        seen = set()
        for e in items:
            if e == []:   # an empty JSON list is PHP's empty array: on to the name check
                e = {}
            if not isinstance(e, dict):
                bad(what)
            n = e.get('name')
            if not isinstance(n, str) or not _DECL_NAME.fullmatch(n):
                bad('Argument and provided names are letters, digits and _, not starting with a digit (got '
                    + php_json_encode(n) + ').')
            if n in seen:
                bad(('Argument' if isArgs else 'Provided name') + f' "{n}" is listed twice.')
            seen.add(n)
            decl = {'name': n}
            for k in (('description', 'default') if isArgs else ('description',)):
                if k in e:
                    if not isinstance(e[k], str):
                        bad(what)
                    decl[k] = e[k]
            if isArgs and 'required' in e:
                if not isinstance(e['required'], bool):
                    bad(what)
                decl['required'] = e['required']
            out.append(decl)
        return out

    @classmethod
    def _validateStartTrigger(cls, c: dict, t: dict) -> dict:
        """{label, watch: {server, tool, args}, work_exit, pass_args} against the component; args stay a JSON object.
        pass_args: the Start args merged into the watch's args (spec 2026-10-22 §6.1); absent = the stored list, or []."""
        def bad(why: str):
            raise CodeComponentError('invalid', why, 422)
        label = php_trim(php_strval(t.get('label') if t.get('label') is not None else ''))
        label = c['name'] if label == '' else label
        if len(label) > cls.LABEL_MAX:
            bad(f'The option label is at most {cls.LABEL_MAX} characters.')
        try:   # the shape an event schedule accepts (ScheduledWorkflowService.eventTrigger), normalised
            watch = json.loads(ScheduledWorkflowService.eventTrigger(t.get('watch')))
        except InvalidArgumentException as e:
            bad(str(e))
        if watch['server'] not in c['mcp_servers']:
            bad(f'MCP server "{watch["server"]}" is not one of this component\'s servers.')
        exit = php_strval(t.get('work_exit') if t.get('work_exit') is not None else '')
        if exit not in c['exits']:
            bad(f'Exit "{exit}" is not one of this component\'s exits.')
        # a save without the key (the editor's option dialog) keeps the stored list; an explicit one, [] too, replaces it
        if 'pass_args' in t:
            passArgs = t['pass_args']
        else:
            stored = (c.get('start_trigger') or {}).get('pass_args')
            passArgs = stored if stored is not None else []
        if passArgs == {}:
            passArgs = []
        if not isinstance(passArgs, list) or len(passArgs) > cls.PASS_ARGS_MAX:
            bad(f'pass_args must be a list of at most {cls.PASS_ARGS_MAX} argument names.')
        for p in passArgs:
            if not isinstance(p, str) or not _PASS_ARG.match(p):
                bad('pass_args names are letters, digits and _, not starting with a digit (got ' + php_json_encode(p) + ').')
        return {'label': label, 'watch': watch, 'work_exit': exit, 'pass_args': passArgs}

    @staticmethod
    def _row(r: dict, robotId: int | None = None) -> dict:
        st = r.get('start_trigger')
        return {'id': php_intval(r['id']), 'is_robot': robotId is not None and php_intval(r.get('user_id')) == robotId, 'name': php_strval(r['name']),
                'description': php_strval(r.get('description') if r.get('description') is not None else ''),
                'code': php_strval(r['code']), 'exits': php_json_decode(php_strval(r['exits'])) or [],
                'mcp_servers': php_json_decode(php_strval(r['mcp_servers'])) or [], 'timeout_s': php_intval(r['timeout_s']),
                'start_trigger': php_json_decode(php_strval(st)) if php_strval(st if st is not None else '') not in ('', '0') else None,
                'args': _decode(r.get('args')) or [],
                'provides': _decode(r.get('provides')) or [],
                'updated_at': r['updated_at']}
