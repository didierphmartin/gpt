"""Port of backend/src/AgentTeam/Services/CodeNodeExecutor.php.

Runs one code node server-side: backend/scripts/code_node_run.py in a short-lived python3 process,
the same harness the editor and compiled LangGraph use (the Python backend runs the very same files
the PHP backend does). The node reaches the user's MCP servers it checked, with their stored headers.
Switched off with CODE_NODES_SERVER_SIDE=0.
"""
from __future__ import annotations

import json
import os
import subprocess

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.config import PHP_BACKEND
from app.support.phpcompat import php_bool, php_empty, php_strval, php_trim

RUNNER = PHP_BACKEND / 'scripts' / 'code_node_run.py'
HARNESS_DIR = PHP_BACKEND.parent / 'frontend' / 'assets' / 'py'
# Extra seconds beyond the node's own timeout before the process is killed.
KILL_GRACE_S = 5


def _object(v) -> dict:
    """PHP `(object) $array`: a list becomes an object keyed "0", "1", ..."""
    if isinstance(v, dict):
        return v
    if isinstance(v, list):
        return {str(i): x for i, x in enumerate(v)}
    return {}


class CodeNodeExecutor:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config

    @staticmethod
    def enabled(config: dict) -> bool:
        cn = config.get('code_nodes') if isinstance(config.get('code_nodes'), dict) else {}
        v = cn.get('server_side')
        return php_bool(v if v is not None else True)

    def run(self, node: dict, edges: list, nodeIds: list, userId: str, parents: list, userPrompt: str) -> dict:
        servers = self._servers(userId)
        slugToUrl = {slug: s['url'] for slug, s in servers.items()}
        data = CodeNodeEmit.nodeData(node, edges, slugToUrl, nodeIds)
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        cfgArgs = cfg.get('args')
        request = {
            'source': data['source'], 'exits': data['exits'], 'timeout_s': data['timeout_s'],
            'parents': parents, 'user_prompt': userPrompt, 'name': data['display'],
            'args': _object(cfgArgs if isinstance(cfgArgs, (dict, list)) else {}),
            'arg_decls': data['arg_decls'],
            'servers': {slug: s for slug, s in servers.items() if slug in data['mcp_servers']},
        }
        return {'data': data, 'result': self._spawn(request, data['timeout_s'] + KILL_GRACE_S)}

    def _servers(self, userId: str) -> dict:
        """slug => {url, headers}: enabled global servers plus the user's own; the user's row wins a name clash."""
        rows = self.db.fetch_all(
            'SELECT name, url, headers, user_id FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)',
            [userId]) or []
        rows = sorted(rows, key=lambda r: r.get('user_id') is not None)   # globals first, own overwrite
        out = {}
        for r in rows:
            headers = {}
            if isinstance(r.get('headers'), str):
                try:
                    decoded = json.loads(r['headers'])
                except (ValueError, TypeError):
                    decoded = None
                headers = decoded if decoded else {}
            out[CodeNodeEmit.slug(php_strval(r.get('name')))] = {'url': php_strval(r.get('url')), 'headers': _object(headers)}
        return out

    def _spawn(self, request: dict, killAfterS: int) -> dict:
        cn = self.config.get('code_nodes') if isinstance(self.config.get('code_nodes'), dict) else {}
        python = php_strval(cn.get('python') if cn.get('python') is not None else 'python3')
        if not RUNNER.exists() or not HARNESS_DIR.exists():
            raise RuntimeError('code node runner files are missing (scripts/code_node_run.py, frontend/assets/py)')
        cmd = [python, os.path.realpath(RUNNER), os.path.realpath(HARNESS_DIR)]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError:
            raise RuntimeError(f'could not start {python} for the code node') from None
        payload = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        try:
            stdout, stderr = proc.communicate(payload, timeout=killAfterS)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return {'ok': False, 'error': f'code node timed out after {killAfterS}s (process killed)', 'stdout': '', 'tool_calls': []}
        code = proc.returncode
        out = stdout.decode('utf-8', errors='replace')
        err = stderr.decode('utf-8', errors='replace')
        try:
            result = json.loads(out)
        except ValueError:
            result = None
        if not isinstance(result, (dict, list)):
            why = php_trim(err)
            if php_empty(why):
                why = php_trim(out)
            if php_empty(why):
                why = f'exit code {code}'
            return {'ok': False, 'error': 'code node runner failed: ' + why, 'stdout': '', 'tool_calls': []}
        return result
