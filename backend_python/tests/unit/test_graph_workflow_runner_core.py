"""Unit tests for app.agent_team.services.graph_workflow_runner (Task 5a).

Oracles ported one-to-one:
  - GraphWorkflowPricingTest.php -> test_get_provider_pricing_*
  - NodeLogFormatTest.php -> test_node_log_format_*
  - DispatchRoutingTest::testRunnerApplyRouteQueuesOnlyChosenAndMarksSkippedAsDone
    -> test_apply_route_queues_only_chosen_and_marks_skipped_as_done (same graph,
    same node ids, same assertions as the PHP oracle).

No PHP oracle exists for the rest (GraphWorkflowRunnerTest.php doesn't exist
in backend/tests/Unit/AgentTeam — confirmed via
`find backend/tests -iname '*GraphWorkflowRunner*'` returning nothing), so
those are written from the PHP source directly, per the Task 5a brief:
run() over a 3-node linear graph (event sequence, execution rows, final
output), merge-strategy exact text, output-node schema extraction, trace
recording params, and archive output shaping.

ExecutionTraceStorePricingTest.php is NOT re-tested here — it targets
ExecutionTraceStore (already delivered + tested elsewhere,
tests/unit/test_execution_trace_store.py); this file only covers the
runner-facing surface (GraphWorkflowRunner._getProviderPricing /
_computeNodeCost), per the Task 5a brief ("the runner-facing parts").
"""
from __future__ import annotations

import pytest

from app.agent_team.models.agent import Agent
from app.agent_team.models.workflow import Workflow
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner, NodeLogFormat


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeDb:
    """Records inserts/executes; every SELECT returns None/[] unless the
    caller substitutes a specialized db (see PricingFakeDb below) — matches
    every collaborator this file's tests actually exercise (ensureTable's
    SHOW TABLES probe, SELECT 1 pings, user-info/workflow/pricing lookups
    all degrade gracefully to "not found" without raising)."""

    def __init__(self):
        self.inserts: list = []
        self.executes: list = []
        self._next_id = 100

    def insert(self, sql, params=None):
        self.inserts.append((sql, params))
        self._next_id += 1
        return self._next_id

    def execute(self, sql, params=None):
        self.executes.append((sql, params))
        return 1

    def fetch_one(self, sql, params=None):
        return None

    def fetch_all(self, sql, params=None):
        return []


class PricingFakeDb(FakeDb):
    """Every fetch_one returns the configured row (or None) — used for the
    getProviderPricing/computeNodeCost oracle cases, mirroring
    GraphWorkflowPricingTest.php's Mockery PDO stub."""

    def __init__(self, row):
        super().__init__()
        self._row = row

    def fetch_one(self, sql, params=None):
        return self._row


class FakeGraphRepository:
    def __init__(self, nodes: list, edges: list):
        self.nodes = nodes
        self.edges = edges

    def findStartNode(self, workflow_id):
        for n in self.nodes:
            if n['node_type'] == 'start':
                return n
        return None

    def getGraph(self, workflow_id):
        return {'nodes': self.nodes, 'edges': self.edges}


class FakeAgentRepository:
    def __init__(self, agents=None):
        self._by_id = {a.getId(): a for a in (agents or [])}

    def findById(self, agent_id):
        return self._by_id.get(agent_id)


class FakeAgentRunner:
    """Fake AgentRunner (Task 2 doesn't exist yet — see module docstring in
    graph_workflow_runner.py). `.run()` matches PHP AgentRunner::run()'s
    return shape: a dict with at least `text`, optionally `success`/`usage`/
    `pending_client_tool_call`."""

    def __init__(self, responses=None, default=None):
        self.calls: list = []
        self.responses = responses or {}
        self.default = default or {
            'text': 'ok', 'success': True, 'usage': {'input_tokens': 1, 'output_tokens': 1},
        }

    def run(self, agent, task, conversation_history, user_id, context):
        call = {
            'agent': agent.getName(), 'task': task,
            'history': list(conversation_history), 'context': dict(context),
        }
        self.calls.append(call)
        name = agent.getName()
        if name in self.responses:
            resp = self.responses[name]
            if callable(resp):
                return resp(call)
            return dict(resp)
        return dict(self.default)


class RecordingStreamContext:
    def __init__(self):
        self.events: list = []

    def emit(self, data: dict) -> None:
        self.events.append(data)


class FakeTraceStore:
    def __init__(self):
        self.inserted: list = []

    def insert(self, t: dict):
        self.inserted.append(t)
        return 1


def _node(id_: int, node_type: str, config: dict | None = None, agent_id=None) -> dict:
    return {'id': id_, 'node_type': node_type, 'config': config or {}, 'agent_id': agent_id, 'drawflow_node_id': None}


def _edge(f: int, t: int, to_port: str = 'input_1') -> dict:
    return {'from_node_id': f, 'to_node_id': t, 'to_port': to_port}


def _make_runner(nodes, edges, agents=None, responses=None, config=None, db=None):
    db = db if db is not None else FakeDb()
    graphRepo = FakeGraphRepository(nodes, edges)
    agentRepo = FakeAgentRepository(agents)
    agentRunner = FakeAgentRunner(responses)
    runner = GraphWorkflowRunner(db, agentRepo, agentRunner, graphRepo, config if config is not None else {})
    return runner, db, agentRunner


def _wf(workflow_id=1, name='WF'):
    wf = Workflow()
    wf.setId(workflow_id)
    wf.setName(name)
    return wf


# ---------------------------------------------------------------------------
# run(): 3-node linear graph (Start -> Agent -> Output) — event sequence,
# execution rows, final output.
# ---------------------------------------------------------------------------

def test_run_three_node_linear_graph_success():
    nodes = [
        _node(1, 'start'),
        _node(2, 'agent', config={'agent_name': 'Writer', 'instructions': 'Write it.', 'provider': 'claude'}),
        _node(3, 'output'),
    ]
    edges = [_edge(1, 2), _edge(2, 3)]
    responses = {'Writer': {'text': 'Hello output', 'success': True, 'usage': {'input_tokens': 10, 'output_tokens': 5}}}
    runner, db, agentRunner = _make_runner(nodes, edges, responses=responses)
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    result = runner.run(_wf(), userId=7, inputVariables={'prompt': 'Hi'})

    assert result['success'] is True
    assert result['output'] == 'Hello output'
    assert result['nodes_executed'] == 3
    assert result['node_outputs'][2]['output'] == 'Hello output'
    assert result['node_outputs'][2]['agent_name'] == 'Writer'
    assert result['node_outputs'][3]['output'] == 'Hello output'
    assert result['workflow'] == {'id': 1, 'name': 'WF'}
    assert 'response_time_ms' in result

    # Start's output feeds the first agent via buildContextForNode (single
    # input -> passed through as-is), so the agent receives the
    # "Do your job on the following input" wrapper, not the raw prompt.
    assert agentRunner.calls[0]['task'] == 'Do your job on the following input:\n\nHi'

    event_types = [e['type'] for e in stream.events]
    assert event_types == [
        'workflow_start',
        'node_start', 'node_complete',   # Start node
        'node_start',                    # agent node_start
        'node_log', 'node_log',          # calling provider, generating final output
        'node_complete', 'node_trace',   # agent node finish + trace
        'node_start', 'node_complete',   # output node
        'workflow_complete',
    ]
    assert stream.events[4]['message'] == 'calling claude'
    assert stream.events[5]['message'] == 'generating final output'

    # Execution rows. (db.inserts also carries the trace-store insert for the
    # agent node — ExecutionTraceStore.insert() and createExecution() share
    # the same Db.insert() call surface — so filter rather than count all.)
    execution_inserts = [c for c in db.inserts if "INSERT INTO agent_workflow_executions" in c[0]]
    assert len(execution_inserts) == 1
    assert any("status = 'completed'" in sql for sql, _ in db.executes)


def test_run_failure_path_fails_execution_and_emits_workflow_error():
    # No Start node -> RuntimeError('Workflow has no Start node').
    runner, db, _ = _make_runner([], [])
    stream = RecordingStreamContext()
    runner.setStreamContext(stream)

    result = runner.run(_wf(), userId=1)

    assert result['success'] is False
    assert result['error'] == 'Workflow has no Start node'
    assert result['execution_id'] is not None
    assert any("status = 'failed'" in sql for sql, _ in db.executes)
    assert [e['type'] for e in stream.events][-1] == 'workflow_error'


# ---------------------------------------------------------------------------
# Dispatcher routing: DispatchRoutingTest::
# testRunnerApplyRouteQueuesOnlyChosenAndMarksSkippedAsDone, ported 1:1.
# Start(1) -> Dispatcher(2) -> {Sales(3), Billing(4)}; Sales->Followup(5);
# {Followup, Billing} -> Output(6).
# ---------------------------------------------------------------------------

def _dispatch_edges():
    return [
        _edge(1, 2), _edge(2, 3), _edge(2, 4), _edge(3, 5), _edge(5, 6), _edge(4, 6),
    ]


def test_apply_route_queues_only_chosen_and_marks_skipped_as_done():
    edges = _dispatch_edges()
    runner, _, _ = _make_runner([], [])

    queue: list = []
    executed = [1, 2]
    output = {'type': 'agent', 'route': {'id': 4, 'name': 'Billing', 'notes': ''}}
    routed = runner._applyRoute(2, output, edges, queue, executed)

    assert routed is True
    assert queue == [4]
    # Skipped nodes count as done so the merge at Output(6) is not blocked.
    assert executed == [1, 2, 3, 5]

    # A plain agent output is not a route.
    q2: list = []
    ex2 = [1, 2]
    assert runner._applyRoute(2, {'type': 'agent', 'output': 'hi'}, edges, q2, ex2) is False
    assert q2 == []


# ---------------------------------------------------------------------------
# Merge strategies — exact text.
# ---------------------------------------------------------------------------

def test_format_numbered_inputs_exact_text():
    runner, _, _ = _make_runner([], [])
    inputs = [{'source': 'A', 'content': 'x'}, {'source': 'B', 'content': 'y'}]
    assert runner._formatNumberedInputs(inputs) == '[Input 1 - A]\nx\n\n[Input 2 - B]\ny'


def test_format_xml_inputs_exact_text():
    runner, _, _ = _make_runner([], [])
    inputs = [{'source': 'A', 'content': 'x'}]
    assert runner._formatXmlInputs(inputs) == '<input source="A" index="1">\nx\n</input>'


def test_format_labeled_inputs_exact_text():
    runner, _, _ = _make_runner([], [])
    inputs = [{'source': 'A', 'content': 'x'}, {'source': 'B', 'content': 'y'}]
    assert runner._formatLabeledInputs(inputs) == '[A]:\nx\n\n[B]:\ny'


def test_apply_merge_strategy_concatenate():
    runner, _, _ = _make_runner([], [])
    inputs = [{'source': 'A', 'content': 'x'}, {'source': 'B', 'content': 'y'}]
    assert runner._applyMergeStrategy(inputs, 'concatenate') == 'x\n\ny'


def test_apply_merge_strategy_json_pretty_unescaped_unicode_escaped_slashes():
    runner, _, _ = _make_runner([], [])
    inputs = [{'source': 'A', 'content': 'x'}]
    result = runner._applyMergeStrategy(inputs, 'json')
    assert result == '[\n    {\n        "source": "A",\n        "content": "x"\n    }\n]'


def test_apply_merge_strategy_unknown_falls_back_to_labeled():
    runner, _, _ = _make_runner([], [])
    inputs = [{'source': 'A', 'content': 'x'}]
    assert runner._applyMergeStrategy(inputs, 'bogus') == runner._formatLabeledInputs(inputs)


def test_build_context_for_node_single_input_bypasses_merge_strategy():
    runner, _, _ = _make_runner([], [])
    runner.nodeOutputs = {1: {'agent_name': 'Alpha', 'output': 'solo content'}}
    edges = [_edge(1, 2)]
    assert runner._buildContextForNode(2, edges, [1], 'numbered') == 'solo content'


def test_build_context_for_node_structured_output_wraps_json_block():
    runner, _, _ = _make_runner([], [])
    runner.nodeOutputs = {
        1: {'agent_name': 'Alpha', 'output': 'plain'},
        2: {'agent_name': 'Beta', 'output': '{"a":1}', 'structured': {'a': 1}, 'schema_name': 'out1'},
    }
    edges = [_edge(1, 3), _edge(2, 3)]
    result = runner._buildContextForNode(3, edges, [1, 2], 'labeled')
    assert '```json schema="out1"\n{"a":1}\n```' in result
    assert '[Alpha]:\nplain' in result


# ---------------------------------------------------------------------------
# Output node with schema — executeAgentNode structured-output extraction.
# ---------------------------------------------------------------------------

def test_resolve_output_schema_inline_with_schema_key():
    runner, _, _ = _make_runner([], [])
    config = {'output_schema': {'name': 'my_schema', 'description': 'd', 'strict': False, 'schema': {'type': 'object'}}}
    assert runner._resolveOutputSchema(config, userId=1) == {
        'name': 'my_schema', 'description': 'd', 'strict': False, 'schema': {'type': 'object'},
    }


def test_resolve_output_schema_bare_json_schema_gets_defaults():
    runner, _, _ = _make_runner([], [])
    config = {'output_schema': {'type': 'object', 'properties': {}}}
    assert runner._resolveOutputSchema(config, userId=1) == {
        'name': 'output', 'description': '', 'strict': True, 'schema': {'type': 'object', 'properties': {}},
    }


def test_resolve_output_schema_none_when_not_configured():
    runner, _, _ = _make_runner([], [])
    assert runner._resolveOutputSchema({}, userId=1) is None


def test_execute_agent_node_extracts_structured_output_from_inline_schema():
    node = _node(2, 'agent', config={
        'agent_name': 'Extractor', 'instructions': 'x', 'provider': 'claude',
        'output_schema': {'schema': {'type': 'object', 'properties': {'a': {'type': 'string'}}}},
    })
    responses = {'Extractor': {'text': '{"a": "b"}', 'success': True, 'usage': None}}
    runner, _, agentRunner = _make_runner([node], [], responses=responses)

    output = runner._executeAgentNode(node, userId=1, userPrompt='hi', edges=[], executedNodes=[1])

    assert output['output'] == '{"a": "b"}'
    assert output['structured'] == {'a': 'b'}
    assert output['schema_name'] == 'output'
    assert output['success'] is True
    assert agentRunner.calls[0]['task'] == 'hi'  # no incoming edges -> raw userPrompt


def test_execute_agent_node_schema_configured_but_non_json_output_leaves_structured_none():
    node = _node(2, 'agent', config={
        'agent_name': 'Extractor', 'instructions': 'x', 'provider': 'claude',
        'output_schema': {'schema': {'type': 'object'}},
    })
    responses = {'Extractor': {'text': 'not json', 'success': True, 'usage': None}}
    runner, _, _ = _make_runner([node], [], responses=responses)

    output = runner._executeAgentNode(node, userId=1, userPrompt='hi', edges=[], executedNodes=[1])

    assert output['structured'] is None
    assert output['output'] == 'not json'


# ---------------------------------------------------------------------------
# Trace recording params.
# ---------------------------------------------------------------------------

def test_record_execution_trace_passes_expected_params():
    runner, _, _ = _make_runner([], [])
    fake_trace = FakeTraceStore()
    runner.traceStore = fake_trace
    runner.runId = 'abc123'
    runner.currentWorkflowId = 42
    node = _node(7, 'agent', config={'bound_skill': {'dir_name': 'geo/content'}})

    runner._recordExecutionTrace(node, 'claude', 'claude-sonnet', True, 'final text', 10, 20)

    assert len(fake_trace.inserted) == 1
    t = fake_trace.inserted[0]
    assert t['run_id'] == 'abc123'
    assert t['env'] == 'workflow'
    assert t['invocation_mode'] == 'workflow_node'
    assert t['workflow_id'] == 42
    assert t['node_id'] == 7
    assert t['provider'] == 'claude'
    assert t['model'] == 'claude-sonnet'
    assert t['skill_dir'] == 'geo/content'
    assert t['script'] is None
    assert t['argv'] == []
    assert t['final_text'] == 'final text'
    assert t['success'] is True
    assert t['error_text'] is None
    assert t['tokens_in'] == 10
    assert t['tokens_out'] == 20
    # ts looks like a date('Y-m-d H:i:s') string.
    assert len(t['ts']) == 19 and t['ts'][4] == '-' and t['ts'][10] == ' '


def test_record_execution_trace_failure_sets_error_text_to_output():
    runner, _, _ = _make_runner([], [])
    fake_trace = FakeTraceStore()
    runner.traceStore = fake_trace
    node = _node(1, 'agent')

    runner._recordExecutionTrace(node, 'openai', 'gpt', False, 'boom', 0, 0)

    t = fake_trace.inserted[0]
    assert t['success'] is False
    assert t['error_text'] == 'boom'


# ---------------------------------------------------------------------------
# Archive output shaping.
# ---------------------------------------------------------------------------

def test_is_html_shaped_detects_doctype():
    runner, _, _ = _make_runner([], [])
    assert runner._isHtmlShaped('<!DOCTYPE html><html><body>x</body></html>') is True


def test_is_html_shaped_plain_markdown_with_one_inline_tag_is_false():
    runner, _, _ = _make_runner([], [])
    content = '# Title\n\nSome *markdown* text with a <b>little</b> bold.'
    assert runner._isHtmlShaped(content) is False


def test_is_html_shaped_dense_fragment_crosses_tag_density_threshold():
    runner, _, _ = _make_runner([], [])
    content = '<div><h1>Title</h1><p>Body text here that is short</p></div>'
    assert runner._isHtmlShaped(content) is True


def test_is_html_shaped_empty_is_false():
    runner, _, _ = _make_runner([], [])
    assert runner._isHtmlShaped('   ') is False


def test_build_archive_output_returns_plain_markdown_as_is():
    runner, _, _ = _make_runner([], [])
    assert runner._buildArchiveOutput('Plain markdown result') == 'Plain markdown result'


def test_build_archive_output_html_falls_back_to_walk_back_heuristic():
    # No Python port of league/html-to-markdown -> PHP's own
    # class_exists()-guarded fallback path is exercised (module docstring).
    runner, _, _ = _make_runner([], [])
    runner.nodeOutputs = {
        1: {'output': 'upstream markdown result'},
        2: {'output': '<html><body>final html</body></html>'},
    }
    result = runner._buildArchiveOutput('<html><body>final html</body></html>')
    assert result == 'upstream markdown result'


def test_pick_markdown_agent_output_falls_back_to_most_recent_when_all_html():
    runner, _, _ = _make_runner([], [])
    runner.nodeOutputs = {
        1: {'output': '<html>a</html>'},
        2: {'output': '<html>b</html>'},
    }
    assert runner._pickMarkdownAgentOutput() == '<html>b</html>'


def test_pick_markdown_agent_output_empty_when_nothing_recorded():
    runner, _, _ = _make_runner([], [])
    assert runner._pickMarkdownAgentOutput() == ''


# ---------------------------------------------------------------------------
# GraphWorkflowPricingTest.php ported 1:1 (runner-facing pricing).
# ---------------------------------------------------------------------------

def test_get_provider_pricing_returns_db_price_when_configured():
    runner, _, _ = _make_runner(
        [], [], db=PricingFakeDb({'price_input_per_1m': '2.5000', 'price_output_per_1m': '10.0000'})
    )
    assert runner._getProviderPricing('openai') == [2.5, 10.0]


def test_get_provider_pricing_returns_null_pair_when_unavailable():
    runner, _, _ = _make_runner([], [], db=PricingFakeDb(None))
    assert runner._getProviderPricing('gemini') == [None, None]


def test_compute_node_cost_with_pricing_row():
    runner, _, _ = _make_runner(
        [], [], db=PricingFakeDb({'price_input_per_1m': '1.0', 'price_output_per_1m': '2.0'})
    )
    cost = runner._computeNodeCost('openai', 1_000_000, 500_000)
    assert cost == 2.0


def test_compute_node_cost_none_when_provider_missing():
    runner, _, _ = _make_runner([], [], db=PricingFakeDb(None))
    assert runner._computeNodeCost(None, 100, 100) is None


def test_compute_node_cost_none_when_pricing_unavailable():
    runner, _, _ = _make_runner([], [], db=PricingFakeDb(None))
    assert runner._computeNodeCost('gemini', 100, 100) is None


# ---------------------------------------------------------------------------
# Bound-skill tooling.
# ---------------------------------------------------------------------------

def test_get_bound_skill_scripts_filters_unsafe_and_dedupes():
    runner, _, _ = _make_runner([], [])
    runner.clientSkills = {
        'geo/content': {'scripts': ['a.py', '/etc/passwd', '../evil.py', 'a.py', 'b.py', 123]},
    }
    config = {'bound_skill': {'source': 'local', 'dir_name': 'geo/content'}}
    assert runner._getBoundSkillScripts(config) == ['a.py', 'b.py']


def test_get_bound_skill_scripts_empty_when_not_local():
    runner, _, _ = _make_runner([], [])
    config = {'bound_skill': {'source': 'db', 'dir_name': 'x'}}
    assert runner._getBoundSkillScripts(config) == []


def test_build_run_skill_script_tool_shape():
    runner, _, _ = _make_runner([], [])
    tool = runner._buildRunSkillScriptTool({'dir_name': 'geo/content', 'scripts': ['a.py', 'b.py']})
    assert tool['name'] == 'run_skill_script'
    assert 'geo/content' in tool['description']
    assert tool['input_schema']['properties']['script']['enum'] == ['a.py', 'b.py']
    assert tool['input_schema']['required'] == ['script']


# ---------------------------------------------------------------------------
# Graph-traversal primitives.
# ---------------------------------------------------------------------------

def test_index_nodes_by_id():
    runner, _, _ = _make_runner([], [])
    nodes = [_node(1, 'start'), _node(2, 'agent')]
    assert runner._indexNodesById(nodes) == {1: nodes[0], 2: nodes[1]}


def test_get_next_node_ids():
    runner, _, _ = _make_runner([], [])
    edges = [_edge(1, 2), _edge(1, 3), _edge(2, 3)]
    assert runner._getNextNodeIds(1, edges) == [2, 3]


def test_can_execute_node_requires_all_incoming_executed():
    runner, _, _ = _make_runner([], [])
    edges = [_edge(1, 3), _edge(2, 3)]
    assert runner._canExecuteNode(3, edges, [1]) is False
    assert runner._canExecuteNode(3, edges, [1, 2]) is True


def test_find_agent_nodes_in_list_skips_executed_and_non_agent():
    runner, _, _ = _make_runner([], [])
    nodes = {1: _node(1, 'agent'), 2: _node(2, 'output'), 3: _node(3, 'agent')}
    assert runner._findAgentNodesInList([1, 2, 3], nodes, executedNodes=[3]) == [nodes[1]]


# ---------------------------------------------------------------------------
# buildDocumentsContext: real for the empty-documents case; defers to the
# literal Task 5b leaf stubs when documents are present (module docstring).
# ---------------------------------------------------------------------------

def test_build_documents_context_empty_when_no_documents():
    runner, _, _ = _make_runner([], [])
    assert runner._buildDocumentsContext(_node(1, 'start', config={})) == ''
    assert runner._buildDocumentsContext(_node(1, 'start', config={'documents': []})) == ''


def test_build_documents_context_defers_to_task_5b_stub_when_documents_present():
    runner, _, _ = _make_runner([], [])
    node = _node(1, 'agent', config={'documents': [{'name': 'a.txt', 'mimeType': 'text/plain'}]})
    try:
        runner._buildDocumentsContext(node)
        assert False, 'expected the isImageFile Task 5b stub to raise'
    except NotImplementedError as e:
        assert str(e) == 'Task 5b'


# ---------------------------------------------------------------------------
# Task 5b stubs — spot-check a representative few raise with PHP's signature
# shape honored (params accepted, NotImplementedError('Task 5b') raised).
# ---------------------------------------------------------------------------

def test_task_5b_parallel_stubs_raise_not_implemented():
    runner, _, _ = _make_runner([], [])

    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._executeAgentsInParallel([], 1, 'x', [], [])
    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._getParallelExecutor()
    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._isClientSideToolName('run_skill_script')
    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._buildAgentLLMRequest(Agent({'name': 'x'}), 'task')


def test_task_5b_document_leaf_stubs_raise_not_implemented():
    runner, _, _ = _make_runner([], [])

    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._isImageFile('image/png')
    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._readDocumentContent({'name': 'a.txt'})
    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._getUserStorageProvider(1)
    with pytest.raises(NotImplementedError, match='Task 5b'):
        runner._getDocumentLocalPath('foo')


# ---------------------------------------------------------------------------
# NodeLogFormatTest.php ported 1:1.
# ---------------------------------------------------------------------------

def test_node_log_format_calling_provider_with_model():
    assert NodeLogFormat.callingProvider('grok', 'grok-4-fast') == 'calling grok (grok-4-fast)'


def test_node_log_format_calling_provider_without_model():
    assert NodeLogFormat.callingProvider('grok', None) == 'calling grok'
    assert NodeLogFormat.callingProvider('grok', '') == 'calling grok'


def test_node_log_format_model_requested_tool():
    assert NodeLogFormat.modelRequestedTool('run_skill_script') == 'model requested run_skill_script'


def test_node_log_format_model_responded_text():
    assert NodeLogFormat.modelRespondedText() == 'model responded with text'


def test_node_log_format_running_skill():
    assert NodeLogFormat.runningSkill('GEO/geo-content') == 'running skill GEO/geo-content'


def test_node_log_format_skill_finished():
    assert NodeLogFormat.skillFinished(0, 1240) == 'skill finished (exit 0, 1240 bytes)'
    assert NodeLogFormat.skillFinished(None, None) == 'skill finished (exit unknown, 0 bytes)'


def test_node_log_format_skill_timed_out():
    assert NodeLogFormat.skillTimedOut(300) == 'skill timed out after 300s'


def test_node_log_format_completed_with_cost():
    assert NodeLogFormat.completed(1840, 0.0041) == 'completed (1840 tok, $0.0041)'


def test_node_log_format_completed_without_cost():
    assert NodeLogFormat.completed(1840, None) == 'completed (1840 tok)'


def test_node_log_format_http_error():
    assert (
        NodeLogFormat.httpError(400, 'Thinking mode does not support this tool_choice')
        == 'HTTP 400 — Thinking mode does not support this tool_choice'
    )
