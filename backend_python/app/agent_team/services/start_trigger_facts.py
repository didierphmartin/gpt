"""Port of backend/src/AgentTeam/Services/StartTriggerFacts.php.

The Start's mode as a compiled program bakes it (spec 2026-10-15 §2): the Start option's trigger node
(the hidden code node StartOptionGraph adds), its event trigger, the workflow's schedule. Read at compile
time only; the program never reads the database.
"""
from __future__ import annotations

import json

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.phpcompat import php_strval, php_trim


class StartTriggerFacts:
    @classmethod
    def of(cls, db, workflowId: int, orderedNodes: list, serverSlugs: dict) -> dict:
        """orderedNodes: nodes in topological order (each with config); serverSlugs: url => slug of the
        servers this workflow uses. Returns {startMode, defaultCron, defaultWatch, triggerNodeId}."""
        triggerNodeId = None
        startTrigger = None
        startArgs: dict | list = []
        for node in orderedNodes:
            cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
            st = cfg.get('start_trigger')
            if WorkflowGraphAnalyzer.typeOf(node) == 'code' and isinstance(st, dict):
                triggerNodeId = php_strval(node['id'])
                startTrigger = st
                a = cfg.get('args')
                startArgs = a if isinstance(a, (dict, list)) else []   # the Start's start_args
                break
        defaultCron = cls._defaultCron(db, workflowId)
        slugs = list(serverSlugs.values())
        return {
            'startMode': 'watch' if startTrigger is not None else ('cron' if defaultCron is not None else 'prompt'),
            'defaultCron': defaultCron,
            'defaultWatch': (cls._optionWatch(startTrigger, startArgs, slugs) if startTrigger is not None
                             else cls._defaultWatch(db, workflowId, slugs)),
            'triggerNodeId': triggerNodeId,
        }

    @staticmethod
    def watchArgs(watchArgs, startArgs, passArgs) -> dict | list:
        """The watch's args with the Start's values merged in at top level (spec 2026-10-22 §6.1): its tag (a
        non-empty string) and each start arg the option names in pass_args (when non-empty). The Start's values
        win; its other args stay the code's ARGS only. Used by the event worker's schedule rows and the compiled
        DEFAULT_WATCH alike."""
        startArgs = startArgs if isinstance(startArgs, dict) else {}
        out = dict(watchArgs) if isinstance(watchArgs, dict) else dict(enumerate(watchArgs or []))
        tag = startArgs.get('tag')
        if isinstance(tag, str) and tag != '':
            out['tag'] = tag
        for name in passArgs:
            v = startArgs.get(name) if isinstance(name, str) else None
            if v is not None and v != '' and v != [] and v != {}:
                out[name] = v
        if out == {} and isinstance(watchArgs, list):
            return watchArgs   # unchanged: PHP's [] stays []
        return out

    @classmethod
    def _optionWatch(cls, startTrigger: dict, startArgs, slugs: list) -> dict | None:
        """A Start option's DEFAULT_WATCH: its trigger's watch with the Start's args merged in (watchArgs)."""
        w = startTrigger.get('watch')
        w = cls._watchFromTrigger(w if isinstance(w, dict) else {}, slugs)
        if w is not None:
            p = startTrigger.get('pass_args') if startTrigger.get('pass_args') is not None else []
            w['args'] = cls.watchArgs(w['args'], startArgs, p if isinstance(p, list) else [])
        return w

    @staticmethod
    def _defaultCron(db, workflowId: int) -> str | None:
        if db is None:
            return None
        try:
            c = db.fetch_column("SELECT cron FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'cron' AND status <> 'paused' ORDER BY id DESC LIMIT 1",
                                [workflowId])
        except Exception:  # noqa: BLE001 -- no schedules table, or one without the cron column: no default
            return None
        c = c[0] if c else None
        return c if isinstance(c, str) and c != '' else None

    @classmethod
    def _defaultWatch(cls, db, workflowId: int, slugs: list) -> dict | None:
        if db is None:
            return None
        try:
            raw = db.fetch_column("SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = ? AND repeat_type = 'event' AND status <> 'paused' ORDER BY id DESC LIMIT 1",
                                  [workflowId])
        except Exception:  # noqa: BLE001 -- no schedules table, or one without the event_trigger column: no default
            return None
        raw = raw[0] if raw else None
        try:
            t = json.loads(raw) if isinstance(raw, str) else None
        except ValueError:
            t = None
        return cls._watchFromTrigger(t, slugs) if isinstance(t, dict) else None

    @staticmethod
    def _watchFromTrigger(t: dict, slugs: list) -> dict | None:
        """{server (a name), tool, args} as DEFAULT_WATCH with the server slugged; a server the workflow does not use is an error."""
        if (php_trim(php_strval(t.get('server') if t.get('server') is not None else '')) == ''
                or php_trim(php_strval(t.get('tool') if t.get('tool') is not None else '')) == ''):
            return None
        slug = CodeNodeEmit.slug(php_strval(t['server']))
        if slug not in slugs:
            raise RuntimeError('The event trigger waits on MCP server "' + php_strval(t['server']) + '", which no node of this'
                               ' workflow uses; check it on the node that polls it (e.g. the code node calling poll_new_mail).')
        args = t.get('args')
        return {'server': slug, 'tool': php_strval(t['tool']), 'args': args if isinstance(args, (dict, list)) else []}
