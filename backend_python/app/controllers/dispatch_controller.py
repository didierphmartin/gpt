"""Port of Controllers/DispatchController.php, providers() only.

Decision-model routing is not supported on the Python backend yet: the list
shows every decision provider, none routable.
"""
from __future__ import annotations

from app.services.decision_access import package_allowed, router_rows
from app.services.provider_kinds import dispatch_provider_list


class DispatchController:
    def __init__(self, db, config: dict | None = None):
        self.db = db
        self.config = config or {}

    def providers(self, request) -> dict:
        """GET /dispatch/providers: every decision provider; none routable on this backend. Never a key."""
        rows = router_rows(self.db)
        allowed = package_allowed(self.db, request.get('user_id'))
        return {'success': True, **dispatch_provider_list(rows, allowed), 'status_code': 200}
