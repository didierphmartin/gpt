import pytest
from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_me_and_admin_reads(both):
    same(*both('GET', '/api/v1/me/package'))
    same(*both('GET', '/api/v1/me/package', auth=False))          # 401 (protected route)
    same(*both('GET', '/api/v1/admin/packages'))                  # 200 for admin user 3, else 403 — same on both
    same(*both('GET', '/api/v1/admin/packages/user'))
    same(*both('GET', '/api/v1/admin/packages/bogus'))            # 404 route (regex [a-z]+ matches; 400 invalid role)
    same(*both('PUT', '/api/v1/admin/packages/user', json={}))
    same(*both('PUT', '/api/v1/admin/packages/user', json={'capabilities': {'providers': {}}}))
