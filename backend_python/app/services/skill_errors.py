"""Ports of Services/SkillClashException.php, SkillForbidden.php, SkillInUse.php, SkillNotFound.php,
SkillPathInvalid.php, SkillRequiredBy.php and PrivateSkillsRefused.php: the SkillStore errors; statusCode() is the
HTTP status the API answers with."""
from __future__ import annotations


class SkillClashException(RuntimeError):
    """SkillStore error (clash)."""

    def statusCode(self) -> int:
        return 409


class SkillForbidden(RuntimeError):
    """SkillStore error (not allowed)."""

    def statusCode(self) -> int:
        return 403


class SkillNotFound(RuntimeError):
    """SkillStore error (no such skill)."""

    def statusCode(self) -> int:
        return 404


class SkillPathInvalid(RuntimeError):
    """SkillStore error (invalid path)."""

    def statusCode(self) -> int:
        return 400


class SkillInUse(RuntimeError):
    """A public skill the robot's workflows bind cannot be made private, renamed or deleted; carries those workflows."""

    def __init__(self, workflows: list):
        super().__init__('A workflow of the robot uses this skill.')
        self._workflows = workflows

    def workflows(self) -> list:
        return self._workflows

    def statusCode(self) -> int:
        return 409


class SkillRequiredBy(RuntimeError):
    """A skill other skills need (their required skills, LangGraphPackage.requiredSkills) cannot be deleted, renamed or
    made private; a skill cannot be made public with a required skill the caller cannot make public. 409.
    reason: delete | rename | private | public | changed; requiredBy: the dependent skills the caller can see; needs:
    (public) the required skill that blocks it."""

    def __init__(self, message: str, reason: str, skill: str, requiredBy: list | None = None, needs: str = ''):
        super().__init__(message)
        self.reason = reason
        self.skill = skill
        self.requiredBy = requiredBy or []
        self.needs = needs

    def data(self) -> dict:
        return {'message': str(self), 'reason': self.reason, 'skill': self.skill, 'required_by': self.requiredBy,
                **({'needs': self.needs} if self.needs != '' else {})}

    def statusCode(self) -> int:
        return 409
