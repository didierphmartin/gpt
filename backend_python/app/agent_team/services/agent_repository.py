"""Port of backend/src/AgentTeam/Services/AgentRepository.php (760 lines).

Handles CRUD operations and access control for agents.
"""
from __future__ import annotations

import pymysql

from app.agent_team.models.agent import Agent
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval
from app.support.phpjson import php_json_encode


class AgentRepository:
    def __init__(self, db):
        self.db = db

    def findById(self, id: int) -> Agent | None:
        """PHP 30-37."""
        row = self.db.fetch_one("SELECT * FROM agents WHERE id = ?", [id])
        return Agent(row) if row else None

    def findByName(self, name: str, user_id: int) -> Agent | None:
        """PHP 42-55."""
        row = self.db.fetch_one(
            "SELECT * FROM agents\n"
            "             WHERE name = ?\n"
            "             AND (user_id = ? OR visibility = 'public' OR visibility = 'workspace')\n"
            "             AND enabled = 1\n"
            "             LIMIT 1",
            [name, user_id],
        )
        return Agent(row) if row else None

    def findAccessibleByUser(self, user_id: int, filters: dict | None = None) -> list[Agent]:
        """PHP 60-123."""
        filters = filters if filters is not None else {}

        sql = (
            "SELECT * FROM agents WHERE (\n"
            "            user_id = :user_id\n"
            "            OR visibility = 'public'\n"
            "            OR visibility = 'workspace'\n"
            "        ) AND enabled = 1"
        )
        params: dict = {'user_id': user_id}

        # Filter by agent type
        if not php_empty(filters.get('agent_type')):
            sql += " AND agent_type = :agent_type"
            params['agent_type'] = filters['agent_type']

        # Filter by provider
        if not php_empty(filters.get('provider')):
            sql += " AND provider = :provider"
            params['provider'] = filters['provider']

        # Filter by visibility
        if not php_empty(filters.get('visibility')):
            sql += " AND visibility = :visibility"
            params['visibility'] = filters['visibility']

        # Search by name
        if not php_empty(filters.get('search')):
            sql += " AND (name LIKE :search OR description LIKE :search_desc)"
            params['search'] = '%' + filters['search'] + '%'
            params['search_desc'] = '%' + filters['search'] + '%'

        # Filter by category. Special value '__none__' selects uncategorized
        # (NULL) agents. Any other string is an exact match.
        if 'category' in filters and filters['category'] is not None:
            if filters['category'] == '__none__' or filters['category'] == '':
                sql += " AND category IS NULL"
            else:
                sql += " AND category = :category"
                params['category'] = filters['category']

        sql += " ORDER BY name ASC"

        # Pagination
        if not php_empty(filters.get('limit')):
            sql += " LIMIT " + str(php_intval(filters['limit']))
            if not php_empty(filters.get('offset')):
                sql += " OFFSET " + str(php_intval(filters['offset']))

        rows = self.db.fetch_all(sql, params)
        return [Agent(row) for row in rows]

    def findWorkerAgents(self, manager_id: int) -> list[Agent]:
        """PHP 128-162."""
        manager = self.findById(manager_id)
        if not manager or not manager.isManager():
            return []

        can_delegate_to = manager.getCanDelegateTo()

        if php_empty(can_delegate_to):
            # Can delegate to all enabled workers
            rows = self.db.fetch_all(
                "SELECT * FROM agents\n"
                "                 WHERE agent_type IN ('worker', 'standard')\n"
                "                 AND enabled = 1\n"
                "                 ORDER BY display_order ASC, name ASC"
            )
        else:
            # Can only delegate to specified agents, preserve display_order
            placeholders = ','.join(['?'] * len(can_delegate_to))
            sql = (
                "SELECT * FROM agents\n"
                "                 WHERE id IN ({placeholders})\n"
                "                 AND enabled = 1\n"
                "                 ORDER BY display_order ASC, name ASC"
            ).format(placeholders=placeholders)
            rows = self.db.fetch_all(sql, can_delegate_to)

        return [Agent(row) for row in rows]

    def getPipelineForManager(self, manager_id: int) -> list[dict]:
        """PHP 173-189."""
        workers = self.findWorkerAgents(manager_id)

        pipeline = []
        for index, agent in enumerate(workers):
            pipeline.append({
                'step': index,
                'agent_id': agent.getId(),
                'agent_name': agent.getName(),
                'agent_type': agent.getAgentType(),
                'description': agent.getDescription(),
            })

        return pipeline

    def findByUserId(self, user_id: int) -> list[Agent]:
        """PHP 194-205."""
        rows = self.db.fetch_all(
            "SELECT * FROM agents WHERE user_id = ? ORDER BY name ASC", [user_id]
        )
        return [Agent(row) for row in rows]

    def findByTeamId(self, team_id: int) -> list[Agent]:
        """PHP 210-221."""
        rows = self.db.fetch_all(
            "SELECT * FROM agents WHERE team_id = ? AND enabled = 1 ORDER BY display_order ASC, name ASC",
            [team_id],
        )
        return [Agent(row) for row in rows]

    def findByTeamIdWithPipelineInfo(self, team_id: int) -> list[dict]:
        """PHP 234-284."""
        agents = self.findByTeamId(team_id)

        if not agents:
            return []

        # Separate managers and workers
        managers = []
        workers = []

        for agent in agents:
            if agent.isManager():
                managers.append(agent)
            else:
                workers.append(agent)

        # Build result with pipeline info
        result = []
        worker_count = len(workers)

        # Add managers first (no pipeline position)
        for agent in managers:
            result.append({
                'agent': agent,
                'pipeline_position': None,
                'pipeline_label': 'Manager',
                'is_pipeline_head': False,
                'is_pipeline_tail': False,
                'can_reorder': False,  # Managers stay at top
            })

        # Add workers with pipeline position
        for index, agent in enumerate(workers):
            position = index + 1
            label = f"Step {position}"
            if worker_count > 1:
                label += f" of {worker_count}"
            result.append({
                'agent': agent,
                'pipeline_position': position,
                'pipeline_label': label,
                'is_pipeline_head': index == 0,
                'is_pipeline_tail': index == worker_count - 1,
                'can_reorder': True,
            })

        return result

    def findOwnedByName(self, name: str, user_id: int) -> Agent | None:
        """PHP 292-301. Strict (user_id, name) match used by create() for dedup."""
        row = self.db.fetch_one(
            "SELECT * FROM agents WHERE user_id = ? AND name = ? ORDER BY id ASC LIMIT 1",
            [user_id, name],
        )
        return Agent(row) if row else None

    def create(self, agent: Agent) -> Agent:
        """PHP 312-356. Agents are unique per (user_id, name): reuse the existing
        row (update in place) instead of inserting a duplicate."""
        existing = self.findOwnedByName(agent.getName(), agent.getUserId())
        if existing is not None:
            agent.setId(existing.getId())
            return self.update(agent)

        sql = (
            "INSERT INTO agents (\n"
            "            user_id, team_id, category, name, description,\n"
            "            agent_type, parent_agent_id, can_delegate_to, display_order,\n"
            "            provider, model, instructions,\n"
            "            tools, visibility, enabled, settings\n"
            "        ) VALUES (\n"
            "            :user_id, :team_id, :category, :name, :description,\n"
            "            :agent_type, :parent_agent_id, :can_delegate_to, :display_order,\n"
            "            :provider, :model, :instructions,\n"
            "            :tools, :visibility, :enabled, :settings\n"
            "        )"
        )

        data = agent.toArray()

        new_id = self.db.insert(sql, {
            'user_id': data['user_id'],
            'team_id': data['team_id'],
            'category': data['category'],
            'name': data['name'],
            'description': data['description'],
            'agent_type': data['agent_type'],
            'parent_agent_id': data['parent_agent_id'],
            'can_delegate_to': php_json_encode(data['can_delegate_to']),
            'display_order': data['display_order'],
            'provider': data['provider'],
            'model': data['model'],
            'instructions': data['instructions'],
            'tools': php_json_encode(data['tools']),
            'visibility': data['visibility'],
            'enabled': 1 if data['enabled'] else 0,
            'settings': php_json_encode(data['settings']),
        })

        return self.findById(new_id)

    def update(self, agent: Agent) -> Agent:
        """PHP 361-404."""
        sql = (
            "UPDATE agents SET\n"
            "            team_id = :team_id,\n"
            "            category = :category,\n"
            "            name = :name,\n"
            "            description = :description,\n"
            "            agent_type = :agent_type,\n"
            "            parent_agent_id = :parent_agent_id,\n"
            "            can_delegate_to = :can_delegate_to,\n"
            "            display_order = :display_order,\n"
            "            provider = :provider,\n"
            "            model = :model,\n"
            "            instructions = :instructions,\n"
            "            tools = :tools,\n"
            "            visibility = :visibility,\n"
            "            enabled = :enabled,\n"
            "            settings = :settings\n"
            "            WHERE id = :id"
        )

        data = agent.toArray()

        self.db.execute(sql, {
            'id': data['id'],
            'team_id': data['team_id'],
            'category': data['category'],
            'name': data['name'],
            'description': data['description'],
            'agent_type': data['agent_type'],
            'parent_agent_id': data['parent_agent_id'],
            'can_delegate_to': php_json_encode(data['can_delegate_to']),
            'display_order': data['display_order'],
            'provider': data['provider'],
            'model': data['model'],
            'instructions': data['instructions'],
            'tools': php_json_encode(data['tools']),
            'visibility': data['visibility'],
            'enabled': 1 if data['enabled'] else 0,
            'settings': php_json_encode(data['settings']),
        })

        return self.findById(agent.getId())

    def findDistinctCategories(self, user_id: int) -> list[str]:
        """PHP 412-421."""
        return self.db.fetch_column(
            "SELECT DISTINCT category FROM agents\n"
            "             WHERE user_id = ? AND category IS NOT NULL AND category <> ''\n"
            "             ORDER BY category ASC",
            [user_id],
        )

    def renameCategory(self, user_id: int, old_name: str, new_name: str) -> int:
        """PHP 427-442. Bulk-rename a category across all of a user's agents."""
        if old_name == '' or new_name == '':
            return 0
        return self.db.execute(
            "UPDATE agents SET category = :new\n"
            "             WHERE user_id = :user_id AND category = :old",
            {'new': new_name, 'user_id': user_id, 'old': old_name},
        )

    def clearCategory(self, user_id: int, name: str) -> int:
        """PHP 448-462."""
        if name == '':
            return 0
        return self.db.execute(
            "UPDATE agents SET category = NULL\n"
            "             WHERE user_id = :user_id AND category = :name",
            {'user_id': user_id, 'name': name},
        )

    def delete(self, id: int) -> bool:
        """PHP 467-471. `$stmt->execute([$id])` is the boolean success of the
        exec, not a rowCount check — always true unless an exception propagates."""
        self.db.execute("DELETE FROM agents WHERE id = ?", [id])
        return True

    def canUserAccess(self, user_id: int, agent_id: int) -> bool:
        """PHP 476-499."""
        agent = self.findById(agent_id)
        if not agent:
            return False

        # Owner always has access
        if agent.getUserId() == user_id:
            return True

        # Public agents are accessible to all
        if agent.getVisibility() == 'public':
            return True

        # Workspace visibility - simplified (no workspace membership check)
        if agent.getVisibility() == 'workspace':
            return True  # TODO: Add proper workspace membership check

        return False

    def isOwner(self, user_id: int, agent_id: int) -> bool:
        """PHP 504-508."""
        agent = self.findById(agent_id)
        return bool(agent) and agent.getUserId() == user_id

    def countByUser(self, user_id: int) -> int:
        """PHP 513-520."""
        col = self.db.fetch_column("SELECT COUNT(*) FROM agents WHERE user_id = ?", [user_id])
        return php_intval(col[0]) if col else 0

    def countAccessible(self, user_id: int) -> int:
        """PHP 525-534."""
        col = self.db.fetch_column(
            "SELECT COUNT(*) FROM agents\n"
            "             WHERE (user_id = ? OR visibility IN ('public', 'workspace'))\n"
            "             AND enabled = 1",
            [user_id],
        )
        return php_intval(col[0]) if col else 0

    def getAgentStats(self, agent_id: int) -> dict:
        """PHP 539-563."""
        stats = self.db.fetch_one(
            "SELECT\n"
            "                COUNT(*) as total_executions,\n"
            "                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,\n"
            "                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,\n"
            "                SUM(tokens_used) as total_tokens,\n"
            "                SUM(cost_usd) as total_cost,\n"
            "                AVG(response_time_ms) as avg_response_time\n"
            "             FROM agent_executions\n"
            "             WHERE agent_id = ?",
            [agent_id],
        )
        stats = stats if stats else {}

        return {
            'total_executions': php_intval(stats.get('total_executions') or 0),
            'successful': php_intval(stats.get('successful') or 0),
            'failed': php_intval(stats.get('failed') or 0),
            'total_tokens': php_intval(stats.get('total_tokens') or 0),
            'total_cost': float(stats.get('total_cost') or 0),
            'avg_response_time_ms': float(stats.get('avg_response_time') or 0),
        }

    def duplicate(self, agent_id: int, new_user_id: int, new_name: str | None = None) -> Agent | None:
        """PHP 568-581."""
        original = self.findById(agent_id)
        if not original:
            return None

        copy = Agent(original.toArray())
        copy.setUserId(new_user_id)
        copy.setName(new_name if new_name is not None else original.getName() + ' (Copy)')
        copy.setVisibility('personal')

        return self.create(copy)

    def updateAgentOrder(self, ordered_ids: list, team_id: int) -> dict:
        """PHP 593-661. Manager agents are ALWAYS enforced at position 0."""
        error_log(
            f"[REORDER] updateAgentOrder called: teamId={team_id}, agentIds="
            + php_json_encode(ordered_ids)
        )

        try:
            # Load all agents to check types
            agents: dict = {}
            manager_ids: list = []
            worker_ids: list = []

            for agent_id in ordered_ids:
                agent = self.findById(php_intval(agent_id))
                if agent:
                    agent_team_id = agent.getTeamId()
                    error_log(
                        f"[REORDER] Agent {agent_id}: teamId={agent_team_id}, expected={team_id}, "
                        f"match=" + ('YES' if agent_team_id == team_id else 'NO')
                    )

                    if agent_team_id == team_id:
                        agents[agent_id] = agent
                        if agent.isManager():
                            manager_ids.append(agent_id)
                        else:
                            worker_ids.append(agent_id)
                else:
                    error_log(f"[REORDER] Agent {agent_id} not found!")

            # Enforce: managers first, then workers in their submitted order
            # This ensures manager is always at the top of the stack
            enforced_order = manager_ids + worker_ids

            error_log("[REORDER] Enforced order: " + php_json_encode(enforced_order))

            self.db.begin()

            for order, agent_id in enumerate(enforced_order):
                self.db.execute(
                    "UPDATE agents SET display_order = ? WHERE id = ? AND team_id = ?",
                    [order, php_intval(agent_id), team_id],
                )
                error_log(f"[REORDER] Updated agent {agent_id} to display_order={order}")

            self.db.commit()
            error_log("[REORDER] Transaction committed successfully")

            # Check if order was modified (manager was moved)
            was_reordered = ordered_ids != enforced_order

            return {
                'success': True,
                'reordered': was_reordered,
                'enforced_order': enforced_order,
                'message': (
                    'Order adjusted: Manager must remain at the top of the pipeline'
                    if was_reordered else None
                ),
            }
        except pymysql.err.OperationalError as e:
            self.db.rollback()
            error_log(f"Failed to update agent order: {e}")
            return {
                'success': False,
                'error': 'Failed to update agent order',
            }

    def moveAgentUp(self, agent_id: int) -> bool:
        """PHP 669-710."""
        agent = self.findById(agent_id)
        if not agent or agent.getTeamId() is None:
            return False

        team_agents = self.findByTeamId(agent.getTeamId())
        current_index = -1

        for index, team_agent in enumerate(team_agents):
            if team_agent.getId() == agent_id:
                current_index = index
                break

        # Already at top or not found
        if current_index <= 0:
            return False

        # Swap with previous agent
        prev_agent = team_agents[current_index - 1]
        prev_order = prev_agent.getDisplayOrder()
        current_order = agent.getDisplayOrder()

        try:
            self.db.begin()

            self.db.execute("UPDATE agents SET display_order = ? WHERE id = ?", [prev_order, agent_id])
            self.db.execute("UPDATE agents SET display_order = ? WHERE id = ?", [current_order, prev_agent.getId()])

            self.db.commit()
            return True
        except pymysql.err.OperationalError as e:
            self.db.rollback()
            error_log(f"Failed to move agent up: {e}")
            return False

    def moveAgentDown(self, agent_id: int) -> bool:
        """PHP 718-759."""
        agent = self.findById(agent_id)
        if not agent or agent.getTeamId() is None:
            return False

        team_agents = self.findByTeamId(agent.getTeamId())
        current_index = -1

        for index, team_agent in enumerate(team_agents):
            if team_agent.getId() == agent_id:
                current_index = index
                break

        # Already at bottom or not found
        if current_index < 0 or current_index >= len(team_agents) - 1:
            return False

        # Swap with next agent
        next_agent = team_agents[current_index + 1]
        next_order = next_agent.getDisplayOrder()
        current_order = agent.getDisplayOrder()

        try:
            self.db.begin()

            self.db.execute("UPDATE agents SET display_order = ? WHERE id = ?", [next_order, agent_id])
            self.db.execute("UPDATE agents SET display_order = ? WHERE id = ?", [current_order, next_agent.getId()])

            self.db.commit()
            return True
        except pymysql.err.OperationalError as e:
            self.db.rollback()
            error_log(f"Failed to move agent down: {e}")
            return False
