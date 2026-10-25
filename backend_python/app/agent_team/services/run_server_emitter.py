"""Port of backend/src/AgentTeam/Services/RunServerEmitter.php -- the run server every compiled target serves.

api.py's runtime half (RunState, the four routes, the SSE stream with its ring buffer and Last-Event-ID
replay, the uvicorn entry point) has no framework in it. Only the module docstring and the import line
differ between targets, so those are the parameters and everything else is shared.
"""
from __future__ import annotations

import re

from app.agent_team.services.compiler_php import j
from app.agent_team.services.compiler_text import run_server_emitter as T
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers


class RunServerEmitter:
    _MAIN = '\n\nif __name__ == "__main__":\n'
    _PARSE = '    a = ap.parse_args()\n'
    _RUN_PROMPT = '    prompt = str((body or {}).get("prompt") or "").strip() or DEFAULT_PROMPT or "Hello"\n'
    _SERVE = '    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")'

    @classmethod
    def emit(cls, workflowName: str, docBody: str, importLine: str, versionLine: str, listen: bool = False) -> str:
        """api.py: docBody is already composed and escaped by the caller; versionLine is the
        `WORKFLOW_VERSION = ...` statement (required: the startup print reads it). listen: the modular
        LangGraph package's server also runs the Start's cron / watch loop."""
        L = ['"""Run server for workflow ' + j(workflowName), '']
        L.extend(docBody.split('\n'))
        L.append('"""')
        L.append('from __future__ import annotations')
        L.append('')
        L.append('import argparse, asyncio, json, os, sys, time, uuid   # sys: _TraceTee swaps stdout for the run')
        L.append('')
        L.append('from fastapi import FastAPI, HTTPException, Request')
        L.append('from fastapi.middleware.cors import CORSMiddleware')
        L.append('from fastapi.responses import StreamingResponse')
        L.append('import uvicorn')
        L.append('')
        L.append('from common import set_event_sink, resolve_gate')
        L.append(importLine)
        if listen:
            L.append('from common import live_next, RUN_OUT, NULL_RECORDER')
            L.append('import workflow as _workflow   # its GRAPH_RECORDER, reset before each served run')
            L.append('from workflow import make_listener, RUNS_DIR, START_MODE, LoopState')
        L.append('')
        L.append(versionLine)
        L.append('')
        L.append(cls._withListen(cls.runtimeBlock()) if listen else cls.runtimeBlock())
        return '\n'.join(L).rstrip('\n') + '\n'

    @classmethod
    def _withListen(cls, runtime: str) -> str:
        """The runtime block with listenBlock() ahead of __main__, --listen in it, and POST /runs refused while listening."""
        anchors = [cls._MAIN, cls._PARSE, cls._SERVE, cls._RUN_PROMPT]
        for anchor in anchors:
            if runtime.count(anchor) != 1:
                raise RuntimeError('runtimeBlock() changed: the listen anchors are gone')
        replacements = [
            '\n\n' + cls.listenBlock() + '\n' + cls._MAIN,
            '    ap.add_argument("--listen", action="store_true",\n'
            + '                    help="also run the Start\'s schedule / event trigger (as POST /listen does)")\n' + cls._PARSE,
            '    if a.listen:\n'
            + '        try:\n'
            + '            _listener().start()\n'
            + '        except ListenRefused as e:\n'
            + '            ap.error(f"--listen: {e}")\n' + cls._SERVE,
            '    _before_served_run()\n' + cls._RUN_PROMPT,
        ]
        for anchor, rep in zip(anchors, replacements):   # str_replace(array, array): each pair in turn
            runtime = runtime.replace(anchor, rep)
        return runtime

    @staticmethod
    def listenBlock() -> str:
        """api.py's listener: the Start's cron / watch loop in a background thread, POST /listen, GET /live."""
        return T.listenBlock__ret

    @classmethod
    def package(cls, single: dict, name: str, suffix: str, docLine: str, common: str | None = None,
                listen: bool = False) -> dict:
        """The whole compiled package for a single-script target (ADK, MAF, NOOA)."""
        return {
            'root': re.sub(r'[^a-z0-9_]+', '_', name.lower(), flags=re.IGNORECASE) + '_' + suffix,
            'files': [
                # A regular `agents/` package elsewhere on sys.path (openai-agents) beats a local namespace
                # portion under PEP 420. Without this marker the emitted package loses to an installed one.
                {'path': '__init__.py', 'code': '\n'},
                {'path': 'workflow.py', 'code': str(single.get('code') or '')},
                {'path': 'common.py', 'code': common if common is not None else cls.commonBlock()},
                {'path': 'api.py', 'code': cls.emit(
                    name,
                    docLine,
                    'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
                    'WORKFLOW_VERSION = "1"',
                    listen,
                )},
            ],
        }

    @staticmethod
    def commonBlock() -> str:
        """A non-LangGraph target's common.py: the event sink and the gate rendezvous."""
        return 'import threading\n\n' + PythonEmitHelpers.eventSinkBlock()

    @staticmethod
    def runtimeBlock() -> str:
        """api.py's runtime half: run state, the four routes, the uvicorn entry point."""
        return T.runtimeBlock__ret
