"""Unit tests for AgentController — port of backend/src/AgentTeam/Controllers/
AgentController.php (812 lines), every method except `run` (373-430) and
`chat` (436-509), which are Phase 5 stubs raising NotImplementedError here.

PHP-truth strings copied verbatim from the source:
  - "Name is required"                                                   (117)
  - "Invalid agent_type. Must be: standard, manager, worker, dispatcher, or playbook"  (123)
  - "Invalid visibility. Must be: personal, workspace, or public"        (129)
  - "Agent not found"                                                    (180, 395, 588, 619)
  - "Agent not found or access denied"                                   (211, 291, 652, 686)
  - "old_name and new_name are required"                                 (336)
  - "name is required"                                                   (360)
  - "Cannot move agent up (already at top or not in a team)"             (659)
  - "Cannot move agent down (already at bottom or not in a team)"        (693)
  - "team_id is required"                                                (724)
  - "agent_ids array is required"                                       (728)
  - "Access denied for agent ID: "                                      (737)

The repository is faked entirely (FakeAgentRepository below) — its own SQL/
transaction behavior is pinned in tests/unit/test_agent_team_repositories.py.
This file exercises the controller's own validation, ownership branching,
response shaping, and error mapping. AIPortfolioAssistant/MCPToolsLoader are
faked for listTools() per the tools_controller.py pattern (see
tests/unit/test_tools_controller.py).
"""
from __future__ import annotations

import pytest
from starlette.datastructures import Headers

from app.agent_team.controllers.agent_controller import AgentController
from app.agent_team.models.agent import Agent
from app.support.http import Ctx

CFG = {'auth': {'jwt_secret': 'S'}, 'database': {}, 'contexts_database': {}}


def ctx(body=None, query=None, user_id=3):
    return Ctx(method='GET', uri='/', headers=Headers({}), query=query or {}, body=body or {}, raw_body='',
               params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


AGENT_ROW = {
    'id': 5, 'user_id': 3, 'team_id': 1, 'category': None, 'name': 'Alice',
    'description': 'desc', 'agent_type': 'standard', 'parent_agent_id': None,
    'can_delegate_to': '[]', 'display_order': 0, 'provider': 'claude', 'model': None,
    'instructions': 'be nice', 'tools': '[]', 'visibility': 'personal', 'enabled': 1,
    'settings': '[]', 'created_at': 'c', 'updated_at': 'u',
}


def agent(**overrides) -> Agent:
    return Agent({**AGENT_ROW, **overrides})


class FakeDb:
    """Only `executions()` reads the db directly (AgentRunner::getExecutionHistory
    is a plain SQL query, ported inline since AgentRunner itself is Phase 5)."""

    def __init__(self, all_=None):
        self.all_queue = list(all_) if all_ else []
        self.calls = []

    def fetch_all(self, sql, params=None):
        self.calls.append(('fetch_all', sql, params))
        return self.all_queue.pop(0) if self.all_queue else []


class FakeAgentRepository:
    def __init__(self):
        self.calls = []
        self.agents_by_id: dict = {}
        self.access: dict = {}
        self.owner: dict = {}
        self.accessible_agents: list = []
        self.accessible_total = 0
        self.categories: list = []
        self.rename_result = 0
        self.clear_result = 0
        self.create_result = None
        self.create_exception = None
        self.update_result = None
        self.update_exception = None
        self.delete_exception = None
        self.stats: dict = {}
        self.duplicate_result = None
        self.duplicate_exception = None
        self.move_up_result = True
        self.move_down_result = True
        self.reorder_result = {'success': True, 'reordered': False}
        self.team_agents: dict = {}
        self.team_agents_with_pipeline: dict = {}

    def _log(self, name, *args):
        self.calls.append((name, args))

    def findAccessibleByUser(self, user_id, filters):
        self._log('findAccessibleByUser', user_id, filters)
        return self.accessible_agents

    def countAccessible(self, user_id):
        self._log('countAccessible', user_id)
        return self.accessible_total

    def canUserAccess(self, user_id, agent_id):
        self._log('canUserAccess', user_id, agent_id)
        return self.access.get(agent_id, False)

    def isOwner(self, user_id, agent_id):
        self._log('isOwner', user_id, agent_id)
        return self.owner.get(agent_id, False)

    def findById(self, agent_id):
        self._log('findById', agent_id)
        return self.agents_by_id.get(agent_id)

    def create(self, a):
        self._log('create', a)
        if self.create_exception:
            raise self.create_exception
        return self.create_result

    def update(self, a):
        self._log('update', a)
        if self.update_exception:
            raise self.update_exception
        return self.update_result

    def delete(self, agent_id):
        self._log('delete', agent_id)
        if self.delete_exception:
            raise self.delete_exception
        return True

    def findDistinctCategories(self, user_id):
        self._log('findDistinctCategories', user_id)
        return self.categories

    def renameCategory(self, user_id, old, new):
        self._log('renameCategory', user_id, old, new)
        return self.rename_result

    def clearCategory(self, user_id, name):
        self._log('clearCategory', user_id, name)
        return self.clear_result

    def getAgentStats(self, agent_id):
        self._log('getAgentStats', agent_id)
        return self.stats

    def duplicate(self, agent_id, new_user_id, new_name):
        self._log('duplicate', agent_id, new_user_id, new_name)
        if self.duplicate_exception:
            raise self.duplicate_exception
        return self.duplicate_result

    def moveAgentUp(self, agent_id):
        self._log('moveAgentUp', agent_id)
        return self.move_up_result

    def moveAgentDown(self, agent_id):
        self._log('moveAgentDown', agent_id)
        return self.move_down_result

    def findByTeamId(self, team_id):
        self._log('findByTeamId', team_id)
        return self.team_agents.get(team_id, [])

    def updateAgentOrder(self, agent_ids, team_id):
        self._log('updateAgentOrder', agent_ids, team_id)
        return self.reorder_result

    def findByTeamIdWithPipelineInfo(self, team_id):
        self._log('findByTeamIdWithPipelineInfo', team_id)
        return self.team_agents_with_pipeline.get(team_id, [])


def controller(monkeypatch, repo=None, db=None):
    repo = repo if repo is not None else FakeAgentRepository()
    monkeypatch.setattr('app.agent_team.controllers.agent_controller.AgentRepository', lambda db: repo)
    return AgentController(db if db is not None else FakeDb(), CFG), repo


# ============================================================================
# index
# ============================================================================

def test_index_defaults_and_null_filters_removed(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.accessible_agents = [agent()]
    repo.accessible_total = 1
    r = c.index(ctx())
    assert r['success'] is True
    assert r['data'][0]['id'] == 5
    assert r['meta'] == {'total': 1, 'count': 1, 'limit': 100, 'offset': 0}
    call = next(cc for cc in repo.calls if cc[0] == 'findAccessibleByUser')
    assert call[1] == (3, {'limit': 100, 'offset': 0})   # no other filters present


def test_index_maps_query_filters(monkeypatch):
    c, repo = controller(monkeypatch)
    r = c.index(ctx(query={'type': 'manager', 'provider': 'claude', 'visibility': 'public',
                            'search': 'bob', 'category': 'sales', 'limit': '10', 'offset': '5'}))
    assert r['meta'] == {'total': 0, 'count': 0, 'limit': 10, 'offset': 5}
    call = next(cc for cc in repo.calls if cc[0] == 'findAccessibleByUser')
    assert call[1] == (3, {'agent_type': 'manager', 'provider': 'claude', 'visibility': 'public',
                            'search': 'bob', 'category': 'sales', 'limit': 10, 'offset': 5})


# ============================================================================
# create
# ============================================================================

def test_create_missing_name_returns_400(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.create(ctx(body={}))
    assert r == {'success': False, 'error': 'Name is required', 'status': 400, 'status_code': 400}


def test_create_invalid_agent_type_returns_400(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.create(ctx(body={'name': 'x', 'agent_type': 'bogus'}))
    assert r == {'success': False,
                 'error': 'Invalid agent_type. Must be: standard, manager, worker, dispatcher, or playbook',
                 'status': 400, 'status_code': 400}


def test_create_invalid_visibility_returns_400(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.create(ctx(body={'name': 'x', 'visibility': 'bogus'}))
    assert r == {'success': False, 'error': 'Invalid visibility. Must be: personal, workspace, or public',
                 'status': 400, 'status_code': 400}


def test_create_success(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.create_result = agent(name='Bob')
    r = c.create(ctx(body={'name': 'Bob'}))
    assert r['success'] is True
    assert r['message'] == "Agent 'Bob' created successfully"
    assert r['data']['name'] == 'Bob'
    passed_agent = repo.calls[0][1][0]
    assert passed_agent.getUserId() == 3
    assert passed_agent.getAgentType() == 'standard'
    assert passed_agent.getVisibility() == 'personal'
    assert passed_agent.getDescription() == ''
    assert passed_agent.getTools() == []


def test_create_playbook_agent_derives_tools_via_fallback(monkeypatch):
    """DEVIATION: PlaybookAnalyzer isn't ported (feat/playbook-interpreter,
    unmerged) -- _playbookAgentToolsForUser always takes PHP's "any failure"
    branch and returns []."""
    c, repo = controller(monkeypatch)
    repo.create_result = agent(agent_type='playbook')
    c.create(ctx(body={'name': 'PB', 'agent_type': 'playbook', 'instructions': '#Action: foo'}))
    passed_agent = repo.calls[0][1][0]
    assert passed_agent.getTools() == []


def test_create_blank_instructions_does_not_trigger_playbook_derivation(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.create_result = agent(agent_type='playbook')
    c.create(ctx(body={'name': 'PB', 'agent_type': 'playbook', 'instructions': '   ', 'tools': ['manual_tool']}))
    passed_agent = repo.calls[0][1][0]
    assert passed_agent.getTools() == ['manual_tool']


def test_create_repository_exception_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.create_exception = RuntimeError('db down')
    r = c.create(ctx(body={'name': 'x'}))
    assert r == {'success': False, 'error': 'Failed to create agent: db down', 'status': 500, 'status_code': 500}


# ============================================================================
# show
# ============================================================================

def test_show_not_found_returns_404(monkeypatch):
    c, repo = controller(monkeypatch)
    r = c.show(ctx(), 999999999)
    assert r == {'success': False, 'error': 'Agent not found', 'status': 404, 'status_code': 404}


def test_show_success_without_stats(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    r = c.show(ctx(), 5)
    assert r == {'success': True, 'data': agent().toArray()}
    assert 'getAgentStats' not in [cc[0] for cc in repo.calls]


def test_show_include_stats_true(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    repo.stats = {'total_executions': 4}
    r = c.show(ctx(query={'include_stats': 'true'}), 5)
    assert r['data']['stats'] == {'total_executions': 4}


def test_show_include_stats_non_true_string_is_ignored(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    r = c.show(ctx(query={'include_stats': '1'}), 5)
    assert 'stats' not in r['data']


# ============================================================================
# update
# ============================================================================

def test_update_access_denied_returns_404(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.update(ctx(body={'name': 'New'}), 5)
    assert r == {'success': False, 'error': 'Agent not found or access denied', 'status': 404, 'status_code': 404}


def test_update_success_applies_fields(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent()
    repo.update_result = agent(name='Renamed')
    r = c.update(ctx(body={'name': 'Renamed', 'description': 'new-desc'}), 5)
    assert r['success'] is True
    assert r['message'] == "Agent 'Renamed' updated successfully"
    assert r['data']['name'] == 'Renamed'
    passed_agent = repo.calls[-1][1][0]
    assert passed_agent.getName() == 'Renamed'
    assert passed_agent.getDescription() == 'new-desc'


def test_update_null_fields_not_applied(monkeypatch):
    """isset() is false for an explicit JSON null -- field left untouched."""
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent()
    repo.update_result = agent()
    c.update(ctx(body={'name': None, 'description': None}), 5)
    passed_agent = repo.calls[-1][1][0]
    assert passed_agent.getName() == 'Alice'          # unchanged
    assert passed_agent.getDescription() == 'desc'    # unchanged


def test_update_team_id_and_category_explicit_null_resets(monkeypatch):
    """array_key_exists() is true for an explicit JSON null, unlike isset() --
    team_id/category can be explicitly reset to null."""
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent(team_id=9, category='sales')
    repo.update_result = agent()
    c.update(ctx(body={'team_id': None, 'category': None}), 5)
    passed_agent = repo.calls[-1][1][0]
    assert passed_agent.getTeamId() is None
    assert passed_agent.getCategory() is None


def test_update_playbook_type_and_instructions_derives_tools_via_fallback(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent(agent_type='playbook', instructions='#Action: foo')
    repo.update_result = agent()
    c.update(ctx(body={}), 5)
    passed_agent = repo.calls[-1][1][0]
    assert passed_agent.getTools() == []


def test_update_repository_exception_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent()
    repo.update_exception = RuntimeError('boom')
    r = c.update(ctx(body={}), 5)
    assert r == {'success': False, 'error': 'Failed to update agent: boom', 'status': 500, 'status_code': 500}


# ============================================================================
# destroy
# ============================================================================

def test_destroy_access_denied_returns_404(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.destroy(ctx(), 5)
    assert r == {'success': False, 'error': 'Agent not found or access denied', 'status': 404, 'status_code': 404}


def test_destroy_success(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent(name='Alice')
    r = c.destroy(ctx(), 5)
    assert r == {'success': True, 'message': "Agent 'Alice' deleted successfully"}
    assert ('delete', (5,)) in repo.calls


def test_destroy_repository_exception_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent()
    repo.delete_exception = RuntimeError('locked')
    r = c.destroy(ctx(), 5)
    assert r == {'success': False, 'error': 'Failed to delete agent: locked', 'status': 500, 'status_code': 500}


# ============================================================================
# listCategories / renameCategory / deleteCategory
# ============================================================================

def test_list_categories(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.categories = ['sales', 'support']
    r = c.listCategories(ctx())
    assert r == {'success': True, 'data': ['sales', 'support'], 'meta': {'count': 2}}


def test_rename_category_requires_both_names(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.renameCategory(ctx(body={'old_name': '', 'new_name': 'x'}))
    assert r == {'success': False, 'error': 'old_name and new_name are required', 'status': 400, 'status_code': 400}
    r2 = c.renameCategory(ctx(body={'old_name': 'x', 'new_name': ''}))
    assert r2['error'] == 'old_name and new_name are required'


def test_rename_category_same_name_shortcircuits(monkeypatch):
    c, repo = controller(monkeypatch)
    r = c.renameCategory(ctx(body={'old_name': 'sales', 'new_name': 'sales'}))
    assert r == {'success': True, 'data': {'affected': 0}}
    assert repo.calls == []


def test_rename_category_success(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.rename_result = 3
    r = c.renameCategory(ctx(body={'old_name': ' old ', 'new_name': ' new '}))
    assert r == {'success': True, 'data': {'affected': 3, 'old_name': 'old', 'new_name': 'new'}}
    assert repo.calls == [('renameCategory', (3, 'old', 'new'))]


def test_delete_category_requires_name(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.deleteCategory(ctx(body={}, query={}))
    assert r == {'success': False, 'error': 'name is required', 'status': 400, 'status_code': 400}


def test_delete_category_body_takes_priority_over_query(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.clear_result = 2
    r = c.deleteCategory(ctx(body={'name': 'from-body'}, query={'name': 'from-query'}))
    assert r == {'success': True, 'data': {'affected': 2, 'name': 'from-body'}}


def test_delete_category_falls_back_to_query(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.clear_result = 1
    r = c.deleteCategory(ctx(body={}, query={'name': 'from-query'}))
    assert r == {'success': True, 'data': {'affected': 1, 'name': 'from-query'}}


# ============================================================================
# listTools
# ============================================================================

class FakeToolsManager:
    def __init__(self, defs):
        self._defs = defs

    def getToolDefinitions(self):
        return self._defs


def make_fake_assistant_class(tools_manager, closed):
    class FakeAssistant:
        def __init__(self, config):
            self.config = config

        def setDatabase(self, db):
            pass

        def getToolsManager(self):
            return tools_manager

        def close(self):
            closed.append(True)

    return FakeAssistant


class FakeMCPToolsLoader:
    def __init__(self, db, defs=None, closed=None):
        self._defs = defs if defs is not None else []
        self._closed = closed
        self.load_calls = []

    def loadToolsForUser(self, userId=None, allowedServerNames=None):
        self.load_calls.append((userId, allowedServerNames))
        return {}

    def getToolDefinitions(self):
        return self._defs

    def close(self):
        if self._closed is not None:
            self._closed.append(True)


def patch_list_tools(monkeypatch, builtin_defs=None, mcp_defs=None, assistant_closed=None, mcp_closed=None):
    monkeypatch.setattr('app.agent_team.controllers.agent_controller.LLMProviderResolver.applyDbSettings',
                         staticmethod(lambda db, cfg: cfg))
    tm = FakeToolsManager(builtin_defs if builtin_defs is not None else [])
    assistant_cls = make_fake_assistant_class(tm, assistant_closed if assistant_closed is not None else [])
    monkeypatch.setattr('app.agent_team.controllers.agent_controller.AIPortfolioAssistant', assistant_cls)

    loader_holder = {}

    def mcp_factory(db):
        loader = FakeMCPToolsLoader(db, defs=mcp_defs, closed=mcp_closed)
        loader_holder['loader'] = loader
        return loader
    monkeypatch.setattr('app.agent_team.controllers.agent_controller.MCPToolsLoader', mcp_factory)
    return loader_holder


def test_list_tools_shape_and_counts(monkeypatch):
    c, _ = controller(monkeypatch)
    assistant_closed, mcp_closed = [], []
    builtin = [{'name': 'search_web', 'description': 'Search'}, {'name': 'no_desc'}]
    # Simulates PHP's actual empty-mcp-tools state (loader never loaded) --
    # left [] here deliberately; see test_list_tools_never_loads_mcp_registry
    # for the loader-populated-but-unused-because-never-loaded scenario.
    holder = patch_list_tools(monkeypatch, builtin_defs=builtin, mcp_defs=[],
                               assistant_closed=assistant_closed, mcp_closed=mcp_closed)
    r = c.listTools(ctx())
    assert r['success'] is True
    assert r['tools']['builtin'] == [
        {'name': 'search_web', 'description': 'Search', 'type': 'builtin'},
        {'name': 'no_desc', 'description': '', 'type': 'builtin'},
    ]
    assert r['tools']['mcp'] == []
    assert r['tools']['delegation'] == [
        {'name': 'delegate_to_agent', 'description': 'Delegate a task to a specialized sub-agent', 'type': 'delegation'},
        {'name': 'list_available_agents', 'description': 'List agents that can be delegated to', 'type': 'delegation'},
        {'name': 'run_agents_parallel', 'description': 'Run multiple agents in parallel', 'type': 'delegation'},
    ]
    assert r['counts'] == {'builtin': 2, 'mcp': 0, 'delegation': 3, 'total': 5}
    assert assistant_closed == [True]
    assert mcp_closed == [True]
    assert holder['loader'].load_calls == []   # never loaded -- see class docstring deviation note


def test_list_tools_never_loads_mcp_registry_even_when_defs_present(monkeypatch):
    """DEVIATION (parity with live PHP, not a fix): AgentController.php's
    listTools() never calls MCPToolsLoader::loadToolsForUser(), so on live PHP
    'mcp' is always []. This test drives a loader that WOULD return tool defs
    if asked, to prove the controller reads getToolDefinitions() as-is (mirrors
    whatever the loader holds) without ever populating it via a load call --
    matching PHP's dead code path exactly rather than "fixing" it like
    ToolsController.list() does."""
    c, _ = controller(monkeypatch)
    mcp_defs = [{'name': 'mcp_get_price', 'description': '[MCP:okta] Get the current price'}]
    holder = patch_list_tools(monkeypatch, builtin_defs=[], mcp_defs=mcp_defs)
    r = c.listTools(ctx())
    # description keeps the "[MCP:...]" prefix (AgentController does not strip it,
    # unlike ToolsController.list()); server is always None (the key doesn't exist
    # on getToolDefinitions()'s output -- see MCPToolsLoader.php:153-157).
    assert r['tools']['mcp'] == [{'name': 'mcp_get_price', 'description': '[MCP:okta] Get the current price',
                                   'type': 'mcp', 'server': None}]
    assert holder['loader'].load_calls == []


# ============================================================================
# executions
# ============================================================================

def test_executions_not_found_returns_404(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.executions(ctx(), 5)
    assert r == {'success': False, 'error': 'Agent not found', 'status': 404, 'status_code': 404}


def test_executions_default_limit_offset(monkeypatch):
    db = FakeDb(all_=[[{'id': 1, 'agent_id': 5}]])
    c, repo = controller(monkeypatch, db=db)
    repo.access[5] = True
    r = c.executions(ctx(), 5)
    assert r == {'success': True, 'data': [{'id': 1, 'agent_id': 5}], 'meta': {'count': 1, 'limit': 50, 'offset': 0}}
    assert db.calls[0][2] == [5, 50, 0]


def test_executions_custom_limit_offset(monkeypatch):
    db = FakeDb(all_=[[]])
    c, repo = controller(monkeypatch, db=db)
    repo.access[5] = True
    r = c.executions(ctx(query={'limit': '10', 'offset': '20'}), 5)
    assert r['meta'] == {'count': 0, 'limit': 10, 'offset': 20}
    assert db.calls[0][2] == [5, 10, 20]


# ============================================================================
# duplicate
# ============================================================================

def test_duplicate_not_found_returns_404(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.duplicate(ctx(), 5)
    assert r == {'success': False, 'error': 'Agent not found', 'status': 404, 'status_code': 404}


def test_duplicate_failure_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.access[5] = True
    repo.duplicate_result = None
    r = c.duplicate(ctx(), 5)
    assert r == {'success': False, 'error': 'Failed to duplicate agent', 'status': 500, 'status_code': 500}


def test_duplicate_success(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.access[5] = True
    repo.duplicate_result = agent(id=6, name='Alice (Copy)')
    r = c.duplicate(ctx(body={'name': 'Custom'}), 5)
    assert r == {'success': True, 'data': agent(id=6, name='Alice (Copy)').toArray(),
                 'message': 'Agent duplicated successfully'}
    assert repo.calls == [('canUserAccess', (3, 5)), ('duplicate', (5, 3, 'Custom'))]


def test_duplicate_exception_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.access[5] = True
    repo.duplicate_exception = RuntimeError('boom')
    r = c.duplicate(ctx(), 5)
    assert r == {'success': False, 'error': 'Failed to duplicate agent: boom', 'status': 500, 'status_code': 500}


# ============================================================================
# moveUp / moveDown
# ============================================================================

def test_move_up_access_denied_returns_404(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.moveUp(ctx(), 5)
    assert r == {'success': False, 'error': 'Agent not found or access denied', 'status': 404, 'status_code': 404}


def test_move_up_boundary_returns_400(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.move_up_result = False
    r = c.moveUp(ctx(), 5)
    assert r == {'success': False, 'error': 'Cannot move agent up (already at top or not in a team)',
                 'status': 400, 'status_code': 400}


def test_move_up_success(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.move_up_result = True
    repo.agents_by_id[5] = agent(team_id=1)
    repo.team_agents[1] = [agent(id=5, team_id=1), agent(id=6, team_id=1, name='Bob')]
    r = c.moveUp(ctx(), 5)
    assert r['success'] is True
    assert r['message'] == 'Agent moved up successfully'
    assert [a['id'] for a in r['agents']] == [5, 6]


def test_move_up_exception_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True

    def boom(agent_id):
        raise RuntimeError('locked')
    repo.moveAgentUp = boom
    r = c.moveUp(ctx(), 5)
    assert r == {'success': False, 'error': 'Failed to move agent: locked', 'status': 500, 'status_code': 500}


def test_move_down_boundary_returns_400(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.move_down_result = False
    r = c.moveDown(ctx(), 5)
    assert r == {'success': False, 'error': 'Cannot move agent down (already at bottom or not in a team)',
                 'status': 400, 'status_code': 400}


def test_move_down_success(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.move_down_result = True
    repo.agents_by_id[5] = agent(team_id=1)
    repo.team_agents[1] = [agent(id=6, team_id=1, name='Bob'), agent(id=5, team_id=1)]
    r = c.moveDown(ctx(), 5)
    assert r['message'] == 'Agent moved down successfully'
    assert [a['id'] for a in r['agents']] == [6, 5]


# ============================================================================
# reorder
# ============================================================================

def test_reorder_missing_team_id_returns_400(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.reorder(ctx(body={'agent_ids': [1, 2]}))
    assert r == {'success': False, 'error': 'team_id is required', 'status': 400, 'status_code': 400}


def test_reorder_missing_agent_ids_returns_400(monkeypatch):
    c, _ = controller(monkeypatch)
    r = c.reorder(ctx(body={'team_id': 1}))
    assert r == {'success': False, 'error': 'agent_ids array is required', 'status': 400, 'status_code': 400}
    r2 = c.reorder(ctx(body={'team_id': 1, 'agent_ids': 'not-a-list'}))
    assert r2['error'] == 'agent_ids array is required'
    r3 = c.reorder(ctx(body={'team_id': 1, 'agent_ids': []}))
    assert r3['error'] == 'agent_ids array is required'


def test_reorder_ownership_denied_returns_403(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.owner[6] = False
    r = c.reorder(ctx(body={'team_id': 1, 'agent_ids': [5, 6]}))
    assert r == {'success': False, 'error': 'Access denied for agent ID: 6', 'status': 403, 'status_code': 403}


def test_reorder_repository_failure_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.reorder_result = {'success': False, 'error': 'custom failure'}
    r = c.reorder(ctx(body={'team_id': 1, 'agent_ids': [5]}))
    assert r == {'success': False, 'error': 'custom failure', 'status': 500, 'status_code': 500}


def test_reorder_repository_failure_default_message(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.reorder_result = {'success': False}
    r = c.reorder(ctx(body={'team_id': 1, 'agent_ids': [5]}))
    assert r['error'] == 'Failed to reorder agents'


def test_reorder_success_no_notice(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.reorder_result = {'success': True, 'reordered': False}
    repo.team_agents_with_pipeline[1] = [
        {'agent': agent(id=5), 'pipeline_position': 1, 'pipeline_label': 'Step 1', 'can_reorder': True},
    ]
    r = c.reorder(ctx(body={'team_id': 1, 'agent_ids': [5]}))
    assert r['success'] is True
    assert r['message'] == 'Agents reordered successfully'
    assert r['agents'][0]['pipeline_position'] == 1
    assert r['agents'][0]['pipeline_label'] == 'Step 1'
    assert r['agents'][0]['can_reorder'] is True
    assert 'notice' not in r and 'enforced' not in r


def test_reorder_success_with_notice_when_enforced(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True
    repo.reorder_result = {'success': True, 'reordered': True, 'message': 'Order adjusted: Manager must remain at the top of the pipeline'}
    repo.team_agents_with_pipeline[1] = []
    r = c.reorder(ctx(body={'team_id': 1, 'agent_ids': [5]}))
    assert r['notice'] == 'Order adjusted: Manager must remain at the top of the pipeline'
    assert r['enforced'] is True


def test_reorder_exception_returns_500(monkeypatch):
    c, repo = controller(monkeypatch)
    repo.owner[5] = True

    def boom(agent_ids, team_id):
        raise RuntimeError('deadlock')
    repo.updateAgentOrder = boom
    r = c.reorder(ctx(body={'team_id': 1, 'agent_ids': [5]}))
    assert r == {'success': False, 'error': 'Failed to reorder agents: deadlock', 'status': 500, 'status_code': 500}


# ============================================================================
# run / chat — Phase 5 stubs, not routed
# ============================================================================

def test_run_raises_not_implemented(monkeypatch):
    c, _ = controller(monkeypatch)
    with pytest.raises(NotImplementedError, match='Phase 5'):
        c.run(ctx(), 5)


def test_chat_raises_not_implemented(monkeypatch):
    c, _ = controller(monkeypatch)
    with pytest.raises(NotImplementedError, match='Phase 5'):
        c.chat(ctx(), 5)


# ============================================================================
# error() helper
# ============================================================================

def test_error_helper_includes_both_status_and_status_code(monkeypatch):
    """PHP AgentController::error() (792-804) uniquely emits BOTH `status` and
    `status_code` -- index.php strips `status_code` for the HTTP code but the
    JSON body keeps `status`. Other AgentTeam controllers don't do this."""
    c, _ = controller(monkeypatch)
    assert c.error('boom', 418) == {'success': False, 'error': 'boom', 'status': 418, 'status_code': 418}
