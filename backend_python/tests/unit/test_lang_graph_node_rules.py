"""Port of backend/tests/Unit/LangGraphNodeRulesTest.php (spec 2026-10-15 langgraph standalone §7)."""
from __future__ import annotations

import pytest

from tests.unit import lg_support as S


def _generate(mid: dict) -> dict:
    database = S.db(*S.MCP_DDL, S.LLM_DDL, "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)")
    graph = {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'hi'}}, mid,
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}}],
        'edges': [{'from_node_id': '1', 'to_node_id': '2', 'from_port': 'output_1'},
                  {'from_node_id': '2', 'to_node_id': '3', 'from_port': 'output_1'}]}
    return S.generator(database, graph, {'id': 44, 'name': 'Rules', 'user_id': '3'}).generate(44, '3', {})


def test_unconfigured_template_is_refused():
    with pytest.raises(RuntimeError, match='Unconfigured agent template node found: Claims — pick an agent or fill in its instructions.'):
        _generate({'id': '2', 'node_type': 'agent-template', 'config': {'type': 'agent-template', 'name': 'Claims', 'isTemplate': True}})


def test_configured_template_compiles_as_agent():
    code = _generate({'id': '2', 'node_type': 'agent-template', 'config': {
        'type': 'agent-template', 'name': 'Claims', 'agent_name': 'Claims', 'instructions': 'Summarize the claim.', 'provider': 'claude'}})['code']
    assert 'Summarize the claim.' in code


def test_an_untyped_node_compiles_as_an_agent():
    code = _generate({'id': '2', 'node_type': '', 'config': {
        'name': 'Claims', 'agent_name': 'Claims', 'instructions': 'Summarize the claim.', 'provider': 'claude'}})['code']
    assert 'Summarize the claim.' in code


def test_unknown_type_is_refused():
    with pytest.raises(RuntimeError) as e:
        _generate({'id': '2', 'node_type': 'loop', 'config': {'type': 'loop', 'name': 'Loop'}})
    assert 'Node "Loop" (loop) cannot be compiled: LangGraph runs start, agent, playbook, code and output nodes.' in str(e.value)
