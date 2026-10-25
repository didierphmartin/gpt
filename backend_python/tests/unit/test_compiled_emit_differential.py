"""Differential test: the shared emitters ADK, MAF and NOOA build on emit PHP's bytes.

tests/fixtures/compiler/php_compiled_emit.php makes a fixed list of calls -- CompiledRuntimeEmit,
CompiledA2AEmit, CompiledArchitectureDoc, CompiledPackage, DispatcherDecisionFacts, StartTriggerFacts,
PlaybookEmit, RunServerEmitter, WorkflowGraphAnalyzer.dispatchMenus / serverIndex / availableToolsById,
LangGraphGenerator.llmFactoryLines -- on the analysis ADKGenerator makes of each compiler fixture; this
test makes the same calls on the Python port and compares every result (strings byte for byte, after the
wall-clock normalisation of compiler_fixtures.normalize). Skipped when no PHP binary is available.
"""
from __future__ import annotations

import difflib
import json
import os
import subprocess

import pytest

from app.agent_team.services.code_node_emit import CodeNodeEmit  # noqa: F401 -- parity with the oracle's imports
from app.agent_team.services.compiled_a2a_emit import CompiledA2AEmit
from app.agent_team.services.compiled_architecture_doc import CompiledArchitectureDoc
from app.agent_team.services.compiled_package import CompiledPackage
from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.compiler_php import json_encode
from app.agent_team.services.dispatcher_decision_facts import DispatcherDecisionFacts
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.playbook_emit import PlaybookEmit
from app.agent_team.services.run_server_emitter import RunServerEmitter
from app.agent_team.services.start_trigger_facts import StartTriggerFacts
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from tests.unit import compiler_fixtures as cf

pytestmark = pytest.mark.skipif(cf.php_binary() is None,
                                reason='no PHP binary (set PHP_BIN, or install XAMPP / php on PATH): '
                                       'the PHP emitters are the reference this test compares against')

PATHS = cf.fixture_paths()


@pytest.fixture(scope='module')
def php_results():
    env = dict(os.environ, XDEBUG_MODE='off')
    proc = subprocess.run([cf.php_binary(), str(cf.FIXTURES / 'php_compiled_emit.php'), *[str(p) for p in PATHS]],
                          capture_output=True, text=True, env=env, timeout=600)
    assert proc.returncode == 0, proc.stderr[-4000:]
    return json.loads(proc.stdout)


@pytest.fixture(autouse=True)
def _utc(monkeypatch):
    monkeypatch.setenv('PHP_TIMEZONE', 'UTC')


def _py_results(fx: dict) -> dict:
    r: dict = {}

    def call(key, fn):
        try:
            r[key] = fn()
        except Exception as e:  # noqa: BLE001 -- an error is a result to compare
            r[key] = {'error': str(e)}

    wfId = int(fx['workflow']['id'])
    userId = str(fx.get('user_id') or '3')
    db = cf.fixture_db(fx.get('sql') or [])
    graphRepo = cf.FixtureGraphRepo(fx['graph'], fx.get('code_components') or {})
    agentRepo = cf.FixtureAgentRepo(fx.get('agents') or {})
    analyzer = WorkflowGraphAnalyzer(db, cf.FixtureWorkflowRepo(fx['workflow']), graphRepo, agentRepo)
    skillsRoot = cf.SKILLS_ROOT
    holder: dict = {}

    def analyze():
        a = analyzer.analyze(wfId, userId)
        defaults = {}
        for row in db.fetch_all('SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1'):
            if row.get('model'):
                defaults[str(row['provider_key']).lower()] = str(row['model'])
        a['playbooks'] = {}
        for pid, pnode in (a.get('byId') or {}).items():
            if WorkflowGraphAnalyzer.typeOf(pnode) != 'playbook':
                continue
            a['playbooks'][str(pid)] = PlaybookEmit.nodeData(pnode, analyzer.availableToolsById(userId), defaults, userId)
        holder['a'] = CompiledRuntimeEmit.analyzeRuntime(a, analyzer, db, agentRepo, graphRepo.getGraph(wfId), wfId, userId)
        keep = ['order', 'layers', 'startNodeId', 'agents', 'usedCatalog', 'usedServers', 'startPrompt', 'startDocuments',
                'playbooks', 'code', 'serverSlugs', 'decisions', 'startMode', 'defaultCron', 'defaultWatch', 'triggerNodeId']
        return {k: v for k, v in holder['a'].items() if k in keep}

    call('analyze', analyze)
    call('serverIndex', lambda: analyzer.serverIndex(userId))
    call('availableToolsById', lambda: analyzer.availableToolsById(userId))
    call('llmFactoryLines', lambda: LangGraphGenerator.llmFactoryLines())
    name = str(fx['workflow']['name'])
    call('runServer.emit', lambda: RunServerEmitter.emit(name, 'doc body\nline 2', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"'))
    call('runServer.emitListen', lambda: RunServerEmitter.emit(name, 'doc', 'from workflow import x', 'WORKFLOW_VERSION = "2"', True))
    call('runServer.package', lambda: RunServerEmitter.package({'code': 'print(1)\n'}, name, 'adk', 'Doc line'))
    call('runServer.packageCommon', lambda: RunServerEmitter.package({'code': 'x'}, 'Ünïcode — Name', 'maf', 'D', 'common\n', True))
    if 'a' in holder:
        a = holder['a']
        call('dispatchMenus', lambda: WorkflowGraphAnalyzer.dispatchMenus(a))
        for did in WorkflowGraphAnalyzer.dispatchMenus(a)['menus']:
            call(f'decisionFacts.{did}', lambda did=did: DispatcherDecisionFacts.of(db, agentRepo, a['byId'][did], str(a['workflow']['name'])))
            call(f'decisionFactsNoDb.{did}', lambda did=did: DispatcherDecisionFacts.of(None, None, a['byId'][did], 'Other'))
        call('startTriggerFacts', lambda: StartTriggerFacts.of(
            db, wfId, [{'id': str(i), **{k: v for k, v in a['byId'][i].items() if k != 'id'}} for i in a['order']], a['serverSlugs']))
        call('cre.mcpClientBlock', lambda: CompiledRuntimeEmit.mcpClientBlock(a))
        call('cre.codeHarnessBlock.package', lambda: CompiledRuntimeEmit.codeHarnessBlock(True))
        call('cre.codeHarnessBlock.single', lambda: CompiledRuntimeEmit.codeHarnessBlock(False))
        call('cre.recordingBlock', lambda: CompiledRuntimeEmit.recordingBlock(a))
        call('cre.recordingBlock.callbacks', lambda: CompiledRuntimeEmit.recordingBlock(a, True))
        call('cre.packageListenBlock', lambda: CompiledRuntimeEmit.packageListenBlock())
        call('cre.packageListenBlock.hooks', lambda: CompiledRuntimeEmit.packageListenBlock('def _cli_begin(p):\n    pass\n'))
        call('cre.moduleLayout', lambda: CompiledRuntimeEmit.moduleLayout(a))
        call('cre.displayName', lambda: [CompiledRuntimeEmit.displayName(a, str(i)) for i in a['order']])
        call('cre.codeNodeLiterals', lambda: CompiledRuntimeEmit.codeNodeLiterals(a))
        call('cre.codeNodesLiteral', lambda: CompiledRuntimeEmit.codeNodesLiteral(a))
        call('cre.codeNodesLiteral.package', lambda: CompiledRuntimeEmit.codeNodesLiteral({**a, 'package': True}))
        call('cre.codeNodesLiteral.split', lambda: CompiledRuntimeEmit.codeNodesLiteral({**a, 'split': True}))
        call('cre.decisionBlock', lambda: CompiledRuntimeEmit.decisionBlock(a))
        call('cre.decisionBlock.split', lambda: CompiledRuntimeEmit.decisionBlock({**a, 'split': True}))
        call('cre.idRecordingHelpers', lambda: CompiledRuntimeEmit.idRecordingHelpers())
        call('cre.packageCommonWithRuntime', lambda: CompiledRuntimeEmit.packageCommonWithRuntime(['HEAD = 1\n', 'A = 2', 'B = 3']))
        layout = CompiledRuntimeEmit.moduleLayout(a)
        tables = {'NODE': ['NODES', {nid: '{"id": ' + json_encode(nid) + '}' for nid in layout}],
                  'CODE_NODE': ['CODE_NODES', CompiledRuntimeEmit.codeNodeLiterals(a)]}
        first = next(iter(layout), 'none')
        call('cre.tablePackage', lambda: CompiledRuntimeEmit.tablePackage(
            a, ['# head\n', 'X = 1'], ['ASSEMBLY = 1', 'def run_workflow(): pass'], tables, {first: 'PRELUDE = True'},
            'Google ADK', 'its ADK agent', 'ADK models, MCP'))
        call('a2a.version', lambda: CompiledA2AEmit.version(a))
        call('a2a.layout', lambda: CompiledA2AEmit.layout(a))

        def refuse():
            CompiledA2AEmit.refuse(a)
            return 'ok'
        call('a2a.refuse', refuse)
        call('a2a.orchestrator', lambda: CompiledA2AEmit.orchestrator(a, 'Google ADK'))
        call('a2a.api', lambda: CompiledA2AEmit.api(a, 'Microsoft Agent Framework'))
        for nid in CompiledA2AEmit.layout(a):
            call(f'a2a.server.{nid}', lambda nid=nid: CompiledA2AEmit.server(a, nid, 'def run_node(text, trace):\n    return {}\n\n', 'NVIDIA NOOA'))
        call('a2a.dispatcherHelpers', lambda: CompiledA2AEmit.dispatcherHelpers())
        runNodes = {nid: 'def run_node():\n    pass\n' for nid in CompiledA2AEmit.layout(a)}
        call('a2a.package', lambda: CompiledA2AEmit.package(a, ['W\n', 'C\n', [{'path': 'agents/x.py', 'code': 'x'}]], runNodes,
                                                            [{'path': 'requirements.txt', 'code': 'r\n'}], 'root_adk_a2a', 'Google ADK'))
        docs = LangGraphPackage.startDocuments(a.get('startDocuments') or [], None)
        call('package.files', lambda: CompiledPackage.files({**a, 'package': True}, skillsRoot, docs['files'],
                                                            ['google-adk>=2.3,<3', 'litellm'], 'Google ADK'))
        for nid in a['code']:
            call(f'package.codePath.{nid}', lambda nid=nid: CompiledPackage.codePath(a, nid))
        call('playbook.docNodes', lambda: PlaybookEmit.docNodes(a))
        call('playbook.extraDeps', lambda: PlaybookEmit.extraDeps(a))
        call('playbook.supportBlock', lambda: PlaybookEmit.supportBlock(True))
        call('playbook.supportBlock.noMcp', lambda: PlaybookEmit.supportBlock(False))
        call('playbook.metadataBlock', lambda: PlaybookEmit.metadataBlock(a['playbooks']))
        call('playbook.runtimeBlock', lambda: PlaybookEmit.runtimeBlock())
        for pid in a['playbooks']:
            def pb_refuse(pid=pid):
                PlaybookEmit.refuseLangGraphOnly(a['byId'][pid], graphRepo.getGraph(wfId).get('edges') or [])
                return 'ok'
            call(f'playbook.refuse.{pid}', pb_refuse)
        single = {'filename': 'wf_adk.py', 'code': CompiledRuntimeEmit.mcpClientBlock(a) + '\n' + CompiledRuntimeEmit.recordingBlock(a)
                  + '\ndef run_workflow():\n    pass\nclass Listener:\n    pass\n_make_model = None\nasync def _run_graph():\n    pass\n'}
        package = {'root': 'wf_x', 'files': [
            {'path': 'workflow.py', 'code': 'def run_workflow():\n    pass\n'},
            {'path': 'common.py', 'code': CompiledRuntimeEmit.packageCommonBlock() + '\nclass ProviderClients:\n    pass\n'},
            {'path': 'api.py', 'code': 'x'}, {'path': '__init__.py', 'code': '\n'}, {'path': 'agents/__init__.py', 'code': ''},
            {'path': 'skills/html/SKILL.md', 'code': 's'}, {'path': 'skills/html/a/b.txt', 'code': 's'},
            {'path': 'start_documents/a.pdf', 'code': 'p'}, {'path': 'code/2_x.py', 'code': 'c'}, {'path': 'code_harness.py', 'code': 'h'},
            {'path': 'requirements.txt', 'code': 'r'}, {'path': '.env.example', 'code': 'e'}, {'path': 'README.md', 'code': 'm'},
            {'path': 'weird.bin', 'code': ''}]}
        for m in layout.values():
            package['files'].append({'path': m['file'], 'code': 'n'})
        a2aPackage = {'root': package['root'], 'files': list(package['files'])}
        a2aPackage['files'].append({'path': 'orchestrator.py', 'code': LangGraphGenerator.a2aRemoteBlock()})
        for e in CompiledA2AEmit.layout(a).values():
            a2aPackage['files'].append({'path': e['file'], 'code': LangGraphGenerator.a2aAgentServerBlock()})
        for target in ('adk', 'maf', 'nooa'):
            call(f'archdoc.{target}.single', lambda t=target: CompiledArchitectureDoc.attach(single, a, t, 'single'))
            call(f'archdoc.{target}.modular', lambda t=target: CompiledArchitectureDoc.attach(package, a, t, 'modular'))
            call(f'archdoc.{target}.a2a', lambda t=target: CompiledArchitectureDoc.attach(a2aPackage, a, t, 'a2a'))
    return r


def _norm(value):
    if isinstance(value, str):
        return cf.normalize(value)
    if isinstance(value, list):
        return [_norm(v) for v in value]
    if isinstance(value, dict):
        return {k: _norm(v) for k, v in value.items()}
    return value


@pytest.mark.parametrize('path', PATHS, ids=[p.stem for p in PATHS])
def test_shared_emitters_match_php(path, php_results):
    php = _norm(php_results[path.stem])
    py = _norm(json.loads(json_encode(_py_results(cf.load(path)), slashes=True, unicode=True)))
    assert list(php) == list(py), 'the two oracles made different calls'
    problems = []
    for key in php:
        if php[key] != py[key]:
            if isinstance(php[key], str) and isinstance(py[key], str):
                a, b = php[key].splitlines(), py[key].splitlines()
            else:
                a = json.dumps(php[key], indent=1, ensure_ascii=False).splitlines()
                b = json.dumps(py[key], indent=1, ensure_ascii=False).splitlines()
            diff = list(difflib.unified_diff(a, b, 'php', 'py', n=1, lineterm=''))[:24]
            problems.append(f'{key}:\n' + '\n'.join(line[:220] for line in diff))
    if problems:
        pytest.fail(f'{len(problems)} call(s) differ from PHP:\n\n' + '\n\n'.join(problems[:8]), pytrace=False)
