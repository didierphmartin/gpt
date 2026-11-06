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


# PHP trim()'s default characters
_WS = ' \t\n\r\0\x0b'
_SKILL_NAME = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)?\Z')
_QUOTED = re.compile(r"'([^'\n\\]*)'|\"([^\"\n\\]*)\"")


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
    def files(cls, facts: dict, skillsRoot, documents=None) -> list:
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
    def skillFiles(cls, facts: dict, skillsRoot) -> list:
        """Every file of every used skill folder (skipping __pycache__, .DS_Store, *.pyc, .env*, dot-directories), sorted,
        plus the skill's native wheels (.wheels/native/: the program installs its libraries from there, offline);
        never the browser's (.wheels/pyodide/). Each used skill brings the skills it requires (requiredSkills(),
        transitively): they are copied the same way, after the bound ones, at skills/<leaf>/ (a grouped one too).

        skillsRoot: the folder holding the skills, or (the Docker app's skill store) a resolver
        (dir, from) -> folder | None giving each skill's own folder, None when the owner cannot see it."""
        out = []
        if isinstance(skillsRoot, str):
            root = os.path.realpath(skillsRoot) if os.path.exists(skillsRoot) else False
        else:
            root = None
        # [skill, who needs it, where it goes]: a bound skill at its own path; a required one at skills/<leaf>/, where
        # the scripts that need it look (SKILLS_ROOT/<leaf>/...).
        queue = [[d, None, d] for d in cls.skillDirs(facts)]
        done: dict = {}
        installed = None   # the skill paths a folder root holds (read once, when a skill needs it)
        while queue:
            d, by, as_ = queue.pop(0)
            if as_ in done:
                if done[as_] != d:   # two different skills would land in one folder
                    raise RuntimeError(f'Skills "{done[as_]}" and "{d}" both need to be available as \'{as_}\'; rename one.')
                continue
            done[as_] = d
            base = cls._skillBase(d, skillsRoot, root, by)
            if base is False:
                raise RuntimeError(f'Skill folder "{d}" is not available on this server, so it can\'t be packaged.' if by is None
                                   else f'Skill "{by}" needs skill "{d}", which is not available on this server, so it can\'t be packaged.')
            found = cls._folderFiles(base, base)
            own = {}
            for rel in found:
                if rel == 'SKILL.md' or rel.startswith('scripts/'):
                    with open(os.path.join(base, rel), 'rb') as fh:
                        own[rel] = fh.read()
            if os.path.isdir(f'{base}/.wheels/native'):
                found += cls._folderFiles(base, f'{base}/.wheels/native')
            found.sort(key=lambda s: s.encode('utf-8'))
            for rel in found:
                with open(os.path.join(base, rel), 'rb') as fh:
                    data = fh.read()
                out.append({'dir': as_, 'rel': rel, 'bytes': data, 'entry': cls._entry(f'skills/{as_}/{rel}', data)})
            if root is not None:
                if installed is None:
                    installed = [] if root is False else cls._installedSkills(root)
                names = installed
            else:
                names = cls._probedSkills(d, own, skillsRoot)
            req = cls.requiredSkills(d, own, names)
            for m in req['missing']:
                raise RuntimeError(f'Skill "{d}" needs skill "{m}", which is not available on this server, so it can\'t be packaged.')
            for q in req['requires']:
                queue.append([q, d, q.rsplit('/', 1)[-1]])
        return out

    @staticmethod
    def _skillBase(d: str, skillsRoot, root, frm: str | None = None):
        """The real folder of skill d (inside the root, or from the store resolver), False when unsafe or absent."""
        # dir_name comes from the client-saved node config: plain segments ("GEO/geo-report" for a grouped
        # skill; none empty, "." or "..", none starting with "." (.git, .superpowers), no "\"), resolved
        # inside the root.
        segments = StartDocumentStore.safeSegments(d)
        safe = segments is not None and not [s for s in segments if s.startswith('.')]
        if not safe:
            return False
        if root is None:
            dir_ = skillsRoot(d, frm)   # frm: the skill that needs it (a store resolver prefers its group)
            base = False if dir_ is None or not os.path.exists(dir_) else os.path.realpath(dir_)
        else:
            cand = os.path.join(root, d) if root is not False else None
            base = os.path.realpath(cand) if cand is not None and os.path.exists(cand) else False
            base = base if base is not False and base.startswith(root + os.sep) else False
        return base if base is not False and os.path.isdir(base) else False

    @staticmethod
    def _installedSkills(root: str) -> list:
        """The skill paths under a skills root: folders (one or two levels, no dot-folder) holding a SKILL.md."""
        out = []
        for a in sorted(os.listdir(root)) if os.path.isdir(root) else []:
            if a.startswith('.') or not os.path.isdir(f'{root}/{a}'):
                continue
            if os.path.isfile(f'{root}/{a}/SKILL.md'):
                out.append(a)
                continue
            for b in sorted(os.listdir(f'{root}/{a}')):
                if not b.startswith('.') and os.path.isfile(f'{root}/{a}/{b}/SKILL.md'):
                    out.append(f'{a}/{b}')
        out.sort(key=lambda s: s.encode('utf-8'))
        return out

    @classmethod
    def _probedSkills(cls, self_: str, files: dict, resolve) -> list:
        """The store has no listing here, only the resolver: every name the skill could mean (its requires-skills,
        else each exact quoted literal and each /segment/ of its scripts) that resolves to a skill the owner sees
        (the resolver also finds a grouped skill by its leaf)."""
        md = cls._text(files.get('SKILL.md', ''))
        cands = list(cls._declaredSkillsOrNull(md) or [])
        if not cls.declaresSkills(md):   # declared (even []) replaces scanning
            for lit in cls._quotedLiterals(files):
                cands.append(lit)                     # an exact literal
                segs = lit.split('/')
                for i in range(1, len(segs) - 1):     # a /segment/ with a slash on both sides
                    cands.append(segs[i])
        out = []
        for c in _unique(cands):
            if c == self_ or not _SKILL_NAME.match(c):
                continue
            dir_ = resolve(c, self_)
            if dir_ is not None and os.path.isfile(dir_ + '/SKILL.md'):
                out.append(c)
        out.sort(key=lambda s: s.encode('utf-8'))
        return out

    @staticmethod
    def _text(v) -> str:
        return v.decode('utf-8', errors='replace') if isinstance(v, bytes) else str(v if v is not None else '')

    @staticmethod
    def _quotedLiterals(files: dict) -> list:
        """The quoted string literals ('…' / "…", one line) of a skill's scripts/** text files."""
        lits = []
        for rel, data in files.items():
            rel = str(rel)
            if not rel.startswith('scripts/') or '__pycache__' in rel.split('/') or rel.endswith('.pyc'):
                continue
            if isinstance(data, bytes):
                try:
                    text = data.decode('utf-8')
                except UnicodeDecodeError:
                    continue
            else:
                text = str(data)
            for m in _QUOTED.finditer(text):
                lits.append(m.group(2) if (m.group(2) or '') != '' else (m.group(1) or ''))
        return lits

    @classmethod
    def declaredSkills(cls, skillMd) -> list:
        """`requires-skills:` of a SKILL.md frontmatter (list or single form, parsed as `dependencies:`); [] when absent."""
        return cls._frontmatterList(skillMd, 'requires-skills:')

    @classmethod
    def declaresSkills(cls, skillMd) -> bool:
        """Whether the frontmatter has a `requires-skills:` line: `requires-skills: []` says "none" and stops scanning."""
        return cls._declaredSkillsOrNull(skillMd) is not None

    @classmethod
    def _declaredSkillsOrNull(cls, skillMd):
        return cls._frontmatterListOrNull(skillMd, 'requires-skills:')

    @staticmethod
    def resolveSkillName(name: str, installed: list, frm: str) -> str | None:
        """The installed skill a name means: the exact path, else by leaf (same group as frm, then top level, then the first)."""
        if name in installed:
            return name
        leaf = name.rsplit('/', 1)[-1]
        hits = [p for p in installed if p.rsplit('/', 1)[-1] == leaf]
        if not hits:
            return None
        group = frm.split('/')[0] if '/' in frm else ''
        for p in hits:
            if (p.split('/')[0] if '/' in p else '') == group:
                return p
        for p in hits:
            if '/' not in p:
                return p
        return sorted(hits, key=lambda s: s.encode('utf-8'))[0]

    @classmethod
    def requiredSkills(cls, path: str, files: dict, installed: list) -> dict:
        """The skills skill `path` requires (one level; twin of SkillRequires.direct in frontend/assets/js/skill-requires.js):
        its `requires-skills:` when declared (replaces scanning), else every OTHER installed skill whose leaf folder
        name is an exact quoted string of its scripts/** text files or a /leaf/ segment (slash on both sides) inside
        one. Unknown declared names are missing. Returns {requires: [paths], missing: [names]}."""
        lst = [p for p in installed if p != path]
        out: dict = {}
        missing = []
        declared = cls._declaredSkillsOrNull(cls._text(files.get('SKILL.md', '')))
        if declared is not None:   # a declared list (even []) replaces scanning
            for name in declared:
                hit = cls.resolveSkillName(name, lst, path)
                if hit is None:
                    missing.append(name)
                else:
                    out[hit] = True
        else:
            lits = cls._quotedLiterals(files)
            exact = set(lits)
            for leaf in _unique([p.rsplit('/', 1)[-1] for p in lst]):
                hit = leaf in exact or any(f'/{leaf}/' in l for l in lits)
                if hit:
                    out[cls.resolveSkillName(leaf, lst, path)] = True
        return {'requires': sorted((str(k) for k in out), key=lambda s: s.encode('utf-8')), 'missing': missing}

    @classmethod
    def _folderFiles(cls, base: str, frm: str) -> list:
        """The files under frm (paths relative to the skill folder base), skipping junk, .env* and dot-directories."""
        found = []
        for dirpath, dirnames, filenames in os.walk(frm):   # RecursiveDirectoryIterator does not enter a symlinked folder
            dirnames[:] = [n for n in dirnames if n not in cls.SKIP_NAMES and not n.endswith('.pyc')
                           and not n.startswith('.env') and not n.startswith('.')]   # .git/, .pytest_cache/, .wheels/ ...
            for fn in filenames:
                if fn in cls.SKIP_NAMES or fn.endswith('.pyc') or fn.startswith('.env'):
                    continue
                p = os.path.join(dirpath, fn)
                real = os.path.realpath(p) if os.path.isfile(p) else None
                # A file is copied only if it really lives in the skill folder (a symlink may point elsewhere).
                if real is not None and real.startswith(base + os.sep):
                    found.append(p[len(base) + 1:])
        return found

    @classmethod
    def skillRequirementNames(cls, skillFiles: list) -> list:
        """The SKILL.md dependencies a package's requirements.txt lists: those of each skill without bundled wheels.
        A skill that carries .wheels/native/*.whl installs its libraries from there, offline, at its first use."""
        bundled = {f['dir'] for f in skillFiles if f['rel'].startswith('.wheels/native/') and f['rel'].endswith('.whl')}
        req = []
        for f in skillFiles:
            if f['rel'] == 'SKILL.md' and f['dir'] not in bundled:
                req += cls.skillDependencies(f['bytes'])
        return req

    @classmethod
    def skillDependencies(cls, skillMd) -> list:
        """`dependencies:` of a SKILL.md's frontmatter, parsed as SkillRuntime.ensure_deps parses it."""
        return cls._frontmatterList(skillMd, 'dependencies:')

    @classmethod
    def _frontmatterList(cls, skillMd, key: str) -> list:
        """A frontmatter list field (key with its colon): `key: a, b` or `key: [a, "b"]`; [] when absent."""
        v = cls._frontmatterListOrNull(skillMd, key)
        return [] if v is None else v

    @classmethod
    def _frontmatterListOrNull(cls, skillMd, key: str):
        """_frontmatterList, but None when the field is absent (or there is no frontmatter)."""
        lines = re.split(r'\r\n|\r|\n', cls._text(skillMd))
        if not lines or lines[0].strip(_WS) != '---':
            return None
        for line in lines[1:]:
            s = line.strip(_WS)
            if s == '---':
                break
            if s.lower().startswith(key):
                return cls.listItems(s.split(':', 1)[1])
        return None

    @staticmethod
    def listItems(raw: str) -> list:
        """Items of a frontmatter list value (`a, b` or `[a, 'b,c']`): split on commas outside single/double quotes,
        then one matching quote pair is stripped ('' -> ' inside single quotes). An unterminated quote falls back
        to splitting on every comma. Twin of SkillRequires.listItems (JS) and the emitted Python readers."""
        val = raw.strip(_WS).strip('[]')
        items = []
        cur = ''
        q = None
        n = len(val)
        i = 0
        while i < n:
            c = val[i]
            if q is not None:
                cur += c
                if c == q:
                    if q == "'" and i + 1 < n and val[i + 1] == "'":
                        i += 1
                        cur += val[i]
                    else:
                        q = None
            elif c in ('"', "'") and cur.strip(_WS) == '':
                q = c
                cur += c
            elif c == ',':
                items.append(cur)
                cur = ''
            else:
                cur += c
            i += 1
        items.append(cur)
        out = []
        if q is not None:
            for d in val.split(','):
                d = d.strip(_WS).strip("'").strip('"')
                if d != '':
                    out.append(d)
            return out
        for d in items:
            d = d.strip(_WS)
            k = d[0] if d else ''
            if len(d) >= 2 and k in ("'", '"') and d[-1] == k:
                d = d[1:-1]
                if k == "'":
                    d = d.replace("''", "'")
            if d != '':
                out.append(d)
        return out

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
        req += cls.skillRequirementNames(skillFiles or [])
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
        # Every LangGraph program reads MODEL_NAME: its model factory is in the script, common.py or each agent server.
        return {'keys': keys, 'decision': decision, 'mcp': facts.get('serverSlugs') or {},
                'model': "One model for every node, instead of each node's own"}

    @classmethod
    def _optionalEnv(cls, facts: dict, layout: str) -> list:
        """The optional variables a layout program reads, as .env.example lists them: [what it does, KEY=example]."""
        o = []
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
