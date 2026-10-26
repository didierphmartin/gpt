"""Port of backend/src/AgentTeam/Services/CompiledPackage.php.

The files that make a compiled ADK, MAF or NOOA program run on its own, in its own folder, as LangGraph's
packages do: requirements.txt, .env.example, README.md and, for a package, the code-node harness (a copy,
code_harness.py), each code node's code (code/), each used skill's folder (skills/) and the Start's
documents (start_documents/). workflow.py, common.py and api.py are the target generator's.

target names the compile target: {'key': 'adk', 'title': 'Google ADK', 'framework': [package, ...]}
(ADKPackage.TARGET, MAFGenerator.TARGET, NOOAGenerator.TARGET). layout: 'single' | 'modular' | 'a2a'.
"""
from __future__ import annotations

import re

from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.lang_graph_runtime import CODE_HARNESS_PATH
from app.agent_team.services.package_docs import PackageDocs
from app.agent_team.services.playbook_emit import PlaybookEmit
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.python_requirements import PythonRequirements
from app.support.phpcompat import php_strval


def _php_lower(s: str) -> str:
    """strtolower(): ASCII letters only (PHP 8)."""
    return ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in s)


class CompiledPackage:
    # What every compiled program imports besides its framework: the MCP client and .env.
    BASE_REQUIREMENTS = ['httpx', 'python-dotenv']
    # A package's run server (api.py; an A2A agent server serves with uvicorn too).
    SERVER_REQUIREMENTS = ['fastapi', 'uvicorn']
    # The A2A package: its servers are A2A servers, its orchestrator their client.
    A2A_REQUIREMENTS = ['a2a-sdk[http-server]']
    # The TO RUN install line of a package's files: the package's requirements.txt holds the list.
    PIP_REQUIREMENTS = 'pip install -r requirements.txt'

    @classmethod
    def files(cls, analyzed: dict, skillsRoot: str, documentFiles: list, target: dict, layout: str = 'modular') -> list:
        """analyzed: the generator's analysis, with 'startDocuments' already pointing at start_documents/;
        documentFiles: the start_documents/ entries (LangGraphPackage.startDocuments()['files'])."""
        skills = LangGraphPackage.skillFiles({'agentData': analyzed.get('agents') or {}}, skillsRoot)
        out = cls._docFiles(analyzed, target, layout, skills, cls._folder(analyzed, target, layout),
                            'orchestrator.py' if layout == 'a2a' else 'workflow.py')
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
    def singleFiles(cls, analyzed: dict, target: dict, filename: str) -> list:
        """The files a single-file export carries beside its script (filename): requirements.txt, .env.example and
        README.md (the script reads the .env next to it first)."""
        return cls._docFiles(analyzed, target, 'single', [], re.sub(r'\.py$', '', filename), filename)

    @staticmethod
    def _folder(analyzed: dict, target: dict, layout: str) -> str:
        """The folder a layout export unzips to: the package's root, the single file's name."""
        return (re.sub(r'[^a-z0-9_]+', '_', _php_lower(php_strval(analyzed['workflow']['name'])), flags=re.IGNORECASE | re.ASCII)
                + '_' + target['key'] + ('_a2a' if layout == 'a2a' else ''))

    @classmethod
    def _docFiles(cls, analyzed: dict, target: dict, layout: str, skillFiles: list, folder: str, entry: str) -> list:
        return [
            {'path': 'requirements.txt', 'code': PythonRequirements.txt(cls.requirementNames(analyzed, target, layout, skillFiles))},
            {'path': '.env.example', 'code': PackageDocs.envExample(php_strval(analyzed['workflow']['name']), cls.envVariables(analyzed),
                                                                    cls._optionalEnv(analyzed, layout))},
            {'path': 'README.md', 'code': cls._readme(analyzed, target, layout, folder, entry)},
        ]

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
    def requirementNames(cls, analyzed: dict, target: dict, layout: str, skillFiles: list | None = None) -> list:
        """The packages a target program of layout imports: the one list its requirements.txt, its TO RUN install
        line and its README come from. skillFiles: the skills the package carries (their SKILL.md dependencies);
        the single file reads its skills from the editor's folder and installs their dependencies at the first run."""
        req = list(target['framework']) + cls.BASE_REQUIREMENTS
        if layout != 'single':
            req += cls.SERVER_REQUIREMENTS
        if layout == 'a2a':
            req += cls.A2A_REQUIREMENTS
        # A playbook node runs the shared interpreter (langchain-core + langgraph + its provider's package).
        req += PlaybookEmit.requirementNames(analyzed)
        for f in skillFiles or []:
            if f['rel'] == 'SKILL.md':
                req += LangGraphPackage.skillDependencies(f['bytes'])
        req += PythonRequirements.documentNames(analyzed.get('startDocuments') or [])
        return req

    @classmethod
    def pipInstall(cls, analyzed: dict, target: dict) -> str:
        """The single file's TO RUN install line (no requirements.txt beside the script in the editor's scripts/)."""
        return PythonRequirements.pipInstall(cls.requirementNames(analyzed, target, 'single'))

    @classmethod
    def envVariables(cls, analyzed: dict) -> dict:
        """The environment the program reads that .env must provide (PackageDocs' vars)."""
        keys: dict = {}
        for p in cls._providers(analyzed):
            k = PythonEmitHelpers.providerKeyEnv(p)
            if k is not None:
                keys.setdefault(k, []).append(p)
        decision: dict = {}
        for d in (analyzed.get('decisions') or {}).values():
            for c in d['decision']:
                decision[php_strval(c['key_env'])] = php_strval(c['url_env'])
        # Only a playbook node reads MODEL_NAME (PlaybookEmit.supportBlock(), emitted with the playbook nodes).
        return {'keys': keys, 'decision': decision, 'mcp': analyzed.get('serverSlugs') or {},
                'model': "One model for every playbook node, instead of each node's own" if analyzed.get('playbooks') else None}

    @staticmethod
    def _optionalEnv(analyzed: dict, layout: str) -> list:
        """The optional variables a layout program reads, as .env.example lists them: [what it does, KEY=example]."""
        single = layout == 'single'
        o = [['Where saved outputs go (default: ~/Documents/synergyAI/outputs)', 'SYNERGYAI_OUTPUT_ROOT=/path/to/outputs']
             if single else ['Where saved outputs go (default: outputs/ in this folder)', 'SYNERGYAI_OUTPUT_ROOT=./outputs']]
        if not single:
            o.append(['Where workflow.py writes its run logs (default: runs/ in this folder)', 'RUNS_DIR=./runs'])
        if LangGraphPackage.skillDirs({'agentData': analyzed.get('agents') or {}}):
            o.append(['Where the skills are read from (default: ' + PackageDocs.EDITOR_SKILLS_DIR + ')', 'SYNERGYAI_SKILLS_DIR=/path/to/skills']
                     if single else ['Where the skills are read from (default: skills/ in this folder)', 'SYNERGYAI_SKILLS_DIR=./skills'])
        if layout == 'a2a':
            o.append(['First port of the agent servers, one per node in order (default: 8701)', 'A2A_BASE_PORT=8701'])
        return o

    @classmethod
    def _readme(cls, analyzed: dict, target: dict, layout: str, folder: str, entry: str) -> str:
        """README.md: what the folder is, install, configure, the run modes, run server, service, files."""
        from app.agent_team.services.compiled_a2a_emit import CompiledA2AEmit
        name = php_strval(analyzed['workflow']['name'])
        title = str(target['title'])
        skills = LangGraphPackage.skillDirs({'agentData': analyzed.get('agents') or {}})
        if layout == 'single':
            intro = [f'A {title} program compiled from the SynergyAI workflow editor, as one Python file: `{entry}`.',
                     'It runs on its own: no database, no SynergyAI server.']
        elif layout == 'a2a':
            intro = [f'A {title} program compiled from the SynergyAI workflow editor, as A2A agents: each node is an A2A',
                     'server of its own (`servers/`), and `orchestrator.py` runs the workflow over them. It runs on its own: no',
                     'database, no SynergyAI server. Everything it needs is in this folder.']
        else:
            intro = [f'A {title} program compiled from the SynergyAI workflow editor, with each node in a file of its own',
                     '(`agents/`). It runs on its own: no database, no SynergyAI server. Everything it needs is in this folder.']
        if layout == 'single':
            intro += PackageDocs.editorSkillsNote(skills)
        L = PackageDocs.head(name, intro, folder, cls.envVariables(analyzed))
        L.append('## Run')
        L.append('')
        L.append('Run these from the folder, with the environment active.')
        L.append('')
        startMode = php_strval(analyzed['startMode'] if analyzed.get('startMode') is not None else 'prompt')
        if layout == 'single':
            L.append('```sh')
            L.append(f'python {entry} "your prompt"   # one run on the text (no text: the Start node\'s prompt)')
            L.append('```')
            L.append('')
            L.append('The single file makes one run per launch: it has no schedule or event-trigger mode, and no run server.')
            L.append('Export with "agents in separate files" for those.')
            L.append('')
        else:
            if layout == 'a2a':
                L.append('```sh')
                L.append('python orchestrator.py "your prompt"   # one run over the agent servers (no text: the Start node\'s prompt)')
                L.append('```')
                L.append('')
                L += cls._a2aServerLines(CompiledA2AEmit.layout(analyzed))
                L.append('`workflow.py` runs the same workflow in one process, without the agent servers, in any of these modes:')
                L.append('')
            L += PackageDocs.modes('workflow.py', startMode, analyzed.get('defaultCron'), analyzed.get('defaultWatch'), True)
        L.append('## Files written')
        L.append('')
        if layout == 'single':
            L.append('- `~/Documents/synergyAI/outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).')
        else:
            L.append('- `outputs/` in this folder -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).')
            L.append('- `runs/` in this folder -- one `<date>_<run id>.jsonl` event log per run of `workflow.py` (`RUNS_DIR` overrides).')
        L.append('')
        if layout != 'single':
            L += PackageDocs.runServer(layout == 'modular',
                                       ['The agent servers start with its first run and stop when it exits.'] if layout == 'a2a' else [])
            L += PackageDocs.service(name, title, folder, 'workflow.py', '', startMode)
        L.append('## Files')
        L.append('')
        if layout == 'single':
            L.append(f'- `{entry}` -- the whole program: the runtime, one node of the canvas per agent / executor, the CLI.')
        else:
            if layout == 'a2a':
                L.append('- `orchestrator.py` -- walks the canvas, sending each node its input as an A2A task.')
                L.append('- `servers/` -- one A2A agent server per node.')
            L.append('- `workflow.py` -- the workflow: assembles the nodes and runs them; its CLI is above.')
            L.append('- `agents/` -- one module per node; `common.py` -- the runtime they share.')
            L.append('- `api.py` -- the run server.')
        if analyzed.get('code') and layout != 'single':
            L.append("- `code/` -- each code node's Python, read at every run (edit it here to change the node).")
            L.append('- `code_harness.py` -- the code-node contract (inputs, exits, declared MCP servers, timeout), as the editor runs it.')
        if skills and layout != 'single':
            L.append('- `skills/` -- the skills the agents run.')
        if analyzed.get('startDocuments') and layout != 'single':
            L.append('- `start_documents/` -- the documents attached to the Start node.')
        return '\n'.join(L) + '\n'

    @staticmethod
    def _a2aServerLines(servers: dict) -> list:
        """The A2A servers: what starts them, their files and default URLs. servers: CompiledA2AEmit.layout()."""
        L = []
        L.append('The orchestrator starts every agent server at its first run and stops them when it ends. `--keep-serving`')
        L.append('leaves them running; `--no-spawn` starts none and uses servers already running, each at its')
        L.append('`A2A_AGENT_<id>_URL` (default below; `A2A_BASE_PORT` moves the whole range).')
        L.append('')
        L.append('| Node | File | Default URL |')
        L.append('|---|---|---|')
        for nid, e in servers.items():
            L.append(f"| {e['display']} ({nid}) | `{e['file']}` | http://127.0.0.1:{e['port']}/ |")
        L.append('')
        if servers:
            first = next(iter(servers.values()))
            L.append(f"To start one by hand: `python {first['file']} --port {first['port']}` (`--host` sets the interface).")
            L.append('')
        return L
