"""Port of backend/src/AgentTeam/Services/TeamRepository.php (195 lines).

Handles CRUD operations for teams.
"""
from __future__ import annotations

from app.agent_team.models.team import Team
from app.agent_team.services.agent_repository import AgentRepository
from app.support.phpcompat import php_intval


class TeamRepository:
    def __init__(self, db, agent_repository: AgentRepository | None = None):
        self.db = db
        self.agentRepository = agent_repository if agent_repository is not None else AgentRepository(db)

    def findById(self, id: int) -> Team | None:
        """PHP 31-38."""
        row = self.db.fetch_one("SELECT * FROM agent_teams WHERE id = ?", [id])
        return Team(row) if row else None

    def findByIdWithAgents(self, id: int) -> Team | None:
        """PHP 43-55."""
        team = self.findById(id)
        if not team:
            return None

        # Get agents with pipeline position info
        agents_with_info = self.agentRepository.findByTeamIdWithPipelineInfo(id)
        team.setAgentsWithPipelineInfo(agents_with_info)

        return team

    def findByUser(self, user_id: int) -> list[Team]:
        """PHP 60-71."""
        rows = self.db.fetch_all(
            "SELECT * FROM agent_teams WHERE user_id = ? ORDER BY name ASC", [user_id]
        )
        return [Team(row) for row in rows]

    def findByUserWithAgents(self, user_id: int) -> list[Team]:
        """PHP 76-87."""
        teams = self.findByUser(user_id)

        for team in teams:
            # Get agents with pipeline position info
            agents_with_info = self.agentRepository.findByTeamIdWithPipelineInfo(team.getId())
            team.setAgentsWithPipelineInfo(agents_with_info)

        return teams

    def create(self, team: Team) -> Team:
        """PHP 92-109."""
        sql = (
            "INSERT INTO agent_teams (user_id, workspace_id, name, description)\n"
            "                VALUES (:user_id, :workspace_id, :name, :description)"
        )

        data = team.toArray()

        new_id = self.db.insert(sql, {
            'user_id': data['user_id'],
            'workspace_id': data['workspace_id'],
            'name': data['name'],
            'description': data['description'],
        })

        return self.findById(new_id)

    def update(self, team: Team) -> Team:
        """PHP 114-133."""
        sql = (
            "UPDATE agent_teams SET\n"
            "                name = :name,\n"
            "                description = :description,\n"
            "                workspace_id = :workspace_id\n"
            "                WHERE id = :id"
        )

        data = team.toArray()

        self.db.execute(sql, {
            'id': data['id'],
            'name': data['name'],
            'description': data['description'],
            'workspace_id': data['workspace_id'],
        })

        return self.findById(team.getId())

    def delete(self, id: int) -> bool:
        """PHP 138-147. Deletes all agents in the team first, then the team.
        `$stmt->execute([$id])` is the boolean success of the exec, not a
        rowCount check."""
        # First, delete all agents in this team
        self.db.execute("DELETE FROM agents WHERE team_id = ?", [id])

        # Then delete the team
        self.db.execute("DELETE FROM agent_teams WHERE id = ?", [id])
        return True

    def canUserAccess(self, user_id: int, team_id: int) -> bool:
        """PHP 152-161."""
        team = self.findById(team_id)
        if not team:
            return False

        # Owner always has access
        return team.getUserId() == user_id

    def isOwner(self, user_id: int, team_id: int) -> bool:
        """PHP 166-170."""
        team = self.findById(team_id)
        return bool(team) and team.getUserId() == user_id

    def countByUser(self, user_id: int) -> int:
        """PHP 175-182."""
        col = self.db.fetch_column("SELECT COUNT(*) FROM agent_teams WHERE user_id = ?", [user_id])
        return php_intval(col[0]) if col else 0

    def countAgents(self, team_id: int) -> int:
        """PHP 187-194."""
        col = self.db.fetch_column(
            "SELECT COUNT(*) FROM agents WHERE team_id = ? AND enabled = 1", [team_id]
        )
        return php_intval(col[0]) if col else 0
