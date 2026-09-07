"""Ported one-to-one from backend/tests/Unit/AgentTeam/DispatchRoutingTest.php
(same inputs, same expected values). The oracle's last test case,
testRunnerApplyRouteQueuesOnlyChosenAndMarksSkippedAsDone, exercises
GraphWorkflowRunner::applyRoute — out of scope for this task (only
DispatchRouting + PromptTemplateProcessor are ported here); it belongs
with the GraphWorkflowRunner port.

Dispatcher agents: outgoing edges are a MENU of branches the model picks
from by name (route_to), never a parallel fan-out. Exactly one branch runs;
the others (and anything reachable only through them) are skipped.
"""
from app.agent_team.services.dispatch_routing import DispatchRouting


def _graph():
    """Start(1) -> Dispatcher(2) -> {Sales(3), Billing(4)}; Sales->Followup(5);
    {Followup, Billing}->Output(6)"""
    nodes = {
        1: {'id': 1, 'node_type': 'start', 'config': {}},
        2: {'id': 2, 'node_type': 'agent', 'config': {'agent_name': 'Receptionist'}},
        3: {'id': 3, 'node_type': 'agent', 'config': {'agent_name': 'Sales'}},
        4: {'id': 4, 'node_type': 'agent', 'config': {'name': 'Billing'}},
        5: {'id': 5, 'node_type': 'agent', 'config': {'agent_name': 'Followup'}},
        6: {'id': 6, 'node_type': 'output', 'config': {}},
    }

    def e(f, t):
        return {'from_node_id': f, 'to_node_id': t}

    edges = [e(1, 2), e(2, 3), e(2, 4), e(3, 5), e(5, 6), e(4, 6)]
    return nodes, edges


def test_targets_are_downstream_agent_nodes_by_name():
    nodes, edges = _graph()
    t = DispatchRouting.targets(2, edges, nodes)
    assert t == [{'id': 3, 'name': 'Sales'}, {'id': 4, 'name': 'Billing'}]
    # The output node is not a target
    assert DispatchRouting.targets(5, edges, nodes) == []


def test_tool_definition_enumerates_target_names():
    nodes, edges = _graph()
    def_ = DispatchRouting.toolDefinition(DispatchRouting.targets(2, edges, nodes))
    assert def_['name'] == 'route_to'
    assert def_['input_schema']['properties']['target']['enum'] == ['Sales', 'Billing']
    assert def_['input_schema']['required'] == ['target']
    assert 'notes' in def_['input_schema']['properties']


def test_prompt_block_names_every_target_and_the_tool():
    nodes, edges = _graph()
    p = DispatchRouting.promptBlock(DispatchRouting.targets(2, edges, nodes))
    assert 'Sales' in p
    assert 'Billing' in p
    assert 'route_to' in p


def test_resolve_matches_target_name_case_insensitively():
    nodes, edges = _graph()
    targets = DispatchRouting.targets(2, edges, nodes)
    calls = [{'name': 'route_to', 'input': {'target': 'billing', 'notes': 'invoice #42'}}]
    assert DispatchRouting.resolve(calls, targets) == {'id': 4, 'name': 'Billing', 'notes': 'invoice #42'}
    assert DispatchRouting.resolve([{'name': 'route_to', 'input': {'target': 'Legal'}}], targets) is None
    assert DispatchRouting.resolve([], targets) is None
    assert DispatchRouting.resolve([{'name': 'run_skill_script', 'input': {}}], targets) is None


def test_skip_set_cascades_through_branches_reachable_only_via_skipped_nodes():
    _, edges = _graph()
    # Chose Billing(4): Sales(3) skipped, Followup(5) only reachable via Sales -> skipped;
    # Output(6) also fed by Billing -> NOT skipped.
    assert DispatchRouting.skipSet([3], edges) == [3, 5]
    # Chose Sales(3): only Billing(4) skipped; Output(6) still fed by Followup.
    assert DispatchRouting.skipSet([4], edges) == [4]


def test_default_instructions_name_the_agent_instead_of_inheriting_a_persona():
    p = DispatchRouting.defaultInstructions('Human resources', 'HR desk', 'Dispatcher demo')
    assert 'You are "Human resources"' in p
    assert 'HR desk' in p
    assert 'Dispatcher demo' in p
    # No description -> still a usable prompt
    assert 'You are "IT claims"' in DispatchRouting.defaultInstructions('IT claims', '', 'wf')


def test_routed_prompt_tells_the_target_who_sent_it_and_not_to_reroute():
    p = DispatchRouting.routedPrompt('Human resources', 'techBuddy', 'vacation question')
    assert '## Routed request' in p
    assert 'techBuddy' in p
    assert 'vacation question' in p
    assert 'Do not redirect' in p
    assert 'Notes' not in DispatchRouting.routedPrompt('X', 'Y', '')


def test_routed_by_finds_the_dispatcher_that_chose_this_node():
    nodes, edges = _graph()
    outputs = {2: {'agent_name': 'Receptionist', 'route': {'id': 4, 'name': 'Billing', 'notes': 'invoice'}}}
    assert DispatchRouting.routedBy(4, edges, outputs) == {'from': 'Receptionist', 'notes': 'invoice'}
    assert DispatchRouting.routedBy(3, edges, outputs) is None  # Sales was not chosen
    assert DispatchRouting.routedBy(4, edges, {}) is None        # no dispatcher ran


# --- Extra cases beyond the PHP oracle -------------------------------------

def test_targets_uses_agent_id_fallback_name_when_config_has_no_name():
    nodes = {
        1: {'id': 1, 'node_type': 'agent', 'config': {}},
        2: {'id': 2, 'node_type': 'agent', 'config': {'agent_name': 'A'}},
    }
    edges = [{'from_node_id': 2, 'to_node_id': 1}]
    assert DispatchRouting.targets(2, edges, nodes) == [{'id': 1, 'name': 'Agent 1'}]


def test_resolve_ignores_calls_before_a_matching_route_to():
    nodes, edges = _graph()
    targets = DispatchRouting.targets(2, edges, nodes)
    calls = [
        {'name': 'route_to', 'input': {'target': 'Legal'}},   # unknown target, skipped
        {'name': 'route_to', 'input': {'target': 'sales'}},   # matches
    ]
    assert DispatchRouting.resolve(calls, targets) == {'id': 3, 'name': 'Sales', 'notes': ''}


def test_resolve_reads_arguments_key_when_input_is_absent():
    nodes, edges = _graph()
    targets = DispatchRouting.targets(2, edges, nodes)
    calls = [{'name': 'route_to', 'arguments': {'target': 'Billing'}}]
    assert DispatchRouting.resolve(calls, targets) == {'id': 4, 'name': 'Billing', 'notes': ''}


def test_skip_set_empty_when_all_direct_targets_chosen():
    _, edges = _graph()
    assert DispatchRouting.skipSet([], edges) == []
