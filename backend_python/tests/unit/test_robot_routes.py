"""routes.py twins the routes.php additions of the robot/roles work: role keys take digits and dashes."""
from __future__ import annotations

from app.routes import CONTROLLERS, ROUTES
from app.support.router import Dispatcher


def test_role_key_routes_take_digits_and_dashes():
    d = Dispatcher(ROUTES)
    for method, uri, handler, params in [
        ('GET', '/api/v1/admin/packages/it-ops-2', ('PackageController', 'adminGet'), {'role': 'it-ops-2'}),
        ('PUT', '/api/v1/admin/packages/2024', ('PackageController', 'adminUpdate'), {'role': '2024'}),
        ('GET', '/api/v1/admin/roles', ('RolesController', 'index'), {}),
        ('POST', '/api/v1/admin/roles', ('RolesController', 'create'), {}),
        ('PUT', '/api/v1/admin/roles/it-ops-2', ('RolesController', 'rename'), {'role': 'it-ops-2'}),
        ('DELETE', '/api/v1/admin/roles/ops', ('RolesController', 'destroy'), {'role': 'ops'}),
        ('POST', '/api/v1/playbooks/7/publish', ('PlaybooksController', 'publish'), {'id': '7'}),
        ('GET', '/api/v1/robot', ('RobotController', 'show'), {}),
        ('GET', '/api/v1/robot/playbooks', ('RobotController', 'playbooks'), {}),
        ('DELETE', '/api/v1/robot/playbooks/7', ('RobotController', 'unpublish'), {'id': '7'}),
    ]:
        r = d.dispatch(method, uri)
        assert (r.status, r.handler, r.params) == ('FOUND', handler, params), uri
        assert handler[0] in CONTROLLERS
    for bad in ('/api/v1/admin/roles/Ops', '/api/v1/admin/roles/ops-', '/api/v1/admin/packages/a--b'):
        assert d.dispatch('PUT', bad).status == 'NOT_FOUND', bad
