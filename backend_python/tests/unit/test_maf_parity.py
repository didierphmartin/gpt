"""Port of backend/tests/Unit/MafParityTest.php: MAF gets what ADK has -- MCP headers, code nodes, decision
routing, run events, a listening package.

The two analyses are AdkCodeNodeTest::codeAnalyzed() / ::wf64Analyzed() (PHP shares them between the ADK,
MAF and NOOA tests). testANodeNamedLikeAModuleDoesNotShadowIt runs both packages, MAF and NOOA, as in PHP.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.maf_generator import MAFGenerator
from app.agent_team.services.nooa_generator import NOOAGenerator
from tests.unit.test_adk_code_node import code_analyzed, wf64_analyzed
from tests.unit.test_adk_code_node import py_compile as _py_compile

REPO = Path(__file__).resolve().parents[3]
RUNNER_PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python'


def test_mcp_client_with_headers_for_a_code_only_workflow():
    code = MAFGenerator.emitMaf(code_analyzed())
    assert 'MCP_SERVER_SLUGS = {\n    "http://localhost:8770": "outlook"' in code
    assert 'var = f"MCP_HEADERS_{slug.upper()}"' in code
    assert 'for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):' in code
    assert _py_compile(code)[0] == 0


@pytest.mark.skipif(not os.path.isfile(RUNNER_PY), reason='runner venv missing')
@pytest.mark.parametrize('gen', [MAFGenerator, NOOAGenerator], ids=['MAF', 'NOOA'])
def test_a_node_named_like_a_module_does_not_shadow_it(tmp_path, gen):
    """Review I2: a node named like a stdlib module ("time") must not shadow it in workflow.py (MAF and NOOA
    packages)."""
    a = wf64_analyzed()
    a['agents']['2']['name'] = 'time'   # the dispatcher's module would be agents/time.py
    a['package'] = True
    workflow, common, nodes = gen.packageFiles(a)
    (tmp_path / 'agents').mkdir()
    (tmp_path / 'workflow.py').write_text(workflow, encoding='utf-8')
    (tmp_path / 'common.py').write_text(common + '\n' + CompiledRuntimeEmit.packageCommonBlock(), encoding='utf-8')
    for f in nodes:
        (tmp_path / f['path']).write_text(f['code'], encoding='utf-8')
    (tmp_path / 'code_harness.py').write_text(
        (REPO / 'frontend/assets/py/code_node_harness.py').read_text(encoding='utf-8'), encoding='utf-8')
    p = subprocess.run([RUNNER_PY, '-W', 'ignore', '-c', 'import workflow; print(workflow.time.sleep.__name__)'],
                       cwd=tmp_path, capture_output=True, text=True, env={**os.environ, 'ANTHROPIC_API_KEY': 'x'})
    assert p.returncode == 0, gen.__name__ + '\n' + p.stdout + p.stderr
    assert p.stdout.strip().splitlines()[-1] == 'sleep'
