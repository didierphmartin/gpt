"""Port of backend/src/AgentTeam/Services/CompiledPackage.php.

The files that make a compiled ADK, MAF or NOOA package run on its own, in its own folder, as LangGraph's
modular package does: requirements.txt, .env.example, README.md, the code-node harness (code_harness.py),
each code node's code (code/), each used skill's folder (skills/) and the Start's documents
(start_documents/). workflow.py, common.py and api.py are the target generator's.
"""
from __future__ import annotations

import os
import re

from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.lang_graph_runtime import CODE_HARNESS_PATH
from app.agent_team.services.playbook_emit import PlaybookEmit
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.support.phpcompat import php_strval


def _unique(items: list) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


class CompiledPackage:
    # What every package imports besides its framework: the MCP client, .env, the run server.
    BASE_REQUIREMENTS = ['httpx', 'python-dotenv', 'fastapi', 'uvicorn']
    # The document converter's lazy imports, by attachment extension.
    DOCUMENT_REQUIREMENTS = {'pdf': 'pypdf', 'docx': 'mammoth', 'pptx': 'python-pptx', 'xlsx': 'openpyxl'}

    @classmethod
    def files(cls, analyzed: dict, skillsRoot: str, documentFiles: list, framework: list, frameworkTitle: str) -> list:
        """analyzed: the target's analysis, with 'startDocuments' already pointing at start_documents/;
        documentFiles: the start_documents/ entries (LangGraphPackage.startDocuments()['files'])."""
        skills = LangGraphPackage.skillFiles({'agentData': analyzed.get('agents') or {}}, skillsRoot)
        out = [
            {'path': 'requirements.txt', 'code': cls._requirements(analyzed, skills, framework)},
            {'path': '.env.example', 'code': cls._envExample(analyzed)},
            {'path': 'README.md', 'code': cls._readme(analyzed, frameworkTitle)},
        ]
        if analyzed.get('code'):
            try:
                with open(CODE_HARNESS_PATH, encoding='utf-8', newline='') as f:
                    harness = f.read()
            except OSError:
                raise RuntimeError('code node harness not found (frontend/assets/py/code_node_harness.py)')
            out.append({'path': 'code_harness.py', 'code': harness})
            for nid, cd in analyzed['code'].items():
                out.append(LangGraphPackage.codeFile(php_strval(nid), cd, cls._isTrigger(analyzed, php_strval(nid))))
        for f in skills:
            out.append(f['entry'])
        out += list(documentFiles)
        return out

    @classmethod
    def codePath(cls, analyzed: dict, nid: str) -> str:
        """code/<file> of a code node, as files() writes it."""
        return LangGraphPackage.codeFile(nid, analyzed['code'][nid], cls._isTrigger(analyzed, nid))['path']

    @staticmethod
    def _isTrigger(analyzed: dict, nid: str) -> bool:
        """The Start option's hidden code node (StartOptionGraph) carries its trigger in its config."""
        cfg = ((analyzed.get('byId') or {}).get(nid) or {}).get('config')
        return isinstance(cfg, dict) and isinstance(cfg.get('start_trigger'), dict)

    @staticmethod
    def _providers(analyzed: dict) -> list:
        p: dict = {}
        for d in list((analyzed.get('agents') or {}).values()) + list((analyzed.get('playbooks') or {}).values()):
            if (d.get('provider') or '') != '':
                p[php_strval(d['provider']).lower()] = True
        return list(p.keys())

    @classmethod
    def _requirements(cls, analyzed: dict, skillFiles: list, framework: list) -> str:
        """requirements.txt: one per line, sorted, unique."""
        req = list(framework) + cls.BASE_REQUIREMENTS
        # A playbook node runs the shared interpreter (langchain-core + langgraph + its provider's package).
        for line in PlaybookEmit.extraDeps(analyzed):
            if line.startswith('pip install '):
                req += re.split(r'\s+', line[len('pip install '):].strip(' \t\n\r\x00\x0b'))
        for f in skillFiles:
            if f['rel'] == 'SKILL.md':
                req += LangGraphPackage.skillDependencies(f['bytes'])
        for doc in analyzed.get('startDocuments') or []:
            path = php_strval((doc.get('path') if doc.get('path') is not None else doc.get('name')) or '') if isinstance(doc, dict) else ''
            base = os.path.basename(path)
            ext = base.rsplit('.', 1)[1].lower() if '.' in base else ''
            if ext in cls.DOCUMENT_REQUIREMENTS:
                req.append(cls.DOCUMENT_REQUIREMENTS[ext])
        req = sorted(_unique(req), key=lambda s: s.encode('utf-8'))
        return '\n'.join(req) + '\n'

    @classmethod
    def _envExample(cls, analyzed: dict) -> str:
        """.env.example: every variable the program reads, commented."""
        L = ['# Environment of the workflow "' + php_strval(analyzed['workflow']['name']) + '" -- copy this file to .env and fill it in.',
             '# The program reads .env from its own folder first, then from the folder two levels up',
             "# (a local runner's .env). A variable already set in the environment is never overridden.",
             '']
        keys: dict = {}
        for p in cls._providers(analyzed):
            k = PythonEmitHelpers.providerKeyEnv(p)
            if k is not None:
                keys.setdefault(k, []).append(p)
        if keys:
            L.append('# API keys of the LLM providers this workflow uses')
            for k, provs in keys.items():
                L.append('# ' + ', '.join(_unique(provs)))
                L.append(f'# {k}=')
        else:
            L.append('# No LLM provider is used by a node of this workflow.')
        L.append('')
        decision: dict = {}
        for d in (analyzed.get('decisions') or {}).values():
            for c in d['decision']:
                decision[php_strval(c['key_env'])] = php_strval(c['url_env'])
        if decision:
            L.append('# Decision models the dispatchers may route with (each URL variable is optional: a gateway)')
            for key, url in decision.items():
                L.append(f'# {key}=')
                L.append(f'# {url}=')
            L.append('')
        slugs = analyzed.get('serverSlugs') or {}
        if slugs:
            L.append('# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)')
            for url, slug in slugs.items():
                up = php_strval(slug).upper()
                L.append(f'MCP_URL_{up}={url}')
                L.append('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}')
                L.append(f'# MCP_HEADERS_{up}=')
            L.append('')
        L.append('# Optional')
        L.append('# Where saved outputs go (default: outputs/ in this folder)')
        L.append('# SYNERGYAI_OUTPUT_ROOT=./outputs')
        if LangGraphPackage.skillDirs({'agentData': analyzed.get('agents') or {}}):
            L.append('# Where the skills are read from (default: skills/ in this folder)')
            L.append('# SYNERGYAI_SKILLS_DIR=./skills')
        return '\n'.join(L) + '\n'

    @staticmethod
    def _readme(analyzed: dict, frameworkTitle: str) -> str:
        """README.md: what the folder is, install, configure, run, serve."""
        name = php_strval(analyzed['workflow']['name'])
        L = [f'# {name}', '',
             f'A {frameworkTitle} program compiled from the SynergyAI workflow editor. It runs on its own: no database,',
             'no SynergyAI server. Everything it needs is in this folder.', '',
             '## Install', '', '```sh',
             'python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt',
             'cp .env.example .env   # then fill in the API keys and MCP headers',
             '```', '', '## Run', '', '```sh',
             'python workflow.py "your prompt"   # one run (no text: the Start node\'s prompt)',
             "python api.py --port 8000          # the run server SynergyAI's editor talks to",
             '```', '', '## Files', '',
             '- `workflow.py` -- the workflow: one node of the canvas per agent / executor, run in the canvas order.',
             '- `api.py`, `common.py` -- the run server.']
        if analyzed.get('code'):
            L.append("- `code/` -- each code node's Python, read at every run (edit it here to change the node).")
            L.append('- `code_harness.py` -- the code-node contract (inputs, exits, declared MCP servers, timeout), as the editor runs it.')
        if LangGraphPackage.skillDirs({'agentData': analyzed.get('agents') or {}}):
            L.append('- `skills/` -- the skills the agents run.')
        if analyzed.get('startDocuments'):
            L.append('- `start_documents/` -- the documents attached to the Start node.')
        L.append('- `outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).')
        return '\n'.join(L) + '\n'
