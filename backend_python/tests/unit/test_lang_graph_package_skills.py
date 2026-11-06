"""Port of the skill parts of backend/tests/Unit/LangGraphPackageTest.php (required skills, requires-skills: [],
quote-aware list readers, native wheels, the store resolver), on LangGraphPackage directly."""
from __future__ import annotations

import os

import pytest

from app.agent_team.services.lang_graph_package import LangGraphPackage as P
from app.services.skill_store import SkillStore

CREATE_PY = ("SKILLS_ROOT = os.environ.get('SYNERGYAI_SKILLS_DIR')\n"
             "flow = load_script('servicenow-flow-author', 'create.py')\npb = load_script(\"playbook-author\", 'create.py')\n"
             "cat = '/skill/playbook-author/references/mcp-catalog.md'\nwf = load_script('workflow-compile', 'compile.py')\nfmt = 'html'\n")


def facts(*dirs):
    return {'agentData': {'n1': {'skills': [{'dir': d} for d in dirs]}}}


def write(root, rel, data):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as fh:
        fh.write(data.encode() if isinstance(data, str) else data)


def paths(files):
    return sorted(f['entry']['path'] for f in files)


def test_required_skills_rulings_match_the_brief():
    inst = ['html', 'docx', 'workflow-compile']
    assert P.requiredSkills('me', {'scripts/a.py': 'mime = "text/html"; p = "docx/out"; q = "my-workflow-compile"; r = "/x/workflow-compile.py"'},
                            inst) == {'requires': [], 'missing': []}
    assert P.requiredSkills('me', {'scripts/a.py': "F = {'html': 'html', \"docx\": \"docx\"}; c = '/root/workflow-compile/compile.py'"},
                            inst) == {'requires': ['docx', 'html', 'workflow-compile'], 'missing': []}
    # A declared list replaces scanning.
    assert P.requiredSkills('me', {'SKILL.md': '---\nrequires-skills: docx\n---\n', 'scripts/a.py': "'html'"}, inst) == \
        {'requires': ['docx'], 'missing': []}


def test_required_skills_detection():
    installed = ['servicenow-automation-author', 'servicenow-flow-author', 'playbook-author', 'workflow-compile', 'GEO/geo-report']
    files = {'SKILL.md': "---\nname: a\n---\n'docx'", 'scripts/create.py': CREATE_PY,
             'scripts/__pycache__/x.pyc': "'GEO/geo-report'", 'references/r.md': "'geo-report'"}
    assert P.requiredSkills('servicenow-automation-author', files, installed) == \
        {'requires': ['playbook-author', 'servicenow-flow-author', 'workflow-compile'], 'missing': []}
    decl = {'SKILL.md': '---\nrequires-skills: [geo-report, ghost]\n---\n', 'scripts/a.py': "x = 'servicenow-automation-author'"}
    assert P.requiredSkills('servicenow-automation-author', decl, installed) == {'requires': ['GEO/geo-report'], 'missing': ['ghost']}
    assert P.declaredSkills('---\nrequires-skills: docx\n---\n') == ['docx']
    # requires-skills: [] declares none: scanning stops
    none = {'SKILL.md': '---\nrequires-skills: []\n---\n', 'scripts/create.py': CREATE_PY}
    assert P.requiredSkills('servicenow-automation-author', none, installed) == {'requires': [], 'missing': []}
    assert P.declaresSkills('---\nrequires-skills: []\n---\n') is True
    assert P.declaresSkills('---\nname: a\n---\n') is False
    assert P.resolveSkillName('x', ['SEO/x', 'GEO/x'], 'GEO/me') == 'GEO/x'


def test_list_items_keep_commas_inside_quotes():
    assert P.listItems(" [pandas>=2, 'numpy>=1.20,<2', 'requests[socks,security]']") == ['pandas>=2', 'numpy>=1.20,<2', 'requests[socks,security]']
    assert P.listItems(' a, "b, c"') == ['a', 'b, c']
    assert P.listItems(" 'it''s'") == ["it's"]
    assert P.listItems(" 'open, b") == ['open', 'b']          # unterminated quote: split on every comma
    assert P.listItems(' []') == []
    assert P.skillDependencies("---\ndependencies: [pandas>=2, 'numpy>=1.20,<2']\n---\n") == ['pandas>=2', 'numpy>=1.20,<2']
    assert P.skillDependencies('no frontmatter') == []


def test_a_grouped_required_skill_is_copied_at_its_leaf(tmp_path):
    root = str(tmp_path / 'root')
    write(root, 'auto/SKILL.md', '---\nname: auto\n---\n')
    write(root, 'auto/scripts/a.py', "load_script('geo-report', 'make.py')\n")
    write(root, 'GEO/geo-report/SKILL.md', '---\nname: geo-report\n---\n')
    write(root, 'GEO/geo-report/scripts/make.py', 'print(1)\n')
    want = ['skills/auto/SKILL.md', 'skills/auto/scripts/a.py', 'skills/geo-report/SKILL.md', 'skills/geo-report/scripts/make.py']
    assert paths(P.skillFiles(facts('auto'), root)) == want
    # The store resolver finds a grouped skill by its leaf.
    s = SkillStore(str(tmp_path / 'store'), 'individual')
    s.import_(3, 'auto', {'SKILL.md': b'---\nname: auto\n---\n', 'scripts/a.py': b"load_script('geo-report', 'make.py')\n"})
    s.import_(3, 'GEO/geo-report', {'SKILL.md': b'---\nname: geo-report\n---\n', 'scripts/make.py': b'print(1)\n'})
    assert paths(P.skillFiles(facts('auto'), s.compileResolver(3, False))) == want


def test_two_required_skills_with_one_leaf_are_an_error(tmp_path):
    root = str(tmp_path)
    for d, md in (('auto', '---\nname: auto\nrequires-skills: [A/x, B/x]\n---\n'), ('A/x', '---\nname: x\n---\n'), ('B/x', '---\nname: x\n---\n')):
        write(root, f'{d}/SKILL.md', md)
    with pytest.raises(RuntimeError, match=r"""Skills "A/x" and "B/x" both need to be available as 'x'; rename one\."""):
        P.skillFiles(facts('auto'), root)


def test_native_wheels_travel_and_requirements_leave_their_libraries_out(tmp_path):
    root = str(tmp_path)
    write(root, 'pdf-report/SKILL.md', '---\nname: pdf-report\ndependencies: [fpdf2]\n---\n')
    write(root, 'pdf-report/run.py', 'print(1)\n')
    write(root, 'pdf-report/.wheels/native/fpdf2-2.8.1-py3-none-any.whl', b'PK\x03\x04\xffnative')
    write(root, 'pdf-report/.wheels/pyodide/fpdf2-2.8.1-py3-none-any.whl', b'browser')
    write(root, 'plain-skill/SKILL.md', '---\nname: plain\ndependencies: [zz-plain-dep]\n---\n')
    files = P.skillFiles(facts('pdf-report'), root)
    assert paths(files) == ['skills/pdf-report/.wheels/native/fpdf2-2.8.1-py3-none-any.whl', 'skills/pdf-report/SKILL.md',
                            'skills/pdf-report/run.py']
    assert P.skillRequirementNames(files) == []
    assert P.skillRequirementNames(P.skillFiles(facts('plain-skill'), root)) == ['zz-plain-dep']


def test_the_resolver_picks_each_skill_folder(tmp_path):
    root = str(tmp_path)
    write(root, 'pdf-report/SKILL.md', '---\nname: pdf-report\n---\n')
    asked = []

    def resolver(d, frm=None):
        asked.append(d)
        return f'{root}/{d}'
    assert 'skills/pdf-report/SKILL.md' in paths(P.skillFiles(facts('pdf-report'), resolver))
    assert asked[0] == 'pdf-report'
    with pytest.raises(RuntimeError, match='Skill folder "pdf-report" is not available on this server'):
        P.skillFiles(facts('pdf-report'), lambda d, frm=None: None)


def test_required_skills_are_copied_into_the_package(tmp_path):
    root = str(tmp_path)
    for d, py in (('auto', CREATE_PY), ('servicenow-flow-author', "x = 'playbook-author'\n"), ('playbook-author', "y = 'auto'\n"),
                  ('workflow-compile', 'print(1)\n'), ('unused', 'print(2)\n')):
        write(root, f'{d}/SKILL.md', f'---\nname: {d}\n---\n')
        write(root, f'{d}/scripts/create.py', py)
    write(root, 'workflow-compile/.wheels/native/w-1-py3-none-any.whl', 'PK')
    got = paths(P.skillFiles(facts('auto'), root))
    for p in ('skills/auto/scripts/create.py', 'skills/servicenow-flow-author/scripts/create.py', 'skills/playbook-author/scripts/create.py',
              'skills/workflow-compile/scripts/create.py', 'skills/workflow-compile/.wheels/native/w-1-py3-none-any.whl'):
        assert p in got
    assert 'skills/unused/SKILL.md' not in got
    # The store resolver: the same skills, found by probing the names the scripts use.
    assert paths(P.skillFiles(facts('auto'), lambda d, frm=None: f'{root}/{d}' if os.path.isdir(f'{root}/{d}') else None)) == got
    # A declared required skill the server does not have stops the compile, naming both.
    write(root, 'auto/SKILL.md', '---\nname: auto\nrequires-skills: [ghost]\n---\n')
    with pytest.raises(RuntimeError, match='Skill "auto" needs skill "ghost", which is not available on this server'):
        P.skillFiles(facts('auto'), root)
