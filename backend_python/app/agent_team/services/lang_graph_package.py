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
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.start_document_store import StartDocumentStore


def _unique(items: list) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


class LangGraphPackage:
    # What every package imports (workflow, common, api), before provider, skill and document extras.
    BASE_REQUIREMENTS = ['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx',
                         'pydantic', 'python-dotenv', 'fastapi', 'uvicorn']
    # Providers whose LLM factory branch imports a package beyond the base ones.
    PROVIDER_REQUIREMENTS = {'gemini': 'langchain-google-genai', 'google': 'langchain-google-genai'}
    # The document converter's lazy imports, by attachment extension.
    DOCUMENT_REQUIREMENTS = {'pdf': 'pypdf', 'docx': 'mammoth', 'pptx': 'python-pptx', 'xlsx': 'openpyxl'}
    SKIP_NAMES = ['__pycache__', '.DS_Store']
    # The swarm package's workflow.py builds its graph with create_swarm() (langgraph_swarm).
    SWARM_REQUIREMENTS = ['langgraph-swarm']

    @staticmethod
    def defaultSkillsRoot() -> str:
        """Where the editor keeps the skill folders: the default skills root of the generator."""
        home = os.environ.get('HOME') or os.path.expanduser('~')
        return home + '/Documents/synergyAI/skills'

    @classmethod
    def files(cls, facts: dict, skillsRoot: str, documents=None) -> list:
        """The package's own files (the code modules, agents and code/ files are the generator's)."""
        skills = cls.skillFiles(facts, skillsRoot)
        out = [
            {'path': 'requirements.txt', 'code': cls._requirements(facts, skills)},
            {'path': '.env.example', 'code': cls._envExample(facts)},
            {'path': 'README.md', 'code': cls._readme(facts)},
        ]
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
    def _requirements(cls, facts: dict, skillFiles: list) -> str:
        """requirements.txt: one per line, sorted, unique."""
        req = cls.BASE_REQUIREMENTS + cls.SWARM_REQUIREMENTS if 'swarm' in facts else list(cls.BASE_REQUIREMENTS)
        for p in cls._providers(facts):
            if p in cls.PROVIDER_REQUIREMENTS:
                req.append(cls.PROVIDER_REQUIREMENTS[p])
        for f in skillFiles:
            if f['rel'] == 'SKILL.md':
                req += cls.skillDependencies(f['bytes'])
        for doc in facts.get('startDocuments') or []:
            path = str((doc.get('path') if doc.get('path') is not None else doc.get('name')) or '') if isinstance(doc, dict) else ''
            base = os.path.basename(path)
            ext = base.rsplit('.', 1)[1].lower() if '.' in base else ''
            if ext in cls.DOCUMENT_REQUIREMENTS:
                req.append(cls.DOCUMENT_REQUIREMENTS[ext])
        req = sorted(_unique(req), key=lambda s: s.encode('utf-8'))
        return '\n'.join(req) + '\n'

    @classmethod
    def _envExample(cls, facts: dict) -> str:
        """.env.example: every variable the program reads, commented."""
        swarm = 'swarm' in facts   # a swarm writes no run logs
        L = ['# Environment of the workflow "' + facts['wfName'] + '" -- copy this file to .env and fill it in.',
             '# The program reads .env from its own folder first, then from the folder two levels up',
             "# (a local runner's .env). A variable already set in the environment is never overridden.",
             '']
        keys: dict = {}
        for p in cls._providers(facts):
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
        for ad in (facts.get('agentData') or {}).values():
            for c in (ad.get('decision') or []) if ad.get('dispatch') else []:
                decision[str(c['key_env'])] = str(c['url_env'])
        if decision:
            L.append('# Decision models the dispatchers may route with (each URL variable is optional: a gateway)')
            for key, url in decision.items():
                L.append(f'# {key}=')
                L.append(f'# {url}=')
            L.append('')
        slugs = facts.get('serverSlugs') or {}
        if slugs:
            L.append('# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)')
            for url, slug in slugs.items():
                up = str(slug).upper()
                L.append(f'MCP_URL_{up}={url}')
                L.append('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}')
                L.append(f'# MCP_HEADERS_{up}=')
            L.append('')
        L.append('# Optional')
        L.append("# One model for every node, instead of each node's own")
        L.append('# MODEL_NAME=')
        L.append('# Where saved outputs go (default: outputs/ in this folder)')
        L.append('# SYNERGYAI_OUTPUT_ROOT=./outputs')
        if not swarm:
            L.append('# Where run logs go (default: runs/ in this folder)')
            L.append('# RUNS_DIR=./runs')
        if cls.skillDirs(facts):
            L.append('# Where the skills are read from (default: skills/ in this folder)')
            L.append('# SYNERGYAI_SKILLS_DIR=./skills')
        return '\n'.join(L) + '\n'

    @staticmethod
    def _readme(facts: dict) -> str:
        """README.md: install, configure, modes, files written, run server, service units, code nodes."""
        name = str(facts['wfName'])
        root = str(facts['safeName']) + ('_modular_swarm' if 'swarm' in facts else '_modular')
        slug = re.sub(r'[^a-z0-9]+', '-', name, flags=re.IGNORECASE | re.ASCII).strip('-').lower() or 'workflow'
        # A swarm's workflow.py runs a prompt, or --cron; it has no --watch / --once / --quiet.
        swarm = 'swarm' in facts
        mode = 'prompt' if swarm else str(facts.get('startMode') or 'prompt')

        def default(m: str) -> str:
            return ' **(default)**' if m == mode else ''

        L = [f'# {name}', '',
             'A LangGraph program compiled from the SynergyAI workflow editor. It runs on its own: no database,',
             'no SynergyAI server. Everything it needs is in this folder.', '',
             '## Install', '', '```sh',
             'python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt',
             'cp .env.example .env   # then fill in the API keys and MCP headers',
             '```', '', '## Modes', '',
             'One mode per launch. With no flag the program runs in the mode its Start node set.', '',
             '| Command | Mode |', '|---|---|',
             '| `python workflow.py ["text"]` | one run on the text, or on the Start\'s prompt' + default('prompt') + ' |',
             '| `python workflow.py --cron [EXPR]` | a run on each tick of the schedule, until stopped' + default('cron') + ' |']
        if not swarm:
            L.append('| `python workflow.py --watch [server.tool {json}]` | a run for each event the trigger reports, until stopped' + default('watch') + ' |')
            L.append('| `python workflow.py --once "text"` | exactly one run, whatever the default mode |')
        L.append('')
        if not swarm:
            L.append('`--quiet` prints only the done / failed line of each run; `--verbose` adds the progress lines.')
        L.append('Ctrl-C (or SIGTERM) stops a loop after the current run.')
        L += ['', '## Files written', '',
              '- `outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).']
        if not swarm:
            L.append('- `runs/` -- one `<date>_<run id>.jsonl` event log per run, and `runs/current` (`RUNS_DIR` overrides).')
            L.append('  A run with nothing to do leaves no file.')
        L += ['', '## Run server', '', '```sh',
              'python api.py            # HTTP run server: POST /runs, an SSE event stream per run']
        if not swarm:
            L.append('python api.py --listen   # the same, plus the default mode running in the background')
        L += ['```', '', '## Running as a service', '',
              f"Replace `/path/to/{root}` with this folder's absolute path."]
        if mode == 'prompt':
            L.append("This workflow's default is one run, and a service is restarted when it exits: add `--cron EXPR`"
                     + ('' if swarm else ' (or `--watch`)') + ' after `workflow.py` so it keeps running.')
        L += ['',
              f'macOS (launchd): save as `~/Library/LaunchAgents/ai.synergy.{slug}.plist`, then',
              f'`launchctl load ~/Library/LaunchAgents/ai.synergy.{slug}.plist`.',
              '', '```xml',
              '<?xml version="1.0" encoding="UTF-8"?>',
              '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
              '<plist version="1.0">', '<dict>', '  <key>Label</key>',
              f'  <string>ai.synergy.{slug}</string>',
              '  <key>ProgramArguments</key>', '  <array>',
              f'    <string>/path/to/{root}/.venv/bin/python</string>',
              f'    <string>/path/to/{root}/workflow.py</string>',
              '  </array>', '  <key>WorkingDirectory</key>',
              f'  <string>/path/to/{root}</string>',
              '  <key>KeepAlive</key>', '  <true/>',
              # In the package folder itself: launchd creates no folder, and a fresh unzip has no runs/.
              '  <key>StandardOutPath</key>',
              f'  <string>/path/to/{root}/service.log</string>',
              '  <key>StandardErrorPath</key>',
              f'  <string>/path/to/{root}/service.log</string>',
              '</dict>', '</plist>', '```', '',
              f'Linux (systemd): save as `/etc/systemd/system/{slug}.service`, then `systemctl enable --now {slug}`.',
              '', '```ini', '[Unit]', f'Description={name} (LangGraph)', 'After=network-online.target', '',
              '[Service]', f'ExecStart=/path/to/{root}/.venv/bin/python /path/to/{root}/workflow.py',
              f'WorkingDirectory=/path/to/{root}', 'Restart=always', '', '[Install]', 'WantedBy=multi-user.target', '```']
        if facts.get('codeData'):
            L += ['', '## Editing code nodes', '',
                  "Each code node runs its file in `code/` (`code/start_<name>.py` is the Start option's code).",
                  'The file is read at each run: an edit takes effect on the next run, with no recompile. The code',
                  'runs under the same rules as in the editor (`code_harness.py`): standard library only, network',
                  "only through `call_tool`, one of the node's exits, its timeout."]
        return '\n'.join(L) + '\n'
