"""Port of Services/RobotOwnership.php.

A workflow owned by the robot is shared with every user who may use the robot; its runs are the robot's.
"""
from __future__ import annotations

from app.services.robot_account import RobotAccount
from app.services.robot_policy import RobotPolicy
from app.support.phpcompat import php_strval


class RobotOwnership:
    def __init__(self, db, config: dict):
        self.db = db
        self._robotId: int | None = None
        self._robotLoaded = False
        self.policy = RobotPolicy(db, config)

    def robotId(self) -> int | None:
        if not self._robotLoaded:
            self._robotId = RobotAccount.id(self.db)
            self._robotLoaded = True
        return self._robotId

    def robotFor(self, callerId: int) -> int | None:
        """The robot's id when the caller may use the robot, else None."""
        return self.robotId() if self.policy.canUse(callerId) else None

    def linkRobotFor(self, ownerId: int) -> int | None:
        """The robot rows a workflow owned by `ownerId` may link: the robot's when the owner is the robot or may use
        it, else None."""
        return ownerId if self.robotId() == ownerId else self.robotFor(ownerId)

    def isRobotOwned(self, workflowId: int) -> bool:
        robot = self.robotId()
        if robot is None:
            return False
        return self.db.fetch_one('SELECT 1 FROM agent_workflows WHERE id = ? AND user_id = ?', [workflowId, robot]) is not None

    def runAs(self, callerId: int, workflowId: int) -> int:
        """Who a run of this workflow executes as: the robot for a robot workflow the caller may use, else the caller."""
        robot = self.robotFor(callerId)
        return robot if robot is not None and self.isRobotOwned(workflowId) else callerId

    def lockedRunName(self, callerId: int, workflowId: int) -> str | None:
        """The workflow's name when the caller would run it as the robot (they may use the robot and it is
        robot-owned) and it is locked, else None: a browser run door's refusal, checked only after access so it
        reveals nothing."""
        if self.runAs(callerId, workflowId) == callerId or not self.isLocked(workflowId):
            return None
        row = self.db.fetch_one('SELECT name FROM agent_workflows WHERE id = ?', [workflowId])
        # PHP (string) fetchColumn(): a missing row's false casts to ''
        return '' if row is None else php_strval(row['name'])

    def isLocked(self, workflowId: int) -> bool:
        """Robot-owned and active: nobody edits it until it is unlocked."""
        if not self.isRobotOwned(workflowId):
            return False
        return self.db.fetch_one('SELECT 1 FROM active_workflows WHERE workflow_id = ?', [workflowId]) is not None
