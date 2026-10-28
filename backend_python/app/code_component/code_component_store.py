"""Port of backend/src/CodeComponent/CodeComponentStore.php.

The code components collection: the only code that touches `code_components`. A component is a
code node's body (code, exits, MCP servers, timeout) under a name unique per user; workflow code
nodes link to it by config.code_component_id. Owner-scoped throughout.
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
    COLS = 'id, name, description, code, exits, mcp_servers, timeout_s, start_trigger, args, provides, updated_at'
    LABEL_MAX = 60
    PASS_ARGS_MAX = 20
    DECLS_MAX = 20

    def __init__(self, db):
        self.db = db

    def list(self, userId: int) -> list[dict]:
        rows = [self._row(r) for r in self.db.fetch_all(
            'SELECT ' + self.COLS + ' FROM code_components WHERE user_id = ? ORDER BY name', [userId])]
        for r in rows:
            r['used_by'] = len(self.usedBy(userId, r['id']))
        return rows

    def get(self, userId: int, id: int) -> dict | None:
        r = self.db.fetch_one('SELECT ' + self.COLS + ' FROM code_components WHERE id = ? AND user_id = ?', [id, userId])
        return None if r is None else self._row(r)

    def getByName(self, userId: int, name: str) -> dict | None:
        r = self.db.fetch_one('SELECT ' + self.COLS + ' FROM code_components WHERE name = ? AND user_id = ?', [name, userId])
        return None if r is None else self._row(r)

    def save(self, userId: int, id: int | None, data: dict) -> dict:
        """Create (id None; an existing name updates that row, as agents do) or update by id."""
        c = self._validate(data)
        before = None if id is None else self.get(userId, id)
        if id is not None and before is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
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
            lost = self.droppedLinks(userId, id, before['exits'], c['exits'])
            if lost:
                what = [f'"{l["exit"]}" on {l["node_name"]} in "{l["workflow_name"]}"' for l in lost]
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
                    self._remapExits(userId, id, before['exits'], c['exits'])
                if outer:
                    self.db.commit()
            except BaseException:
                if outer:
                    self.db.rollback()
                raise
        return self.get(userId, id)

    def delete(self, userId: int, id: int) -> None:
        c = self.get(userId, id)
        if c is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        if c['start_trigger'] is not None:
            raise CodeComponentError('is_option', 'This code component is a Start option: remove the option first.', 409)
        used = self.usedBy(userId, id)
        if used:
            names = [f'node "{n["node_name"]}" in workflow "{n["workflow_name"]}"' for n in used]
            raise CodeComponentError('in_use', 'This code component is used by ' + ', '.join(names) + '.', 409)
        self.db.execute('DELETE FROM code_components WHERE id = ? AND user_id = ?', [id, userId])

    def setStartTrigger(self, userId: int, id: int, trigger: dict) -> dict:
        """Make the component a Start option (spec §1); the trigger is validated against the component."""
        c = self.get(userId, id)
        if c is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        t = self._validateStartTrigger(c, trigger)
        outer = not _in_tx(self.db)
        if outer:
            self.db.begin()
        try:
            self.db.execute('UPDATE code_components SET start_trigger = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
                            [_json_unescaped(t), id, userId])
            # the schedules already on this option carry a copy of its watch: an edit reaches them too
            watch = php_json_decode(_json_unescaped(t['watch']))
            rows = self.db.fetch_all('SELECT id, workflow_id FROM scheduled_workflows WHERE user_id = ? AND trigger_component_id = ?',
                                     [userId, id])
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
        return self.get(userId, id)

    def startTriggerImpact(self, userId: int, id: int) -> list[dict]:
        """The user's workflows on this option: their schedule runs on it, or their Start shows its exits."""
        rows = self.db.fetch_all('SELECT DISTINCT s.workflow_id, w.name FROM scheduled_workflows s\n'
                                 '            JOIN agent_workflows w ON w.id = s.workflow_id\n'
                                 '            WHERE s.user_id = ? AND s.trigger_component_id = ?', [userId, id])
        names: dict[int, str] = {}
        for r in rows:
            names[php_intval(r['workflow_id'])] = php_strval(r['name'])
        for n in self._linkedNodes(userId, id):
            if n['is_start']:
                names[n['workflow_id']] = n['workflow_name']
        ordered = sorted(names.items(), key=lambda kv: kv[1])   # asort: by name, keys kept
        return [{'workflow_id': wid, 'workflow_name': name} for wid, name in ordered]

    def clearStartTrigger(self, userId: int, id: int) -> list[dict]:
        """Remove the option: its schedule rows are deleted (a 'none' row would still run once at its time) and the
        component stops being an option. Start nodes on it go back to one port (revertStarts); linked code nodes stay."""
        c = self.get(userId, id)
        if c is None:
            raise CodeComponentError('not_found', f'Code component #{id} not found', 404)
        impact = self.startTriggerImpact(userId, id)
        outer = not _in_tx(self.db)
        if outer:
            self.db.begin()
        try:
            self.db.execute('DELETE FROM scheduled_workflows WHERE user_id = ? AND trigger_component_id = ?', [userId, id])
            if c['start_trigger'] is not None:
                self._revertStarts(userId, id, c['exits'], c['start_trigger']['work_exit'])
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

    def usedBy(self, userId: int, id: int) -> list[dict]:
        """The user's workflow code nodes that link to the component, and the Start nodes on its option."""
        return [{k: v for k, v in n.items() if k not in ('node_id', 'is_start')} for n in self._linkedNodes(userId, id)]

    def _linkedNodes(self, userId: int, id: int) -> list[dict]:
        """usedBy plus each node's workflow_nodes.id."""
        # The link lives in the node's config JSON: decoded here, so the query stays portable (MySQL and SQLite).
        rows = self.db.fetch_all('SELECT n.id AS node_id, n.node_type, n.config, w.id AS workflow_id, w.name AS workflow_name\n'
                                 '            FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id\n'
                                 '            WHERE w.user_id = ? ORDER BY w.name, n.id', [str(userId)])
        nodes = []
        for r in rows:
            cfg = _decode(r['config'])
            linked = cfg.get('code_component_id') if isinstance(cfg, dict) else None
            code = self.isCodeNode(r['node_type'], cfg) and php_intval(linked if linked is not None else 0) == id
            start = (not code and isinstance(cfg, dict)
                     and StartOptionGraph.optionId({'node_type': r['node_type'], 'config': cfg}) == id)
            if code or start:
                name = cfg.get('name') if isinstance(cfg, dict) and cfg.get('name') is not None else 'Code'
                nodes.append({'workflow_id': php_intval(r['workflow_id']), 'workflow_name': php_strval(r['workflow_name']),
                              'node_name': 'Start' if start else php_strval(name), 'node_id': php_intval(r['node_id']),
                              'is_start': start})
        return nodes

    def droppedLinks(self, userId: int, id: int, oldExits: list, newExits: list) -> list[dict]:
        """The links an exit change would remove (remapExits' rules): [{workflow_id, workflow_name, node_name, exit,
        count}], one per linked node and removed exit that has links. Collapsing to one exit removes none."""
        if len(newExits) == 1 or len(oldExits) == 1:
            return []
        lost = []
        for node in self._linkedNodes(userId, id):
            for k, exit in enumerate(oldExits):
                if exit in newExits:
                    continue
                n = self.db.fetch_column('SELECT COUNT(*) FROM workflow_edges WHERE from_node_id = ? AND from_port = ?',
                                         [node['node_id'], f'output_{k + 1}'])
                n = php_intval(n[0] if n else 0)
                if n > 0:
                    lost.append({'workflow_id': node['workflow_id'], 'workflow_name': node['workflow_name'],
                                 'node_name': node['node_name'], 'exit': exit, 'count': n})
        return lost

    def _revertStarts(self, userId: int, id: int, exits: list, workExit: str) -> None:
        """Start nodes on the option go back to a plain Start: one port, holding the work exit's links; the other
        exits' links are removed, and so is config.start_option."""
        work = 'output_' + str((exits.index(workExit) if workExit in exits else 0) + 1)
        for node in self._linkedNodes(userId, id):
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

    def _remapExits(self, userId: int, id: int, oldExits: list, newExits: list) -> None:
        """Edges are stored by port index (output_k = exit k), so an exit change moves each linked node's
        edges BY NAME, as the editor's CodeNode.remapExits does: a surviving exit keeps its edges on its
        new port, a removed exit's edges go; one exit left moves every edge onto output_1 (duplicates
        dropped); one exit before lands on output_1 unless its name survives. Ports beyond the old exits
        are left alone."""
        for node in self._linkedNodes(userId, id):
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
    def _row(r: dict) -> dict:
        st = r.get('start_trigger')
        return {'id': php_intval(r['id']), 'name': php_strval(r['name']),
                'description': php_strval(r.get('description') if r.get('description') is not None else ''),
                'code': php_strval(r['code']), 'exits': php_json_decode(php_strval(r['exits'])) or [],
                'mcp_servers': php_json_decode(php_strval(r['mcp_servers'])) or [], 'timeout_s': php_intval(r['timeout_s']),
                'start_trigger': php_json_decode(php_strval(st)) if php_strval(st if st is not None else '') not in ('', '0') else None,
                'args': _decode(r.get('args')) or [],
                'provides': _decode(r.get('provides')) or [],
                'updated_at': r['updated_at']}
