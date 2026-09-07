"""Port of backend/tests/Unit/Playbook/WorkflowLlmClientTest.php (87 lines, 3 cases).

Pins WorkflowLlmClient._flattenToolDefs — the nested OpenAI-style
{type:function, function:{name, description, parameters}} tool defs (the
shape PlaybookActionSpace/PlaybookNativeTools build) must convert to the
flat {name, description, input_schema} shape the rest of the AgentTeam
engine (MCPToolsLoader.getToolDefinitions, ParallelAgentExecutor,
OpenAIProvider/ClaudeProvider) expects. See the method's own docstring for
why passing the nested shape through verbatim breaks ClaudeProvider.
"""
from __future__ import annotations

from app.playbook.adapters.workflow_llm_client import WorkflowLlmClient


def _invoke_flatten(toolDefs):
    client = WorkflowLlmClient({}, {}, None)
    return client._flattenToolDefs(toolDefs)


def test_flattens_nested_function_shape():
    nested = [
        {
            'type': 'function',
            'function': {
                'name': 'leave_internal_note',
                'description': 'Leave an internal note on the run',
                'parameters': {
                    'type': 'object',
                    'properties': {'text': {'type': 'string'}},
                    'required': ['text'],
                },
            },
        },
    ]

    flat = _invoke_flatten(nested)

    assert flat == [
        {
            'name': 'leave_internal_note',
            'description': 'Leave an internal note on the run',
            'input_schema': {
                'type': 'object',
                'properties': {'text': {'type': 'string'}},
                'required': ['text'],
            },
        },
    ]


def test_missing_function_fields_default_safely():
    nested = [
        {'type': 'function', 'function': {'name': 'bare_tool'}},
    ]

    flat = _invoke_flatten(nested)

    assert flat[0]['name'] == 'bare_tool'
    assert flat[0]['description'] == ''
    assert flat[0]['input_schema'] == {'type': 'object', 'properties': {}}


def test_already_flat_defs_pass_through_unchanged():
    alreadyFlat = [
        {
            'name': 'okta__search_users',
            'description': 'Search Okta users',
            'input_schema': {'type': 'object', 'properties': {'email': {'type': 'string'}}},
        },
    ]

    flat = _invoke_flatten(alreadyFlat)

    assert flat == alreadyFlat


# ---------------------------------------------------------------------------
# _normalizeToolCalls -- B3 (Phase 5 final-review wave). PHP:
# `$args = is_string($rawArgs) ? (json_decode($rawArgs, true) ?? []) :
# (array)$rawArgs;` (WorkflowLlmClient.php:142) -- pins the non-string
# (`(array)$rawArgs`) branch.
# ---------------------------------------------------------------------------

def _invoke_normalize(toolCalls):
    client = WorkflowLlmClient({}, {}, None)
    return client._normalizeToolCalls(toolCalls)


def test_normalize_tool_calls_dict_arguments_passes_through_unchanged():
    out = _invoke_normalize([{'id': 'c1', 'function': {'name': 'x', 'arguments': {'a': 1}}}])
    assert out[0]['arguments'] == {'a': 1}


def test_normalize_tool_calls_scalar_arguments_casts_to_single_element_list():
    out = _invoke_normalize([{'id': 'c1', 'name': 'x', 'input': 5}])
    assert out[0]['arguments'] == [5]


def test_normalize_tool_calls_list_arguments_passes_through_unchanged():
    out = _invoke_normalize([{'id': 'c1', 'name': 'x', 'arguments': ['a', 'b']}])
    assert out[0]['arguments'] == ['a', 'b']


def test_normalize_tool_calls_missing_arguments_defaults_to_empty_dict():
    # rawArgs's own default chain bottoms out at `{}` (a dict, already an
    # "array") before reaching the `(array)$rawArgs` cast under test here --
    # php_array_cast() is a no-op on a dict, so this stays `{}`.
    out = _invoke_normalize([{'id': 'c1', 'name': 'x'}])
    assert out[0]['arguments'] == {}
