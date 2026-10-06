"""Port of Controllers/RequiresAdmin.php (the trait), for controllers whose every
action is admin-only. Returns None for an admin caller, else the error dict to return as-is."""
from __future__ import annotations

from app.support.logger import error_log


def require_admin(db, request) -> dict | None:
    user_id = request.get('user_id')
    if not user_id:
        return {'success': False, 'error': 'Authentication required', 'status_code': 401}
    try:
        user = db.fetch_one('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': user_id})
    except Exception as e:  # noqa: BLE001 — a database failure must never read as "permission granted"
        error_log(f'[RequiresAdmin] role lookup failed: {e}')
        return {'success': False, 'error': 'Admin access required', 'status_code': 403}
    if not user or (user.get('role') or '') != 'admin':
        return {'success': False, 'error': 'Admin access required', 'status_code': 403}
    return None
