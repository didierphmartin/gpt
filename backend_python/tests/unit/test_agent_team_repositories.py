"""Unit tests for the agent-team repositories (Phase 4, Task 2).

Port of backend/tests/Unit/AgentTeam/AgentRepositoryCategoryTest.php plus
per-method SQL/param coverage for AgentRepository, TeamRepository,
WorkflowRepository, WorkflowSchemaRepository and WorkflowGraphRepository.

A FakeDb records every statement issued so SQL can be asserted
whitespace-normalized against the PHP source, and params asserted exactly.
"""
from __future__ import annotations

import re
from unittest.mock import patch

import pymysql
import pytest

from app.agent_team.models.agent import Agent
from app.agent_team.models.team import Team
from app.agent_team.models.workflow import Workflow
from app.agent_team.models.workflow_schema import WorkflowSchema
from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.team_repository import TeamRepository
from app.agent_team.services.workflow_graph_repository import WorkflowGraphRepository
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.agent_team.services.workflow_schema_repository import WorkflowSchemaRepository


def norm(sql: str) -> str:
    return re.sub(r'\s+', ' ', sql).strip()


class FakeDb:
    """Records every statement so tests can assert SQL (whitespace-normalized)
    and params. Queued return values are consumed in call order per method."""

    def __init__(self, one=None, all_=None, column=None, insert_id=1, rowcount=1):
        self.one_queue = list(one) if one else []
        self.all_queue = list(all_) if all_ else []
        self.column_queue = list(column) if column else []
        self.insert_id = insert_id
        self.rowcount = rowcount
        self.calls = []
        self.began = 0
        self.committed = 0
        self.rolledback = 0

    def fetch_one(self, sql, params=None):
        self.calls.append(('fetch_one', sql, params))
        return self.one_queue.pop(0) if self.one_queue else None

    def fetch_all(self, sql, params=None):
        self.calls.append(('fetch_all', sql, params))
        return self.all_queue.pop(0) if self.all_queue else []

    def fetch_column(self, sql, params=None):
        self.calls.append(('fetch_column', sql, params))
        return self.column_queue.pop(0) if self.column_queue else []

    def execute(self, sql, params=None):
        self.calls.append(('execute', sql, params))
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append(('insert', sql, params))
        return self.insert_id

    def begin(self):
        self.began += 1

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1


AGENT_ROW = {
    'id': 5, 'user_id': 1, 'team_id': None, 'category': None, 'name': 'Alice',
    'description': '', 'agent_type': 'standard', 'parent_agent_id': None,
    'can_delegate_to': '[]', 'display_order': 0, 'provider': 'claude', 'model': None,
    'instructions': '', 'tools': '[]', 'visibility': 'personal', 'enabled': 1,
    'settings': '[]', 'created_at': None, 'updated_at': None,
}


def make_agent(**overrides) -> Agent:
    return Agent({**AGENT_ROW, **overrides})


# ---------------------------------------------------------------------------
# AgentRepository
# ---------------------------------------------------------------------------

def test_agent_find_by_id():
    db = FakeDb(one=[AGENT_ROW])
    repo = AgentRepository(db)
    agent = repo.findById(5)
    assert agent.getId() == 5
    assert db.calls[0] == ('fetch_one', "SELECT * FROM agents WHERE id = ?", [5])


def test_agent_find_by_id_not_found():
    db = FakeDb(one=[None])
    assert AgentRepository(db).findById(999) is None


def test_agent_find_by_name():
    db = FakeDb(one=[AGENT_ROW])
    repo = AgentRepository(db)
    agent = repo.findByName('Alice', 1)
    assert agent.getName() == 'Alice'
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT * FROM agents"
        " WHERE name = ?"
        " AND (user_id = ? OR visibility = 'public' OR visibility = 'workspace')"
        " AND enabled = 1"
        " LIMIT 1"
    )
    assert call[2] == ['Alice', 1]


def test_agent_find_accessible_by_user_base_sql():
    db = FakeDb(all_=[[AGENT_ROW]])
    repo = AgentRepository(db)
    results = repo.findAccessibleByUser(1)
    assert len(results) == 1
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT * FROM agents WHERE ("
        " user_id = :user_id"
        " OR visibility = 'public'"
        " OR visibility = 'workspace'"
        " ) AND enabled = 1 ORDER BY name ASC"
    )
    assert call[2] == {'user_id': 1}


def test_agent_find_accessible_by_user_all_filters():
    db = FakeDb(all_=[[]])
    repo = AgentRepository(db)
    repo.findAccessibleByUser(1, {
        'agent_type': 'worker', 'provider': 'claude', 'visibility': 'public',
        'search': 'bot', 'category': 'Research', 'limit': 10, 'offset': 5,
    })
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT * FROM agents WHERE ("
        " user_id = :user_id"
        " OR visibility = 'public'"
        " OR visibility = 'workspace'"
        " ) AND enabled = 1"
        " AND agent_type = :agent_type"
        " AND provider = :provider"
        " AND visibility = :visibility"
        " AND (name LIKE :search OR description LIKE :search_desc)"
        " AND category = :category"
        " ORDER BY name ASC LIMIT 10 OFFSET 5"
    )
    assert call[2] == {
        'user_id': 1, 'agent_type': 'worker', 'provider': 'claude', 'visibility': 'public',
        'search': '%bot%', 'search_desc': '%bot%', 'category': 'Research',
    }


def test_agent_find_accessible_by_user_category_none():
    db = FakeDb(all_=[[]])
    repo = AgentRepository(db)
    repo.findAccessibleByUser(1, {'category': '__none__'})
    call = db.calls[0]
    assert 'AND category IS NULL' in call[1]
    assert 'category' not in (call[2] or {})


def test_agent_find_worker_agents_no_delegate_restriction():
    manager_row = {**AGENT_ROW, 'id': 1, 'agent_type': 'manager', 'can_delegate_to': '[]'}
    db = FakeDb(one=[manager_row], all_=[[AGENT_ROW]])
    repo = AgentRepository(db)
    workers = repo.findWorkerAgents(1)
    assert len(workers) == 1
    call = db.calls[1]
    assert norm(call[1]) == norm(
        "SELECT * FROM agents"
        " WHERE agent_type IN ('worker', 'standard')"
        " AND enabled = 1"
        " ORDER BY display_order ASC, name ASC"
    )
    assert call[2] is None


def test_agent_find_worker_agents_with_delegate_list():
    manager_row = {**AGENT_ROW, 'id': 1, 'agent_type': 'manager', 'can_delegate_to': '[2,3]'}
    db = FakeDb(one=[manager_row], all_=[[AGENT_ROW]])
    repo = AgentRepository(db)
    repo.findWorkerAgents(1)
    call = db.calls[1]
    assert norm(call[1]) == norm(
        "SELECT * FROM agents"
        " WHERE id IN (?,?)"
        " AND enabled = 1"
        " ORDER BY display_order ASC, name ASC"
    )
    assert call[2] == [2, 3]


def test_agent_find_worker_agents_non_manager_returns_empty():
    db = FakeDb(one=[AGENT_ROW])  # standard, not manager
    assert AgentRepository(db).findWorkerAgents(5) == []


def test_agent_get_pipeline_for_manager():
    manager_row = {**AGENT_ROW, 'id': 1, 'agent_type': 'manager', 'can_delegate_to': '[]'}
    worker_row = {**AGENT_ROW, 'id': 2, 'name': 'Worker'}
    db = FakeDb(one=[manager_row], all_=[[worker_row]])
    pipeline = AgentRepository(db).getPipelineForManager(1)
    assert pipeline == [{
        'step': 0, 'agent_id': 2, 'agent_name': 'Worker', 'agent_type': 'standard', 'description': '',
    }]


def test_agent_find_by_user_id():
    db = FakeDb(all_=[[AGENT_ROW]])
    AgentRepository(db).findByUserId(1)
    assert db.calls[0] == ('fetch_all', "SELECT * FROM agents WHERE user_id = ? ORDER BY name ASC", [1])


def test_agent_find_by_team_id():
    db = FakeDb(all_=[[AGENT_ROW]])
    AgentRepository(db).findByTeamId(7)
    assert db.calls[0] == (
        'fetch_all',
        "SELECT * FROM agents WHERE team_id = ? AND enabled = 1 ORDER BY display_order ASC, name ASC",
        [7],
    )


def test_agent_find_by_team_id_with_pipeline_info():
    manager_row = {**AGENT_ROW, 'id': 1, 'agent_type': 'manager'}
    worker1 = {**AGENT_ROW, 'id': 2, 'name': 'W1'}
    worker2 = {**AGENT_ROW, 'id': 3, 'name': 'W2'}
    db = FakeDb(all_=[[manager_row, worker1, worker2]])
    result = AgentRepository(db).findByTeamIdWithPipelineInfo(7)
    assert result[0]['pipeline_label'] == 'Manager'
    assert result[0]['can_reorder'] is False
    assert result[1]['pipeline_label'] == 'Step 1 of 2'
    assert result[1]['is_pipeline_head'] is True
    assert result[2]['pipeline_label'] == 'Step 2 of 2'
    assert result[2]['is_pipeline_tail'] is True


def test_agent_find_owned_by_name():
    db = FakeDb(one=[AGENT_ROW])
    AgentRepository(db).findOwnedByName('Alice', 1)
    assert db.calls[0] == (
        'fetch_one',
        "SELECT * FROM agents WHERE user_id = ? AND name = ? ORDER BY id ASC LIMIT 1",
        [1, 'Alice'],
    )


def test_agent_create_inserts_when_no_existing():
    db = FakeDb(one=[None, AGENT_ROW], insert_id=5)
    repo = AgentRepository(db)
    result = repo.create(make_agent(id=None))
    assert result.getId() == 5
    insert_call = [c for c in db.calls if c[0] == 'insert'][0]
    assert norm(insert_call[1]) == norm(
        "INSERT INTO agents ("
        " user_id, team_id, category, name, description,"
        " agent_type, parent_agent_id, can_delegate_to, display_order,"
        " provider, model, instructions,"
        " tools, visibility, enabled, settings"
        " ) VALUES ("
        " :user_id, :team_id, :category, :name, :description,"
        " :agent_type, :parent_agent_id, :can_delegate_to, :display_order,"
        " :provider, :model, :instructions,"
        " :tools, :visibility, :enabled, :settings"
        " )"
    )
    assert insert_call[2]['name'] == 'Alice'
    assert insert_call[2]['can_delegate_to'] == '[]'
    assert insert_call[2]['enabled'] == 1


def test_agent_create_reuses_existing_row_by_user_id_and_name():
    """Uniqueness rule (PHP 312-360): create() finds an owned (user_id, name)
    match and updates that row instead of inserting a duplicate."""
    existing_row = {**AGENT_ROW, 'id': 42}
    updated_row = {**AGENT_ROW, 'id': 42, 'description': 'updated'}
    db = FakeDb(one=[existing_row, updated_row])
    repo = AgentRepository(db)
    new_agent = make_agent(id=None, description='updated')
    result = repo.create(new_agent)
    assert result.getId() == 42
    assert new_agent.getId() == 42
    kinds = [c[0] for c in db.calls]
    assert 'insert' not in kinds
    update_call = [c for c in db.calls if c[0] == 'execute'][0]
    assert update_call[2]['id'] == 42
    assert update_call[2]['description'] == 'updated'


def test_agent_update():
    db = FakeDb(one=[AGENT_ROW])
    repo = AgentRepository(db)
    agent = make_agent()
    repo.update(agent)
    update_call = [c for c in db.calls if c[0] == 'execute'][0]
    assert norm(update_call[1]) == norm(
        "UPDATE agents SET"
        " team_id = :team_id,"
        " category = :category,"
        " name = :name,"
        " description = :description,"
        " agent_type = :agent_type,"
        " parent_agent_id = :parent_agent_id,"
        " can_delegate_to = :can_delegate_to,"
        " display_order = :display_order,"
        " provider = :provider,"
        " model = :model,"
        " instructions = :instructions,"
        " tools = :tools,"
        " visibility = :visibility,"
        " enabled = :enabled,"
        " settings = :settings"
        " WHERE id = :id"
    )
    assert update_call[2]['id'] == 5


def test_agent_find_distinct_categories():
    db = FakeDb(column=[['Marketing', 'Research']])
    cats = AgentRepository(db).findDistinctCategories(1)
    assert cats == ['Marketing', 'Research']
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT DISTINCT category FROM agents"
        " WHERE user_id = ? AND category IS NOT NULL AND category <> ''"
        " ORDER BY category ASC"
    )
    assert call[2] == [1]


def test_agent_rename_category():
    db = FakeDb(rowcount=2)
    affected = AgentRepository(db).renameCategory(1, 'Old', 'New')
    assert affected == 2
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "UPDATE agents SET category = :new WHERE user_id = :user_id AND category = :old"
    )
    assert call[2] == {'new': 'New', 'user_id': 1, 'old': 'Old'}


def test_agent_rename_category_rejects_empty_names():
    db = FakeDb()
    repo = AgentRepository(db)
    assert repo.renameCategory(1, '', 'New') == 0
    assert repo.renameCategory(1, 'Old', '') == 0
    assert db.calls == []


def test_agent_clear_category():
    db = FakeDb(rowcount=2)
    affected = AgentRepository(db).clearCategory(1, 'Doomed')
    assert affected == 2
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "UPDATE agents SET category = NULL WHERE user_id = :user_id AND category = :name"
    )
    assert call[2] == {'user_id': 1, 'name': 'Doomed'}


def test_agent_clear_category_rejects_empty_name():
    db = FakeDb()
    assert AgentRepository(db).clearCategory(1, '') == 0
    assert db.calls == []


def test_agent_delete():
    db = FakeDb()
    assert AgentRepository(db).delete(5) is True
    assert db.calls[0] == ('execute', "DELETE FROM agents WHERE id = ?", [5])


def test_agent_can_user_access_owner():
    db = FakeDb(one=[AGENT_ROW])
    assert AgentRepository(db).canUserAccess(1, 5) is True


def test_agent_can_user_access_public():
    row = {**AGENT_ROW, 'user_id': 99, 'visibility': 'public'}
    db = FakeDb(one=[row])
    assert AgentRepository(db).canUserAccess(1, 5) is True


def test_agent_can_user_access_workspace():
    row = {**AGENT_ROW, 'user_id': 99, 'visibility': 'workspace'}
    db = FakeDb(one=[row])
    assert AgentRepository(db).canUserAccess(1, 5) is True


def test_agent_can_user_access_denied():
    row = {**AGENT_ROW, 'user_id': 99, 'visibility': 'personal'}
    db = FakeDb(one=[row])
    assert AgentRepository(db).canUserAccess(1, 5) is False


def test_agent_can_user_access_missing_agent():
    db = FakeDb(one=[None])
    assert AgentRepository(db).canUserAccess(1, 999) is False


def test_agent_is_owner():
    db = FakeDb(one=[AGENT_ROW])
    assert AgentRepository(db).isOwner(1, 5) is True


def test_agent_count_by_user():
    db = FakeDb(column=[[3]])
    assert AgentRepository(db).countByUser(1) == 3
    assert db.calls[0] == ('fetch_column', "SELECT COUNT(*) FROM agents WHERE user_id = ?", [1])


def test_agent_count_accessible():
    db = FakeDb(column=[[7]])
    assert AgentRepository(db).countAccessible(1) == 7
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT COUNT(*) FROM agents"
        " WHERE (user_id = ? OR visibility IN ('public', 'workspace'))"
        " AND enabled = 1"
    )
    assert call[2] == [1]


def test_agent_get_stats():
    db = FakeDb(one=[{
        'total_executions': 10, 'successful': 8, 'failed': 2,
        'total_tokens': 500, 'total_cost': 1.5, 'avg_response_time': 200.0,
    }])
    stats = AgentRepository(db).getAgentStats(5)
    assert stats == {
        'total_executions': 10, 'successful': 8, 'failed': 2,
        'total_tokens': 500, 'total_cost': 1.5, 'avg_response_time_ms': 200.0,
    }
    call = db.calls[0]
    assert 'FROM agent_executions' in call[1]
    assert 'WHERE agent_id = ?' in call[1]
    assert call[2] == [5]


def test_agent_get_stats_no_rows_defaults_zero():
    db = FakeDb(one=[None])
    stats = AgentRepository(db).getAgentStats(5)
    assert stats == {
        'total_executions': 0, 'successful': 0, 'failed': 0,
        'total_tokens': 0, 'total_cost': 0.0, 'avg_response_time_ms': 0.0,
    }


def test_agent_duplicate():
    db = FakeDb(one=[AGENT_ROW, None, {**AGENT_ROW, 'id': 6, 'user_id': 2, 'name': 'Alice (Copy)', 'visibility': 'personal'}], insert_id=6)
    copy = AgentRepository(db).duplicate(5, 2)
    assert copy.getName() == 'Alice (Copy)'
    assert copy.getUserId() == 2


def test_agent_duplicate_missing_source_returns_none():
    db = FakeDb(one=[None])
    assert AgentRepository(db).duplicate(999, 2) is None


def test_agent_update_agent_order_enforces_manager_first():
    manager_row = {**AGENT_ROW, 'id': 1, 'team_id': 7, 'agent_type': 'manager'}
    worker_row = {**AGENT_ROW, 'id': 2, 'team_id': 7, 'agent_type': 'standard'}
    db = FakeDb(one=[worker_row, manager_row])
    repo = AgentRepository(db)
    result = repo.updateAgentOrder([2, 1], 7)
    assert result['success'] is True
    assert result['reordered'] is True
    assert result['enforced_order'] == [1, 2]
    assert result['message'] == 'Order adjusted: Manager must remain at the top of the pipeline'
    assert db.began == 1 and db.committed == 1 and db.rolledback == 0
    update_calls = [c for c in db.calls if c[0] == 'execute']
    assert update_calls[0][1] == "UPDATE agents SET display_order = ? WHERE id = ? AND team_id = ?"
    assert update_calls[0][2] == [0, 1, 7]
    assert update_calls[1][2] == [1, 2, 7]


def test_agent_update_agent_order_no_reorder_needed():
    manager_row = {**AGENT_ROW, 'id': 1, 'team_id': 7, 'agent_type': 'manager'}
    worker_row = {**AGENT_ROW, 'id': 2, 'team_id': 7, 'agent_type': 'standard'}
    db = FakeDb(one=[manager_row, worker_row])
    result = AgentRepository(db).updateAgentOrder([1, 2], 7)
    assert result['reordered'] is False
    assert result['message'] is None


def test_agent_update_agent_order_rolls_back_on_db_error():
    db = FakeDb(one=[{**AGENT_ROW, 'id': 1, 'team_id': 7}])

    def boom(sql, params=None):
        db.calls.append(('execute', sql, params))
        raise pymysql.err.OperationalError(1213, 'Deadlock found')

    db.execute = boom
    result = AgentRepository(db).updateAgentOrder([1], 7)
    assert result == {'success': False, 'error': 'Failed to update agent order'}
    assert db.rolledback == 1


def test_agent_move_up():
    a1 = {**AGENT_ROW, 'id': 1, 'team_id': 7, 'display_order': 0}
    a2 = {**AGENT_ROW, 'id': 2, 'team_id': 7, 'display_order': 1}
    db = FakeDb(one=[a2], all_=[[a1, a2]])
    ok = AgentRepository(db).moveAgentUp(2)
    assert ok is True
    assert db.began == 1 and db.committed == 1
    update_calls = [c for c in db.calls if c[0] == 'execute']
    assert update_calls[0] == ('execute', "UPDATE agents SET display_order = ? WHERE id = ?", [0, 2])
    assert update_calls[1] == ('execute', "UPDATE agents SET display_order = ? WHERE id = ?", [1, 1])


def test_agent_move_up_already_at_top():
    a1 = {**AGENT_ROW, 'id': 1, 'team_id': 7, 'display_order': 0}
    db = FakeDb(one=[a1], all_=[[a1]])
    assert AgentRepository(db).moveAgentUp(1) is False


def test_agent_move_up_no_team_returns_false():
    db = FakeDb(one=[{**AGENT_ROW, 'team_id': None}])
    assert AgentRepository(db).moveAgentUp(5) is False


def test_agent_move_down():
    a1 = {**AGENT_ROW, 'id': 1, 'team_id': 7, 'display_order': 0}
    a2 = {**AGENT_ROW, 'id': 2, 'team_id': 7, 'display_order': 1}
    db = FakeDb(one=[a1], all_=[[a1, a2]])
    ok = AgentRepository(db).moveAgentDown(1)
    assert ok is True
    update_calls = [c for c in db.calls if c[0] == 'execute']
    assert update_calls[0] == ('execute', "UPDATE agents SET display_order = ? WHERE id = ?", [1, 1])
    assert update_calls[1] == ('execute', "UPDATE agents SET display_order = ? WHERE id = ?", [0, 2])


def test_agent_move_down_already_at_bottom():
    a1 = {**AGENT_ROW, 'id': 1, 'team_id': 7, 'display_order': 0}
    db = FakeDb(one=[a1], all_=[[a1]])
    assert AgentRepository(db).moveAgentDown(1) is False


def test_agent_move_rolls_back_on_error():
    a1 = {**AGENT_ROW, 'id': 1, 'team_id': 7, 'display_order': 0}
    a2 = {**AGENT_ROW, 'id': 2, 'team_id': 7, 'display_order': 1}
    db = FakeDb(one=[a2], all_=[[a1, a2]])

    def boom(sql, params=None):
        raise pymysql.err.OperationalError(1205, 'Lock wait timeout')

    db.execute = boom
    assert AgentRepository(db).moveAgentUp(2) is False
    assert db.rolledback == 1


# ---------------------------------------------------------------------------
# AgentRepositoryCategoryTest port (behavioral, via FakeDb chaining)
# ---------------------------------------------------------------------------

class InMemoryAgentsDb:
    """A tiny in-memory stand-in for the `agents` table, enough to run the
    ported AgentRepositoryCategoryTest cases end to end (create/findById/
    findAccessibleByUser/findDistinctCategories/renameCategory/clearCategory)."""

    def __init__(self):
        self.rows: dict[int, dict] = {}
        self.next_id = 1

    def insert(self, sql, params=None):
        row_id = self.next_id
        self.next_id += 1
        row = dict(params)
        row['id'] = row_id
        self.rows[row_id] = row
        return row_id

    def execute(self, sql, params=None):
        if sql.startswith('UPDATE agents SET category = :new'):
            affected = 0
            for row in self.rows.values():
                if row['user_id'] == params['user_id'] and row.get('category') == params['old']:
                    row['category'] = params['new']
                    affected += 1
            return affected
        if sql.startswith('UPDATE agents SET category = NULL'):
            affected = 0
            for row in self.rows.values():
                if row['user_id'] == params['user_id'] and row.get('category') == params['name']:
                    row['category'] = None
                    affected += 1
            return affected
        # update()
        row = self.rows[params['id']]
        row.update({k: v for k, v in params.items() if k != 'id'})
        return 1

    def fetch_one(self, sql, params=None):
        if 'WHERE id = ?' in sql:
            return self.rows.get(params[0])
        if 'user_id = ? AND name = ?' in sql:  # findOwnedByName
            user_id, name = params
            matches = sorted(
                (r for r in self.rows.values() if r['user_id'] == user_id and r['name'] == name),
                key=lambda r: r['id'],
            )
            return matches[0] if matches else None
        return None

    def fetch_all(self, sql, params=None):
        user_id = params.get('user_id') if isinstance(params, dict) else None
        rows = [r for r in self.rows.values() if r['user_id'] == user_id]
        category = (params or {}).get('category')
        if category is not None:
            rows = [r for r in rows if r.get('category') == category]
        elif 'AND category IS NULL' in sql:
            rows = [r for r in rows if r.get('category') is None]
        return rows

    def fetch_column(self, sql, params=None):
        user_id = params[0]
        cats = sorted({r['category'] for r in self.rows.values()
                       if r['user_id'] == user_id and r.get('category')})
        return cats


def _make_agent(user_id, name, category=None):
    return Agent({
        'user_id': user_id, 'name': name, 'category': category, 'description': '',
        'agent_type': 'standard', 'provider': 'claude', 'instructions': '', 'tools': [],
        'visibility': 'personal', 'enabled': True, 'settings': [],
    })


def test_category_create_persists_category():
    repo = AgentRepository(InMemoryAgentsDb())
    saved = repo.create(_make_agent(1, 'Alice', 'Research'))
    assert saved.getCategory() == 'Research'
    reloaded = repo.findById(saved.getId())
    assert reloaded.getCategory() == 'Research'


def test_category_create_without_category_stores_null():
    repo = AgentRepository(InMemoryAgentsDb())
    saved = repo.create(_make_agent(1, 'Loose'))
    assert saved.getCategory() is None


def test_category_update_changes_category():
    repo = AgentRepository(InMemoryAgentsDb())
    saved = repo.create(_make_agent(1, 'Bob', 'A'))
    saved.setCategory('B')
    updated = repo.update(saved)
    assert updated.getCategory() == 'B'
    saved.setCategory(None)
    cleared = repo.update(saved)
    assert cleared.getCategory() is None


def test_category_filter_returns_only_matching_agents():
    repo = AgentRepository(InMemoryAgentsDb())
    repo.create(_make_agent(1, 'A', 'X'))
    repo.create(_make_agent(1, 'B', 'X'))
    repo.create(_make_agent(1, 'C', 'Y'))
    repo.create(_make_agent(1, 'D'))
    results = repo.findAccessibleByUser(1, {'category': 'X'})
    names = sorted(a.getName() for a in results)
    assert names == ['A', 'B']


def test_category_filter_none_returns_uncategorized():
    repo = AgentRepository(InMemoryAgentsDb())
    repo.create(_make_agent(1, 'A', 'X'))
    repo.create(_make_agent(1, 'D'))
    repo.create(_make_agent(1, 'E'))
    results = repo.findAccessibleByUser(1, {'category': '__none__'})
    names = sorted(a.getName() for a in results)
    assert names == ['D', 'E']


def test_category_find_distinct_categories_per_user_excludes_null():
    repo = AgentRepository(InMemoryAgentsDb())
    repo.create(_make_agent(1, 'A', 'Research'))
    repo.create(_make_agent(1, 'B', 'Research'))
    repo.create(_make_agent(1, 'C', 'Marketing'))
    repo.create(_make_agent(1, 'D'))
    repo.create(_make_agent(2, 'Z', 'OtherUserCategory'))
    assert repo.findDistinctCategories(1) == ['Marketing', 'Research']


def test_category_rename_updates_all_matching_rows():
    repo = AgentRepository(InMemoryAgentsDb())
    repo.create(_make_agent(1, 'A', 'Old'))
    repo.create(_make_agent(1, 'B', 'Old'))
    repo.create(_make_agent(1, 'C', 'Different'))
    repo.create(_make_agent(2, 'X', 'Old'))  # other user, untouched
    affected = repo.renameCategory(1, 'Old', 'New')
    assert affected == 2
    assert repo.findDistinctCategories(1) == ['Different', 'New']
    assert repo.findDistinctCategories(2) == ['Old']


def test_category_clear_nulls_matching_rows_scoped_to_user():
    repo = AgentRepository(InMemoryAgentsDb())
    repo.create(_make_agent(1, 'A', 'Doomed'))
    repo.create(_make_agent(1, 'B', 'Doomed'))
    repo.create(_make_agent(1, 'C', 'Survivor'))
    repo.create(_make_agent(2, 'Z', 'Doomed'))
    affected = repo.clearCategory(1, 'Doomed')
    assert affected == 2
    assert repo.findDistinctCategories(1) == ['Survivor']
    assert repo.findDistinctCategories(2) == ['Doomed']


def test_category_rename_and_clear_reject_empty_names():
    repo = AgentRepository(InMemoryAgentsDb())
    repo.create(_make_agent(1, 'A', 'Foo'))
    assert repo.renameCategory(1, '', 'New') == 0
    assert repo.renameCategory(1, 'Foo', '') == 0
    assert repo.clearCategory(1, '') == 0


# ---------------------------------------------------------------------------
# TeamRepository
# ---------------------------------------------------------------------------

TEAM_ROW = {'id': 1, 'user_id': 1, 'workspace_id': None, 'name': 'Team A', 'description': '',
            'created_at': None, 'updated_at': None}


def test_team_find_by_id():
    db = FakeDb(one=[TEAM_ROW])
    team = TeamRepository(db).findById(1)
    assert team.getName() == 'Team A'
    assert db.calls[0] == ('fetch_one', "SELECT * FROM agent_teams WHERE id = ?", [1])


def test_team_find_by_id_with_agents():
    manager_row = {**AGENT_ROW, 'id': 1, 'team_id': 1, 'agent_type': 'manager'}
    db = FakeDb(one=[TEAM_ROW], all_=[[manager_row]])
    team = TeamRepository(db).findByIdWithAgents(1)
    assert len(team.getAgentsWithPipelineInfo()) == 1


def test_team_find_by_id_with_agents_missing_team():
    db = FakeDb(one=[None])
    assert TeamRepository(db).findByIdWithAgents(999) is None


def test_team_find_by_user():
    db = FakeDb(all_=[[TEAM_ROW]])
    TeamRepository(db).findByUser(1)
    assert db.calls[0] == ('fetch_all', "SELECT * FROM agent_teams WHERE user_id = ? ORDER BY name ASC", [1])


def test_team_find_by_user_with_agents():
    db = FakeDb(all_=[[TEAM_ROW], []])
    teams = TeamRepository(db).findByUserWithAgents(1)
    assert len(teams) == 1
    assert teams[0].getAgentsWithPipelineInfo() == []


def test_team_create():
    db = FakeDb(one=[TEAM_ROW], insert_id=1)
    team = Team({'user_id': 1, 'workspace_id': None, 'name': 'Team A', 'description': ''})
    result = TeamRepository(db).create(team)
    assert result.getId() == 1
    insert_call = [c for c in db.calls if c[0] == 'insert'][0]
    assert norm(insert_call[1]) == norm(
        "INSERT INTO agent_teams (user_id, workspace_id, name, description)"
        " VALUES (:user_id, :workspace_id, :name, :description)"
    )
    assert insert_call[2] == {'user_id': 1, 'workspace_id': None, 'name': 'Team A', 'description': ''}


def test_team_update():
    db = FakeDb(one=[TEAM_ROW])
    team = Team(TEAM_ROW)
    TeamRepository(db).update(team)
    update_call = [c for c in db.calls if c[0] == 'execute'][0]
    assert norm(update_call[1]) == norm(
        "UPDATE agent_teams SET name = :name, description = :description,"
        " workspace_id = :workspace_id WHERE id = :id"
    )
    assert update_call[2] == {'id': 1, 'name': 'Team A', 'description': '', 'workspace_id': None}


def test_team_delete_removes_agents_then_team():
    db = FakeDb()
    assert TeamRepository(db).delete(1) is True
    assert db.calls[0] == ('execute', "DELETE FROM agents WHERE team_id = ?", [1])
    assert db.calls[1] == ('execute', "DELETE FROM agent_teams WHERE id = ?", [1])


def test_team_can_user_access():
    db = FakeDb(one=[TEAM_ROW])
    assert TeamRepository(db).canUserAccess(1, 1) is True


def test_team_can_user_access_missing():
    db = FakeDb(one=[None])
    assert TeamRepository(db).canUserAccess(1, 999) is False


def test_team_is_owner():
    db = FakeDb(one=[TEAM_ROW])
    assert TeamRepository(db).isOwner(1, 1) is True


def test_team_count_by_user():
    db = FakeDb(column=[[2]])
    assert TeamRepository(db).countByUser(1) == 2
    assert db.calls[0] == ('fetch_column', "SELECT COUNT(*) FROM agent_teams WHERE user_id = ?", [1])


def test_team_count_agents():
    db = FakeDb(column=[[4]])
    assert TeamRepository(db).countAgents(1) == 4
    assert db.calls[0] == ('fetch_column', "SELECT COUNT(*) FROM agents WHERE team_id = ? AND enabled = 1", [1])


def test_team_repository_default_agent_repository_is_shared_db():
    db = FakeDb(one=[TEAM_ROW], all_=[[]])
    repo = TeamRepository(db)
    assert isinstance(repo.agentRepository, AgentRepository)
    assert repo.agentRepository.db is db


# ---------------------------------------------------------------------------
# WorkflowRepository
# ---------------------------------------------------------------------------

WORKFLOW_ROW = {
    'id': 1, 'user_id': 1, 'workspace_id': None, 'name': 'WF', 'description': '',
    'steps': '[]', 'triggers': '[]', 'variables': '[]', 'enabled': 1,
    'created_at': None, 'updated_at': None, 'output_storage_enabled': 0, 'output_folder': None,
}


def test_workflow_get_graph_repository():
    db = FakeDb()
    repo = WorkflowRepository(db)
    assert isinstance(repo.getGraphRepository(), WorkflowGraphRepository)
    assert repo.getGraphRepository() is repo.graphRepository


def test_workflow_find_by_id():
    db = FakeDb(one=[WORKFLOW_ROW])
    wf = WorkflowRepository(db).findById(1)
    assert wf.getName() == 'WF'
    assert db.calls[0] == ('fetch_one', "SELECT * FROM agent_workflows WHERE id = ?", [1])


def test_workflow_find_by_id_not_found():
    db = FakeDb(one=[None])
    assert WorkflowRepository(db).findById(999) is None


def test_workflow_find_by_id_include_graph():
    db = FakeDb(one=[WORKFLOW_ROW], all_=[[], []])
    wf = WorkflowRepository(db).findById(1, include_graph=True)
    assert wf.getGraph() == {'nodes': [], 'edges': []}


def test_workflow_find_by_user():
    db = FakeDb(all_=[[WORKFLOW_ROW]])
    WorkflowRepository(db).findByUser(1)
    assert db.calls[0] == ('fetch_all', "SELECT * FROM agent_workflows WHERE user_id = ? ORDER BY name ASC", [1])


def test_workflow_find_enabled_by_user():
    db = FakeDb(all_=[[WORKFLOW_ROW]])
    WorkflowRepository(db).findEnabledByUser(1)
    assert db.calls[0] == (
        'fetch_all', "SELECT * FROM agent_workflows WHERE user_id = ? AND enabled = 1 ORDER BY name ASC", [1],
    )


def test_workflow_find_by_trigger_type():
    db = FakeDb(all_=[[WORKFLOW_ROW]])
    WorkflowRepository(db).findByTriggerType(1, 'webhook')
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT * FROM agent_workflows"
        " WHERE user_id = ? AND enabled = 1"
        " AND JSON_CONTAINS(triggers, JSON_OBJECT('type', ?))"
        " ORDER BY name ASC"
    )
    assert call[2] == [1, 'webhook']


def test_workflow_create():
    db = FakeDb(one=[WORKFLOW_ROW], insert_id=1)
    wf = Workflow({'user_id': 1, 'name': 'WF', 'description': '', 'steps': [], 'triggers': [],
                    'variables': [], 'enabled': True, 'output_storage_enabled': False, 'output_folder': None})
    result = WorkflowRepository(db).create(wf)
    assert result.getId() == 1
    insert_call = [c for c in db.calls if c[0] == 'insert'][0]
    assert norm(insert_call[1]) == norm(
        "INSERT INTO agent_workflows (user_id, workspace_id, name, description, steps, triggers,"
        " variables, enabled, output_storage_enabled, output_folder, orchestration)"
        " VALUES (:user_id, :workspace_id, :name, :description, :steps, :triggers,"
        " :variables, :enabled, :output_storage_enabled, :output_folder, :orchestration)"
    )
    assert insert_call[2]['steps'] == '[]'
    assert insert_call[2]['enabled'] == 1
    assert insert_call[2]['output_storage_enabled'] == 0
    assert insert_call[2]['orchestration'] == 'workflow'


def test_workflow_update():
    db = FakeDb(one=[WORKFLOW_ROW])
    wf = Workflow(WORKFLOW_ROW)
    WorkflowRepository(db).update(wf)
    update_call = [c for c in db.calls if c[0] == 'execute'][0]
    assert norm(update_call[1]) == norm(
        "UPDATE agent_workflows SET name = :name, description = :description, steps = :steps,"
        " triggers = :triggers, variables = :variables, enabled = :enabled,"
        " workspace_id = :workspace_id, output_storage_enabled = :output_storage_enabled,"
        " output_folder = :output_folder, orchestration = :orchestration WHERE id = :id"
    )
    assert update_call[2]['id'] == 1
    assert update_call[2]['orchestration'] == 'workflow'


def test_workflow_delete():
    db = FakeDb()
    assert WorkflowRepository(db).delete(1) is True
    assert db.calls[0] == ('execute', "DELETE FROM agent_workflows WHERE id = ?", [1])


def test_workflow_can_user_access():
    db = FakeDb(one=[WORKFLOW_ROW])
    assert WorkflowRepository(db).canUserAccess(1, 1) is True


def test_workflow_is_owner():
    db = FakeDb(one=[WORKFLOW_ROW])
    assert WorkflowRepository(db).isOwner(1, 1) is True


def test_workflow_count_by_user():
    db = FakeDb(column=[[6]])
    assert WorkflowRepository(db).countByUser(1) == 6


def test_workflow_toggle_enabled():
    db = FakeDb()
    assert WorkflowRepository(db).toggleEnabled(1) is True
    assert db.calls[0] == ('execute', "UPDATE agent_workflows SET enabled = NOT enabled WHERE id = ?", [1])


def test_workflow_duplicate():
    copy_row = {**WORKFLOW_ROW, 'id': 2, 'user_id': 2, 'name': 'WF (Copy)'}
    db = FakeDb(one=[WORKFLOW_ROW, copy_row], insert_id=2)
    copy = WorkflowRepository(db).duplicate(1, 2)
    assert copy.getName() == 'WF (Copy)'
    assert copy.getUserId() == 2


def test_workflow_duplicate_missing_source():
    db = FakeDb(one=[None])
    assert WorkflowRepository(db).duplicate(999, 2) is None


# ---------------------------------------------------------------------------
# WorkflowSchemaRepository
# ---------------------------------------------------------------------------

SCHEMA_ROW = {
    'id': 1, 'user_id': 1, 'name': 'out', 'description': '',
    'schema_json': '{"type":"object","properties":{}}', 'strict': 1,
    'created_at': None, 'updated_at': None,
}


def test_schema_find_by_user():
    db = FakeDb(all_=[[SCHEMA_ROW]])
    WorkflowSchemaRepository(db).findByUser(1)
    assert db.calls[0] == ('fetch_all', "SELECT * FROM workflow_schemas WHERE user_id = ? ORDER BY name ASC", [1])


def test_schema_find_by_id():
    db = FakeDb(one=[SCHEMA_ROW])
    schema = WorkflowSchemaRepository(db).findById(1)
    assert schema.getName() == 'out'
    assert db.calls[0] == ('fetch_one', "SELECT * FROM workflow_schemas WHERE id = ?", [1])


def test_schema_find_by_name():
    db = FakeDb(one=[SCHEMA_ROW])
    WorkflowSchemaRepository(db).findByName(1, 'out')
    assert db.calls[0] == (
        'fetch_one', "SELECT * FROM workflow_schemas WHERE user_id = ? AND name = ? LIMIT 1", [1, 'out'],
    )


def test_schema_create():
    db = FakeDb(insert_id=9)
    schema = WorkflowSchema({'user_id': 1, 'name': 'out', 'description': '',
                              'schema_json': {'type': 'object', 'properties': {}}, 'strict': True})
    result = WorkflowSchemaRepository(db).create(schema)
    assert result.getId() == 9
    insert_call = db.calls[0]
    assert norm(insert_call[1]) == norm(
        "INSERT INTO workflow_schemas (user_id, name, description, schema_json, strict)"
        " VALUES (?, ?, ?, ?, ?)"
    )
    assert insert_call[2] == [1, 'out', '', '{"type":"object","properties":{}}', 1]


def test_schema_update():
    db = FakeDb()
    schema = WorkflowSchema(SCHEMA_ROW)
    WorkflowSchemaRepository(db).update(schema)
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "UPDATE workflow_schemas SET name = ?, description = ?, schema_json = ?, strict = ?"
        " WHERE id = ? AND user_id = ?"
    )
    assert call[2][-2:] == [1, 1]


def test_schema_update_without_id_raises():
    schema = WorkflowSchema({'user_id': 1, 'name': 'x', 'schema_json': {}, 'strict': True})
    with pytest.raises(ValueError):
        WorkflowSchemaRepository(FakeDb()).update(schema)


def test_schema_delete():
    db = FakeDb(rowcount=1)
    assert WorkflowSchemaRepository(db).delete(1, 1) is True
    assert db.calls[0] == (
        'execute', "DELETE FROM workflow_schemas WHERE id = ? AND user_id = ?", [1, 1],
    )


def test_schema_delete_no_match_returns_false():
    db = FakeDb(rowcount=0)
    assert WorkflowSchemaRepository(db).delete(1, 1) is False


# ---------------------------------------------------------------------------
# WorkflowGraphRepository
# ---------------------------------------------------------------------------

NODE_ROW = {'id': 1, 'workflow_id': 10, 'node_type': 'start', 'agent_id': None,
            'config': '{"type":"start"}', 'pos_x': 0, 'pos_y': 0, 'drawflow_node_id': '1'}
EDGE_ROW = {'id': 1, 'workflow_id': 10, 'from_node_id': 1, 'to_node_id': 2,
            'from_port': 'output_1', 'to_port': 'input_1', 'condition_expr': None}


def test_graph_find_realtime_workflow_ids():
    db = FakeDb(all_=[[{'workflow_id': 3}]])
    ids = WorkflowGraphRepository(db).findRealtimeWorkflowIds([1, 2, 3])
    assert ids == [3]
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT DISTINCT workflow_id FROM workflow_nodes"
        " WHERE workflow_id IN (?,?,?)"
        " AND node_type LIKE 'realtime-%'"
    )
    assert call[2] == [1, 2, 3]


def test_graph_find_realtime_workflow_ids_empty_input():
    db = FakeDb()
    assert WorkflowGraphRepository(db).findRealtimeWorkflowIds([]) == []
    assert db.calls == []


def test_graph_get_nodes_decodes_config():
    db = FakeDb(all_=[[NODE_ROW]])
    nodes = WorkflowGraphRepository(db).getNodes(10)
    assert nodes[0]['config'] == {'type': 'start'}
    assert db.calls[0] == ('fetch_all', "SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY id", [10])


def test_graph_get_nodes_empty_config_becomes_list():
    row = {**NODE_ROW, 'config': ''}
    db = FakeDb(all_=[[row]])
    nodes = WorkflowGraphRepository(db).getNodes(10)
    assert nodes[0]['config'] == []


def test_graph_get_edges():
    db = FakeDb(all_=[[EDGE_ROW]])
    edges = WorkflowGraphRepository(db).getEdges(10)
    assert edges == [EDGE_ROW]
    assert db.calls[0] == ('fetch_all', "SELECT * FROM workflow_edges WHERE workflow_id = ? ORDER BY id", [10])


def test_graph_get_graph():
    db = FakeDb(all_=[[NODE_ROW], [EDGE_ROW]])
    graph = WorkflowGraphRepository(db).getGraph(10)
    assert graph['nodes'][0]['id'] == 1
    assert graph['edges'][0]['id'] == 1


def test_graph_create_node():
    db = FakeDb(insert_id=55)
    repo = WorkflowGraphRepository(db)
    node_id = repo.createNode(10, {'id': 'n1', 'type': 'agent', 'agent_id': '3', 'position': {'x': 5, 'y': 6}})
    assert node_id == 55
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "INSERT INTO workflow_nodes"
        " (workflow_id, node_type, agent_id, config, pos_x, pos_y, drawflow_node_id)"
        " VALUES (:workflow_id, :node_type, :agent_id, :config, :pos_x, :pos_y, :drawflow_node_id)"
    )
    assert call[2] == {
        'workflow_id': 10, 'node_type': 'agent', 'agent_id': 3,
        'config': '{"type":"agent"}', 'pos_x': 5, 'pos_y': 6, 'drawflow_node_id': 'n1',
    }


def test_graph_create_node_rejects_condition_and_switch_types():
    repo = WorkflowGraphRepository(FakeDb())
    with pytest.raises(ValueError):
        repo.createNode(10, {'type': 'condition'})
    with pytest.raises(ValueError):
        repo.createNode(10, {'type': 'switch'})


def test_graph_create_node_invalid_agent_id_becomes_none():
    db = FakeDb(insert_id=1)
    WorkflowGraphRepository(db).createNode(10, {'id': '1', 'type': 'agent', 'agent_id': 'node_3'})
    assert db.calls[0][2]['agent_id'] is None


def test_graph_create_node_defaults_type_to_agent():
    db = FakeDb(insert_id=1)
    WorkflowGraphRepository(db).createNode(10, {'id': '1'})
    assert db.calls[0][2]['node_type'] == 'agent'
    assert db.calls[0][2]['config'] == '{"type":"agent"}'


def test_graph_update_node():
    db = FakeDb()
    ok = WorkflowGraphRepository(db).updateNode(1, {'type': 'output', 'pos_x': 1, 'pos_y': 2})
    assert ok is True
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "UPDATE workflow_nodes SET node_type = :node_type, agent_id = :agent_id,"
        " config = :config, pos_x = :pos_x, pos_y = :pos_y WHERE id = :id"
    )
    assert call[2]['id'] == 1
    assert call[2]['node_type'] == 'output'


def test_graph_delete_node():
    db = FakeDb()
    assert WorkflowGraphRepository(db).deleteNode(1) is True
    assert db.calls[0] == ('execute', "DELETE FROM workflow_nodes WHERE id = ?", [1])


def test_graph_create_edge():
    db = FakeDb(insert_id=7)
    edge_id = WorkflowGraphRepository(db).createEdge(10, {'from_node_id': 1, 'to_node_id': 2})
    assert edge_id == 7
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "INSERT INTO workflow_edges"
        " (workflow_id, from_node_id, to_node_id, from_port, to_port, condition_expr)"
        " VALUES (:workflow_id, :from_node_id, :to_node_id, :from_port, :to_port, :condition_expr)"
    )
    assert call[2] == {
        'workflow_id': 10, 'from_node_id': 1, 'to_node_id': 2,
        'from_port': 'output_1', 'to_port': 'input_1', 'condition_expr': None,
    }


def test_graph_delete_edge():
    db = FakeDb()
    assert WorkflowGraphRepository(db).deleteEdge(1) is True
    assert db.calls[0] == ('execute', "DELETE FROM workflow_edges WHERE id = ?", [1])


def test_graph_clear_graph():
    db = FakeDb()
    assert WorkflowGraphRepository(db).clearGraph(10) is True
    assert db.calls[0] == ('execute', "DELETE FROM workflow_edges WHERE workflow_id = ?", [10])
    assert db.calls[1] == ('execute', "DELETE FROM workflow_nodes WHERE workflow_id = ?", [10])


def test_graph_find_start_node():
    db = FakeDb(one=[NODE_ROW])
    node = WorkflowGraphRepository(db).findStartNode(10)
    assert node['config'] == {'type': 'start'}
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'start' LIMIT 1"
    )


def test_graph_find_output_nodes():
    db = FakeDb(all_=[[{**NODE_ROW, 'node_type': 'output', 'config': '{"type":"output"}'}]])
    nodes = WorkflowGraphRepository(db).findOutputNodes(10)
    assert nodes[0]['config'] == {'type': 'output'}
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'output'"
    )


def test_graph_get_outgoing_incoming_edges():
    db = FakeDb(all_=[[EDGE_ROW], [EDGE_ROW]])
    repo = WorkflowGraphRepository(db)
    repo.getOutgoingEdges(1)
    repo.getIncomingEdges(2)
    assert db.calls[0] == ('fetch_all', "SELECT * FROM workflow_edges WHERE from_node_id = ?", [1])
    assert db.calls[1] == ('fetch_all', "SELECT * FROM workflow_edges WHERE to_node_id = ?", [2])


def test_graph_get_node():
    db = FakeDb(one=[NODE_ROW])
    node = WorkflowGraphRepository(db).getNode(1)
    assert node['config'] == {'type': 'start'}
    assert db.calls[0] == ('fetch_one', "SELECT * FROM workflow_nodes WHERE id = ?", [1])


def test_graph_get_node_missing():
    db = FakeDb(one=[None])
    assert WorkflowGraphRepository(db).getNode(999) is None


def test_graph_get_next_nodes():
    row = {**NODE_ROW, 'condition_expr': None, 'from_port': 'output_1', 'to_port': 'input_1'}
    db = FakeDb(all_=[[row]])
    nodes = WorkflowGraphRepository(db).getNextNodes(1)
    assert nodes[0]['config'] == {'type': 'start'}
    call = db.calls[0]
    assert norm(call[1]) == norm(
        "SELECT n.*, e.condition_expr, e.from_port, e.to_port"
        " FROM workflow_nodes n"
        " INNER JOIN workflow_edges e ON n.id = e.to_node_id"
        " WHERE e.from_node_id = ?"
        " ORDER BY n.id"
    )
    assert call[2] == [1]


def test_graph_get_graph_for_frontend_shape():
    db = FakeDb(all_=[[NODE_ROW], [EDGE_ROW]])
    graph = WorkflowGraphRepository(db).getGraphForFrontend(10)
    assert graph == {
        'nodes': [{
            'id': '1', 'type': 'start', 'agent_id': None, 'config': {'type': 'start'},
            'position': {'x': 0, 'y': 0},
        }],
        'edges': [{
            'id': '1', 'from': '1', 'to': '2', 'from_port': 'output_1', 'to_port': 'input_1',
            'condition': None,
        }],
    }


def test_graph_validate_graph_missing_start_and_output():
    db = FakeDb(all_=[[], []])
    errors = WorkflowGraphRepository(db).validateGraph(10)
    assert 'Workflow must have a Start node' in errors
    assert 'Workflow must have at least one Output node' in errors


def test_graph_validate_graph_multiple_start_nodes():
    nodes = [{**NODE_ROW, 'id': 1, 'node_type': 'start'}, {**NODE_ROW, 'id': 2, 'node_type': 'start'}]
    db = FakeDb(all_=[nodes, []])
    errors = WorkflowGraphRepository(db).validateGraph(10)
    assert 'Workflow can only have one Start node' in errors


def test_graph_validate_graph_disconnected_start_and_output():
    nodes = [
        {**NODE_ROW, 'id': 1, 'node_type': 'start'},
        {**NODE_ROW, 'id': 2, 'node_type': 'output'},
    ]
    db = FakeDb(all_=[nodes, []])
    errors = WorkflowGraphRepository(db).validateGraph(10)
    assert 'Start node must be connected to at least one other node' in errors
    assert 'Output node must have at least one incoming connection' in errors


def test_graph_validate_graph_disconnected_middle_node():
    nodes = [
        {**NODE_ROW, 'id': 1, 'node_type': 'start'},
        {**NODE_ROW, 'id': 2, 'node_type': 'agent'},
        {**NODE_ROW, 'id': 3, 'node_type': 'output'},
    ]
    edges = [{**EDGE_ROW, 'id': 1, 'from_node_id': 1, 'to_node_id': 3}]
    db = FakeDb(all_=[nodes, edges])
    errors = WorkflowGraphRepository(db).validateGraph(10)
    assert "Node 'agent' (ID: 2) is not connected" in errors


def test_graph_validate_graph_valid_graph_has_no_errors():
    nodes = [
        {**NODE_ROW, 'id': 1, 'node_type': 'start'},
        {**NODE_ROW, 'id': 2, 'node_type': 'output'},
    ]
    edges = [{**EDGE_ROW, 'id': 1, 'from_node_id': 1, 'to_node_id': 2}]
    db = FakeDb(all_=[nodes, edges])
    errors = WorkflowGraphRepository(db).validateGraph(10)
    assert errors == []


# --- saveGraph retry ---------------------------------------------------

def test_save_graph_retries_transient_lock_errors_then_succeeds():
    repo = WorkflowGraphRepository(FakeDb())
    calls = {'n': 0}

    def flaky(workflow_id, nodes, edges):
        calls['n'] += 1
        if calls['n'] <= 2:
            raise pymysql.err.OperationalError(1213, 'Deadlock found when trying to get lock')
        return {'1': 10}

    with patch.object(repo, 'saveGraphOnce', side_effect=flaky), patch('time.sleep') as sleep_mock:
        result = repo.saveGraph(10, [], [])

    assert result == {'1': 10}
    assert calls['n'] == 3
    assert sleep_mock.call_count == 2


def test_save_graph_retries_lock_wait_timeout_1205():
    repo = WorkflowGraphRepository(FakeDb())
    calls = {'n': 0}

    def flaky(workflow_id, nodes, edges):
        calls['n'] += 1
        if calls['n'] == 1:
            raise pymysql.err.OperationalError(1205, 'Lock wait timeout exceeded')
        return {}

    with patch.object(repo, 'saveGraphOnce', side_effect=flaky), patch('time.sleep'):
        result = repo.saveGraph(10, [], [])

    assert result == {}
    assert calls['n'] == 2


def test_save_graph_gives_up_after_max_attempts_raising_same_exception():
    repo = WorkflowGraphRepository(FakeDb())
    err = pymysql.err.OperationalError(1213, 'Deadlock found when trying to get lock')

    with patch.object(repo, 'saveGraphOnce', side_effect=err) as mocked, patch('time.sleep') as sleep_mock:
        with pytest.raises(pymysql.err.OperationalError) as excinfo:
            repo.saveGraph(10, [], [])

    assert excinfo.value is err
    assert mocked.call_count == 5
    assert sleep_mock.call_count == 4


def test_save_graph_does_not_retry_non_transient_errors():
    repo = WorkflowGraphRepository(FakeDb())
    err = pymysql.err.OperationalError(1146, "Table 'workflow_nodes' doesn't exist")

    with patch.object(repo, 'saveGraphOnce', side_effect=err) as mocked, patch('time.sleep') as sleep_mock:
        with pytest.raises(pymysql.err.OperationalError):
            repo.saveGraph(10, [], [])

    assert mocked.call_count == 1
    assert sleep_mock.call_count == 0


def test_save_graph_once_commits_and_maps_temp_ids():
    db = FakeDb(insert_id=100)
    repo = WorkflowGraphRepository(db)
    ids = iter([101, 102, 103])
    db.insert = lambda sql, params=None: next(ids)

    result = repo.saveGraphOnce(10, [
        {'id': '1', 'type': 'start'},
        {'id': '2', 'type': 'output'},
    ], [
        {'from': '1', 'to': '2'},
    ])

    assert result == {'1': 101, '2': 102}
    assert db.began == 1 and db.committed == 1 and db.rolledback == 0


def test_save_graph_once_rolls_back_on_error():
    db = FakeDb()

    def boom(workflow_id):
        raise RuntimeError('clear failed')

    repo = WorkflowGraphRepository(db)
    repo.clearGraph = boom

    with pytest.raises(RuntimeError):
        repo.saveGraphOnce(10, [], [])

    assert db.began == 1 and db.rolledback == 1 and db.committed == 0


def test_save_graph_once_skips_edge_with_unmapped_node():
    db = FakeDb()
    insert_calls = []

    def counting_insert(sql, params=None):
        insert_calls.append(sql)
        return 1

    db.insert = counting_insert
    repo = WorkflowGraphRepository(db)

    result = repo.saveGraphOnce(10, [{'id': '1', 'type': 'start'}], [{'from': '1', 'to': '999'}])

    assert result == {'1': 1}
    # Only the node INSERT ran — the edge was skipped since 'to' (999) never mapped.
    assert len(insert_calls) == 1
    assert insert_calls[0].startswith('INSERT INTO workflow_nodes')
