"""Port of backend/tests/Unit/SwarmRewriterTest.php: the swarm rewrite, driven by the shared contract in
backend/tests/fixtures/swarm/rewrite-cases.json (read in place; PHP and JS are tested against it too)."""
from __future__ import annotations

import json

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.swarm_rewriter import SwarmRewriter
from tests.unit import lg_support as S

_CASES = json.loads((S.PHP_FIXTURES / 'swarm' / 'rewrite-cases.json').read_text(encoding='utf-8'))['cases']


@pytest.mark.parametrize('graph,expect', [(c['graph'], c['expect']) for c in _CASES], ids=[c['name'] for c in _CASES])
def test_rewrite_matches_the_contract(graph, expect):
    got = SwarmRewriter.rewrite(graph)
    if not expect.get('ok'):
        assert got['ok'] is False, 'expected a refusal'
        assert got['error'] == expect['error']
        assert list(got['nodes']) == expect['nodes'], 'the refusal must name the offending nodes'
        return
    assert got['ok'] is True, 'expected acceptance, got: ' + str(got.get('error', '?'))
    assert [str(k) for k in got['agents']] == expect['agents'], 'agents, by node id'
    assert got['entry'] == expect['entry']
    pairs = sorted([str(i), str(to)] for i, a in got['agents'].items() for to in a['handoffs'])
    assert sorted(expect['handoffs']) == pairs
    for needle in expect.get('guide_contains') or []:
        allg = '\n'.join(a['instructions'] for a in got['agents'].values())
        assert needle in allg, f'guide should mention: {needle}'
    for i, tools in (expect.get('tools_by_agent') or {}).items():
        assert got['agents'][i]['tools'] == tools, f'tools of agent {i}'
    for i, skills in (expect.get('skills_by_agent') or {}).items():
        assert got['agents'][i]['skills'] == skills, f'skills of agent {i}'


def test_the_guide_lists_each_colleague_with_its_own_role_summary():
    guide = SwarmRewriter.handoffGuide([
        {'name': 'Human resources', 'role': 'leave and payroll'},
        {'name': 'IT claims', 'role': 'passwords and access'},
    ])
    for needle in ('Human resources', 'leave and payroll', 'IT claims', 'passwords and access'):
        assert needle in guide
    assert 'Do not hand back' in guide, 'the volley guard must be present'


def test_workflow_carries_an_orchestration_defaulting_to_workflow():
    w = Workflow({'id': 1, 'name': 'x', 'user_id': '3'})
    assert w.getOrchestration() == 'workflow', 'default'
    assert w.toArray().get('orchestration') == 'workflow'
    s = Workflow({'id': 2, 'name': 'y', 'user_id': '3', 'orchestration': 'swarm'})
    assert s.getOrchestration() == 'swarm'
    assert s.toArray().get('orchestration') == 'swarm'
    assert Workflow({'id': 3, 'name': 'z', 'user_id': '3', 'orchestration': 'nonsense'}).getOrchestration() == 'workflow'
