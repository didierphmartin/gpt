"""Port of Services/PrivateSkillsRefused.php: a robot workflow binds private skills; the robot can only use public
ones. Answer with RobotSkillPolicy.refusal()."""
from __future__ import annotations



class PrivateSkillsRefused(RuntimeError):
    def __init__(self, skills: list):
        """skills: [{path, owner_id, owner_name}]."""
        from app.services.robot_skill_policy import RobotSkillPolicy
        super().__init__(RobotSkillPolicy.MESSAGE)
        self.skills = skills
