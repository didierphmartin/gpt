"""Port of backend/src/AgentTeam/Services/LangGraphPackage.php.

The files that make a modular LangGraph package run on its own (spec 2026-10-15 §5): requirements.txt,
.env.example, README.md, the code-node harness, each used skill's folder and the Start's documents. The
code of every code node is a file of its own (codeFile()), read by the package at each run.

A file entry is {path, code}; a file that is not valid UTF-8 is {path, code (base64), encoding: "base64"}
so it travels in the JSON manifest and is written back as bytes.
"""
from __future__ import annotations

import base64
import os
import re

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.lang_graph_runtime import CODE_HARNESS_PATH
from app.agent_team.services.package_docs import PackageDocs
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.python_requirements import PythonRequirements
from app.agent_team.services.start_document_store import StartDocumentStore


def _unique(items: list) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


class LangGraphPackage:
    # What every LangGraph program imports (the single file; a package's workflow, common and agents).
    BASE_REQUIREMENTS = ['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx',
                         'pydantic', 'python-dotenv']
    # A package's run server (api.py; an A2A agent server serves with uvicorn too).
    SERVER_REQUIREMENTS = ['fastapi', 'uvicorn']
    # The A2A package: its agents are A2A servers, its orchestrator their client.
    A2A_REQUIREMENTS = ['a2a-sdk[http-server]']
    # Providers whose LLM factory branch imports a package beyond the base ones.
    PROVIDER_REQUIREMENTS = {'gemini': 'langchain-google-genai', 'google': 'langchain-google-genai'}
    SKIP_NAMES = ['__pycache__', '.DS_Store']
    # The swarm package's workflow.py builds its graph with create_swarm() (langgraph_swarm).
    SWARM_REQUIREMENTS = ['langgraph-swarm']
    # The TO RUN install line of a package's files: the package's requirements.txt holds the list.
    PIP_REQUIREMENTS = 'pip install -r requirements.txt'
    # TO RUN note: the document converter's packages are imported only for an attachment of that format.
    OPTIONAL_FORMATS_NOTE = ['# optional, only for the attachment formats you use:',
                             '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)']

    @staticmethod
    def defaultSkillsRoot() -> str:
        """Where the editor keeps the skill folders: the default skills root of the generator."""
        home = os.environ.get('HOME') or os.path.expanduser('~')
        return home + '/Documents/synergyAI/skills'

    @classmethod
    def files(cls, facts: dict, skillsRoot: str, documents=None) -> list:
        """The package's own files (the code modules, agents and code/ files are the generator's)."""
        skills = cls.skillFiles(facts, skillsRoot)
        out = cls._docFiles(facts, 'modular', skills,
                            str(facts['safeName']) + ('_modular_swarm' if 'swarm' in facts else '_modular'), 'workflow.py')
        if facts.get('codeData'):
            try:
                with open(CODE_HARNESS_PATH, encoding='utf-8', newline='') as f:
                    harness = f.read()
            except OSError:
                raise RuntimeError('code node harness not found (frontend/assets/py/code_node_harness.py)')
            out.append({'path': 'code_harness.py', 'code': harness})
        for f in skills:
            out.append(f['entry'])
        for f in cls.startDocuments(facts.get('startDocuments') or [], documents)['files']:
            out.append(f)
        return out

    @staticmethod
    def codeFile(nid: str, cd: dict, isTrigger: bool) -> dict:
        """One code node's code as a package file: code/start_<slug>.py for the Start option's trigger,
        else code/<nid>_<slug>.py; the source verbatim."""
        slug = CodeNodeEmit.slug(str(cd.get('display') if cd.get('display') is not None else 'code'))
        slug = slug.strip('_') if slug.strip('_') != '' else 'code'
        return {'path': 'code/' + ('start' if isTrigger else nid) + f'_{slug}.py', 'code': str(cd['source'])}

    @classmethod
    def startDocuments(cls, docs: list, documents=None) -> dict:
        """The Start's documents as package files, and the START_DOCUMENTS entries pointing at them. Only a
        document in the requesting user's own storage is copied (documents: a StartDocumentStore; none
        without one); any other entry is left as it is."""
        files = []
        out = []
        taken = set()
        for i, doc in enumerate(docs):
            data = documents.read(doc) if isinstance(doc, dict) and documents is not None else None
            if data is None:
                out.append(doc)
                continue
            name = os.path.basename(str(doc['path']))
            if name in taken:
                name = f'{i}_{name}'
            taken.add(name)
            files.append(cls._entry(f'start_documents/{name}', data))
            # The copy is the document now: no field keeps pointing at where it came from.
            doc = {k: v for k, v in doc.items() if k not in ('fullPath', 'localUri')}
            doc['path'] = f'start_documents/{name}'
            out.append(doc)
        return {'files': files, 'docs': out}

    @staticmethod
    def _entry(path: str, data) -> dict:
        """{path, code} for text (valid UTF-8), {path, code: base64, encoding: base64} otherwise."""
        raw = data if isinstance(data, bytes) else str(data).encode('utf-8')
        try:
            return {'path': path, 'code': raw.decode('utf-8')}
        except UnicodeDecodeError:
            return {'path': path, 'code': base64.b64encode(raw).decode('ascii'), 'encoding': 'base64'}

    @staticmethod
    def skillDirs(facts: dict) -> list:
        """The skill folders the agents bind ({'dir': d}), in first-use order."""
        dirs: dict = {}
        for ad in (facts.get('agentData') or {}).values():
            for s in ad.get('skills') or []:
                if isinstance(s, dict) and s.get('dir') is not None and str(s['dir']) != '':
                    dirs[str(s['dir'])] = True
        return list(dirs.keys())

    @classmethod
    def skillFiles(cls, facts: dict, skillsRoot: str) -> list:
        """Every file of every used skill folder (skipping __pycache__, .DS_Store, *.pyc, .env*, dot-directories), sorted."""
        out = []
        root = os.path.realpath(skillsRoot) if os.path.exists(skillsRoot) else None
        for d in cls.skillDirs(facts):
            # dir_name comes from the client-saved node config: plain segments, none starting with ".",
            # resolved inside the root.
            segments = StartDocumentStore.safeSegments(d)
            safe = segments is not None and not [s for s in segments if s.startswith('.')]
            cand = os.path.join(root, d) if (safe and root is not None) else None
            base = os.path.realpath(cand) if cand is not None and os.path.exists(cand) else None
            if base is None or not base.startswith(root + os.sep) or not os.path.isdir(base):
                raise RuntimeError(f'Skill folder "{d}" is not available on this server, so it can\'t be packaged.')
            found = []
            for dirpath, dirnames, filenames in os.walk(base):   # RecursiveDirectoryIterator does not enter a symlinked folder
                dirnames[:] = [n for n in dirnames if n not in cls.SKIP_NAMES and not n.endswith('.pyc')
                               and not n.startswith('.env') and not n.startswith('.')]
                for fn in filenames:
                    if fn in cls.SKIP_NAMES or fn.endswith('.pyc') or fn.startswith('.env'):
                        continue
                    p = os.path.join(dirpath, fn)
                    real = os.path.realpath(p) if os.path.isfile(p) else None
                    # A file is copied only if it really lives in the skill folder (a symlink may point elsewhere).
                    if real is not None and real.startswith(base + os.sep):
                        found.append(p[len(base) + 1:])
            found.sort(key=lambda s: s.encode('utf-8'))
            for rel in found:
                with open(os.path.join(base, rel), 'rb') as fh:
                    data = fh.read()
                out.append({'dir': d, 'rel': rel, 'bytes': data, 'entry': cls._entry(f'skills/{d}/{rel}', data)})
        return out

    @staticmethod
    def skillDependencies(skillMd) -> list:
        """`dependencies:` of a SKILL.md's frontmatter, parsed as SkillRuntime.ensure_deps parses it."""
        if isinstance(skillMd, bytes):
            skillMd = skillMd.decode('utf-8', errors='replace')
        lines = re.split(r'\r\n|\r|\n', skillMd)
        if not lines or lines[0].strip(' \t\n\r\0\x0b') != '---':
            return []
        for line in lines[1:]:
            s = line.strip(' \t\n\r\0\x0b')
            if s == '---':
                break
            if s.lower().startswith('dependencies:'):
                val = s.split(':', 1)[1].strip(' \t\n\r\0\x0b').strip('[]')
                deps = []
                for d in val.split(','):
                    d = d.strip(' \t\n\r\0\x0b').strip("'").strip('"')
                    if d != '':
                        deps.append(d)
                return deps
        return []

    @staticmethod
    def _providers(facts: dict) -> list:
        p: dict = {}
        for d in list((facts.get('agentData') or {}).values()) + list((facts.get('playbookData') or {}).values()):
            if (d.get('provider') or '') != '':
                p[str(d['provider']).lower()] = True
        return list(p.keys())

    @classmethod
    def requirementNames(cls, facts: dict, layout: str, skillFiles: list | None = None) -> list:
        """The packages a LangGraph program of layout ('single' | 'modular' | 'a2a') imports: the one list its
        requirements.txt, its TO RUN install line and its README come from. skillFiles: the skills the package
        carries (their SKILL.md dependencies); a program that reads its skills from the editor's folder
        installs their dependencies at the first run instead."""
        req = list(cls.BASE_REQUIREMENTS)
        if layout != 'single':
            req += cls.SERVER_REQUIREMENTS
        if layout == 'a2a':
            req += cls.A2A_REQUIREMENTS
        if 'swarm' in facts:
            req += cls.SWARM_REQUIREMENTS
        for p in cls._providers(facts):
            if p in cls.PROVIDER_REQUIREMENTS:
                req.append(cls.PROVIDER_REQUIREMENTS[p])
        for f in skillFiles or []:
            if f['rel'] == 'SKILL.md':
                req += cls.skillDependencies(f['bytes'])
        req += PythonRequirements.documentNames(facts.get('startDocuments') or [])
        return req

    @classmethod
    def pipInstall(cls, facts: dict, layout: str) -> str:
        """The TO RUN install line of a layout program that has no requirements.txt beside it (the single file)."""
        return PythonRequirements.pipInstall(cls.requirementNames(facts, layout))

    @classmethod
    def singleFiles(cls, facts: dict, filename: str) -> list:
        """The files a single-file export carries beside <name>_langgraph.py: requirements.txt, .env.example and
        README.md (the script reads the .env next to it first)."""
        return cls._docFiles(facts, 'single', [], re.sub(r'\.py$', '', filename), filename)

    @classmethod
    def a2aFiles(cls, facts: dict, layout: dict) -> list:
        """requirements.txt, .env.example and README.md of the A2A package (layout: a2aLayout())."""
        return cls._docFiles({'a2aAgents': layout['agents'], **facts}, 'a2a', [], str(layout['root']), 'orchestrator.py')

    @classmethod
    def _docFiles(cls, facts: dict, layout: str, skillFiles: list, folder: str, entry: str) -> list:
        return [
            {'path': 'requirements.txt', 'code': PythonRequirements.txt(cls.requirementNames(facts, layout, skillFiles))},
            {'path': '.env.example', 'code': PackageDocs.envExample(str(facts['wfName']), cls.envVariables(facts),
                                                                    cls._optionalEnv(facts, layout))},
            {'path': 'README.md', 'code': cls._readme(facts, layout, folder, entry)},
        ]

    @classmethod
    def envVariables(cls, facts: dict) -> dict:
        """The environment the program reads that .env must provide (PackageDocs' vars)."""
        keys: dict = {}
        for p in cls._providers(facts):
            k = PythonEmitHelpers.providerKeyEnv(p)
            if k is not None:
                keys.setdefault(k, []).append(p)
        decision: dict = {}
        for ad in (facts.get('agentData') or {}).values():
            for c in (ad.get('decision') or []) if ad.get('dispatch') else []:
                decision[str(c['key_env'])] = str(c['url_env'])
        return {'keys': keys, 'decision': decision, 'mcp': facts.get('serverSlugs') or {}}

    @classmethod
    def _optionalEnv(cls, facts: dict, layout: str) -> list:
        """The optional variables a layout program reads, as .env.example lists them: [what it does, KEY=example]."""
        o = [["One model for every node, instead of each node's own", 'MODEL_NAME=']]
        if layout == 'single':
            o.append(['Where saved outputs go (default: outputs/ next to the script)', 'SYNERGYAI_OUTPUT_ROOT=./outputs'])
        elif layout == 'a2a':
            o.append(['Where saved outputs go (default: ~/Documents/synergyAI/outputs)', 'SYNERGYAI_OUTPUT_ROOT=/path/to/outputs'])
        else:
            o.append(['Where saved outputs go (default: outputs/ in this folder)', 'SYNERGYAI_OUTPUT_ROOT=./outputs'])
        if layout != 'a2a' and 'swarm' not in facts:   # a swarm and the A2A orchestrator write no run logs
            o.append(['Where run logs go (default: runs/ next to the script)' if layout == 'single'
                      else 'Where run logs go (default: runs/ in this folder)', 'RUNS_DIR=./runs'])
        if cls.skillDirs(facts):
            o.append(['Where the skills are read from (default: skills/ in this folder)', 'SYNERGYAI_SKILLS_DIR=./skills']
                     if layout == 'modular'
                     else ['Where the skills are read from (default: ' + PackageDocs.EDITOR_SKILLS_DIR + ')', 'SYNERGYAI_SKILLS_DIR=/path/to/skills'])
        if layout == 'a2a':
            o.append(['First port of the agent servers, one per agent in order (default: 8701)', 'A2A_BASE_PORT=8701'])
        return o

    @classmethod
    def _readme(cls, facts: dict, layout: str, folder: str, entry: str) -> str:
        """README.md: what the folder is, install, configure, the run modes, files written, run server, service, code nodes."""
        name = str(facts['wfName'])
        swarm = 'swarm' in facts
        skills = cls.skillDirs(facts)
        if layout == 'single':
            intro = ['A LangGraph program compiled from the SynergyAI workflow editor, as one Python file: `' + entry + '`.',
                     'It runs on its own: no database, no SynergyAI server.']
        elif layout == 'a2a':
            intro = ['A LangGraph program compiled from the SynergyAI workflow editor, as A2A agents: each agent node is an',
                     'A2A server of its own (`agents/`), and `orchestrator.py` runs the workflow over them. It runs on its own:',
                     'no database, no SynergyAI server.']
        elif swarm:
            intro = ['A LangGraph swarm compiled from the SynergyAI workflow editor: its agents (`agents/`, one file each) hand',
                     'the conversation to one another. It runs on its own: no database, no SynergyAI server. Everything it needs',
                     'is in this folder.']
        else:
            intro = ['A LangGraph program compiled from the SynergyAI workflow editor, with each node in a file of its own',
                     '(`agents/`). It runs on its own: no database, no SynergyAI server. Everything it needs is in this folder.']
        if layout != 'modular':
            intro += PackageDocs.editorSkillsNote(skills)
        L = PackageDocs.head(name, intro, folder, cls.envVariables(facts))
        L.append('## Run')
        L.append('')
        L.append('Run these from the folder, with the environment active.')
        L.append('')
        if layout == 'a2a':
            cron = facts.get('defaultCron')
            L.append('```sh')
            L.append('python orchestrator.py "your prompt"   # one run on the text (no text: the Start node\'s prompt)')
            L.append('python orchestrator.py --cron [EXPR]   # a run on each tick of a 5-field cron schedule, until stopped')
            L.append('```')
            L.append('')
            L.append(f"Without EXPR, `--cron` uses the Start node's schedule (`{cron}`)." if cron is not None
                     else '`--cron` needs EXPR: the Start node has no schedule.')
            L.append('Text goes before `--cron` (after it, it is read as the cron expression). Ctrl-C (or SIGTERM) stops the loop.')
            L.append('')
            L += cls._a2aAgentLines(facts.get('a2aAgents') or {})
        else:
            L += PackageDocs.modes(entry, 'prompt' if swarm else str(facts['startMode'] if facts.get('startMode') is not None else 'prompt'),
                                   facts.get('defaultCron'), None if swarm else facts.get('defaultWatch'), not swarm)
        L.append('## Files written')
        L.append('')
        here = 'next to the script' if layout == 'single' else 'in this folder'
        L.append('- `~/Documents/synergyAI/outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).'
                 if layout == 'a2a'
                 else f'- `outputs/` {here} -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).')
        if layout != 'a2a' and not swarm:
            L.append(f'- `runs/` {here} -- one `<date>_<run id>.jsonl` event log per run, and `runs/current` (`RUNS_DIR` overrides).')
            L.append('  A run with nothing to do leaves no file.')
        L.append('')
        if layout == 'a2a':
            L += PackageDocs.runServer(False, ['The agent servers start with its first run and stop when it exits.'])
        elif layout == 'modular':
            L += PackageDocs.runServer(not swarm)
        if layout == 'a2a':
            cron = facts.get('defaultCron') is not None
            L += PackageDocs.service(name, 'LangGraph', folder, entry, '--cron' if cron else '', 'cron' if cron else 'prompt')
        else:
            L += PackageDocs.service(name, 'LangGraph', folder, entry, '', 'prompt' if swarm else str(facts['startMode'] if facts.get('startMode') is not None else 'prompt'))
        if layout == 'modular' and facts.get('codeData'):
            L.append('## Editing code nodes')
            L.append('')
            L.append("Each code node runs its file in `code/` (`code/start_<name>.py` is the Start option's code).")
            L.append('The file is read at each run: an edit takes effect on the next run, with no recompile. The code')
            L.append('runs under the same rules as in the editor (`code_harness.py`): standard library only, network')
            L.append("only through `call_tool`, one of the node's exits, its timeout.")
            L.append('')
        return '\n'.join(L).rstrip('\n') + '\n'

    @staticmethod
    def _a2aAgentLines(agents: dict) -> list:
        """The A2A agent servers: what starts them, their files and default URLs. agents: a2aLayout()['agents']."""
        L = []
        L.append('### Agent servers')
        L.append('')
        L.append('The orchestrator starts every agent server at launch and stops them when it ends. `--keep-serving` leaves')
        L.append('them running; `--no-spawn` starts none and uses servers already running, each at its `A2A_AGENT_<id>_URL`')
        L.append('(default below; `A2A_BASE_PORT` moves the whole range).')
        L.append('')
        L.append('| Node | File | Default URL |')
        L.append('|---|---|---|')
        for nid, e in agents.items():
            L.append(f"| {e['display']} ({nid}) | `{e['file']}` | http://127.0.0.1:{e['port']}/ |")
        L.append('')
        if agents:
            first = next(iter(agents.values()))
            L.append(f"To start one by hand: `python {first['file']} --port {first['port']}` (`--host` sets the interface).")
            L.append('')
        return L
