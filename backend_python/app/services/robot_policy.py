"""Port of Services/RobotPolicy.php: who may use (publish to, read) and manage
(unpublish from) the robot: everyone on Individual; else by role."""
from __future__ import annotations

from app.services import edition
from app.services.package_resolver import PackageResolver


class RobotPolicy:
    def __init__(self, db, config: dict):
        self.config = config
        self.resolver = PackageResolver(db)

    def canUse(self, userId: int) -> bool:
        if edition.current(self.config) == 'individual':
            return True
        caps = self.resolver.resolveForUser(userId)['capabilities']
        return isinstance(caps, dict) and caps.get('use_robot') is True

    def canManage(self, userId: int) -> bool:
        return edition.current(self.config) == 'individual' or self.resolver.resolveRole(userId) == 'admin'
