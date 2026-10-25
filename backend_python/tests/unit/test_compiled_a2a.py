"""Port of backend/tests/Unit/CompiledA2ATest.php: the A2A code structure of ADK, MAF and NOOA -- layout,
ports, files, LangGraph's refusals."""
from __future__ import annotations

import pytest

from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.compiled_a2a_emit import CompiledA2AEmit
from tests.unit.test_adk_code_node import py_compile, wf64_analyzed


def _generator(target: str):
    if target == 'adk':
        return ADKGenerator
    if target == 'maf':
        from app.agent_team.services.maf_generator import MAFGenerator
        return MAFGenerator
    from app.agent_team.services.nooa_generator import NOOAGenerator
    return NOOAGenerator


# PHP: adk, maf, nooa -- each target joins once its Python port is PHP-faithful.
TARGETS = ('adk',)


def test_layout_gives_one_server_per_node_on_consecutive_ports():
    lay = CompiledA2AEmit.layout(wf64_analyzed())
    assert [str(k) for k in lay] == ['2']   # its code nodes are not A2A nodes
    assert lay['2']['file'] == 'servers/2_d.py'
    assert lay['2']['port'] == 8701
    assert lay['2']['kind'] == 'dispatcher'
    assert lay['2']['menu'] == [['3', 'A'], ['4', 'B']]


def test_code_nodes_are_refused_with_lang_graphs_message():
    with pytest.raises(RuntimeError, match='Code nodes are not supported by the A2A packaging yet.'):
        ADKGenerator.a2aPackage(wf64_analyzed())


def test_a_start_option_is_refused():
    a = wf64_analyzed()
    a['code'] = {}
    a['triggerNodeId'] = '10'
    with pytest.raises(RuntimeError, match=r'A Start option \(an event or schedule trigger\) needs the single-file or modular format'):
        CompiledA2AEmit.refuse(a)


@pytest.mark.parametrize('target', TARGETS)
def test_package_files(target):
    a = wf64_analyzed()
    a['code'] = {}
    pkg = _generator(target).a2aPackage(a)
    assert pkg['root'] == f'wf64_{target}_a2a'
    paths = [f['path'] for f in pkg['files']]
    for p in ('orchestrator.py', 'api.py', 'workflow.py', 'common.py', 'servers/2_d.py', 'requirements.txt'):
        assert p in paths, target
    files = {f['path']: f['code'] for f in pkg['files']}
    assert 'a2a-sdk[http-server]>=1.1,<2' in files['requirements.txt']
    assert 'class AgentSupervisor' in files['orchestrator.py']
    assert 'async def run_node(request_text: str, trace) -> dict:' in files['servers/2_d.py']
    for p in ('orchestrator.py', 'api.py', 'servers/2_d.py'):
        assert py_compile(files[p])[0] == 0, f'{target} {p}'
