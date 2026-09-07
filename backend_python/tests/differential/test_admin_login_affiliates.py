"""Differential tests for LoginAdminController + AffiliateController (Phase 7, Task 4).

PHP live at http://localhost/gpt/backend, Python in-process. User 3 (must be
`role = admin` in the shared contexts DB for the admin-gated GETs below to
return 200 rather than a matched 403 on both backends).

Self-cleaning: every mutation this file makes is undone in a `finally` block,
and the round-trip tests assert the affected list is byte-identical before
and after. `POST /affiliate/conversions` is exercised for VALIDATION ONLY —
every case here is deliberately built so no sale is ever actually recorded
(bad bodies, and a ref that cannot match a real affiliate key).
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


# ─── GET parity (admin user) ────────────────────────────────────────────────

def test_login_admin_gets_parity(both):
    same(*both('GET', '/api/v1/admin/login/stats'))
    same(*both('GET', '/api/v1/admin/login/users'))
    same(*both('GET', '/api/v1/admin/login/apps'))
    # Bogus slug — deterministic on both backends regardless of whether the
    # login DB is configured/reachable in this environment (either both say
    # "Login DB not reachable", or both say "Unknown application").
    same(*both('GET', '/api/v1/admin/login/app-users?app=differential-tmp-nonexistent-app'))


def test_login_admin_unauthenticated_parity(both):
    same(*both('GET', '/api/v1/admin/login/stats', auth=False))


def test_affiliate_admin_gets_parity(both):
    same(*both('GET', '/api/v1/admin/affiliates'))
    same(*both('GET', '/api/v1/admin/affiliate-products'))


def test_affiliate_admin_not_found_parity(both):
    same(*both('GET', '/api/v1/admin/affiliates/999999999'))
    same(*both('DELETE', '/api/v1/admin/affiliates/999999999'))
    same(*both('GET', '/api/v1/admin/affiliates/999999999/transactions'))
    same(*both('PUT', '/api/v1/admin/affiliate-products/999999999', json={'name': 'x', 'sales_page_url': 'y'}))


# ─── self-scope parity: user 3 is admin, NOT an affiliate ──────────────────

def test_affiliate_me_parity_for_non_affiliate_admin(both):
    same(*both('GET', '/api/v1/affiliate/me'))
    same(*both('GET', '/api/v1/affiliate/me/transactions'))


# ─── public conversion endpoint: validation only, never records a sale ─────

def test_conversions_validation_parity(both):
    same(*both('POST', '/api/v1/affiliate/conversions', json={}))
    same(*both('POST', '/api/v1/affiliate/conversions', json={'ref': 'x', 'product': 0, 'amount': 5}))
    same(*both('POST', '/api/v1/affiliate/conversions', json={'ref': '', 'product': 1, 'amount': 5}))
    same(*both('POST', '/api/v1/affiliate/conversions', json={'ref': 'x', 'product': 1, 'amount': 0}))
    # Deliberately unmatchable — findAffiliateByKey() returns none on both
    # backends, so no product/account/commission logic (and no INSERT) runs.
    same(*both('POST', '/api/v1/affiliate/conversions',
               json={'ref': 'differential-tmp-nonexistent-affiliate-key', 'product': 1, 'amount': 10}))
    same(*both('POST', '/api/v1/affiliate/conversions', json={'ref': 'x', 'product': 1, 'amount': 5}, auth=False))


# ─── round trip: affiliate product ──────────────────────────────────────────

def test_affiliate_product_round_trip(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        before = c.get('/api/v1/admin/affiliate-products', headers=h).json()
        assert before['success'] is True

        created = c.post('/api/v1/admin/affiliate-products',
                          json={'name': 'differential-tmp-product', 'sales_page_url': 'https://example.com/tmp',
                                'commission_type': 'percent', 'commission_value': 15, 'currency': 'usd',
                                'active': True},
                          headers=h)
        assert created.status_code == 200, created.text
        cj = created.json()
        assert cj['success'] is True
        pid = cj['product_id']

        try:
            updated = c.put(f'/api/v1/admin/affiliate-products/{pid}',
                             json={'name': 'differential-tmp-product-2', 'sales_page_url': 'https://example.com/tmp2',
                                   'commission_type': 'fixed', 'commission_value': 5},
                             headers=h)
            assert updated.status_code == 200, updated.text
            assert updated.json() == {'success': True}
        finally:
            deleted = c.delete(f'/api/v1/admin/affiliate-products/{pid}', headers=h)
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {'success': True}

        after = c.get('/api/v1/admin/affiliate-products', headers=h).json()
        assert after == before


# ─── round trip: affiliate + account + mark-nothing-paid ───────────────────

def test_affiliate_create_add_account_mark_paid_delete_round_trip(php, py, token):
    """PHP first, so PHP's on-demand state lands before Python touches the
    same rows. `mark-paid` targets a sale id that can never exist, so it
    always resolves to `updated: 0` — no ledger row is ever mutated."""
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        before_affiliates = c.get('/api/v1/admin/affiliates', headers=h).json()
        assert before_affiliates['success'] is True
        before_products = c.get('/api/v1/admin/affiliate-products', headers=h).json()
        assert before_products['success'] is True

        aff_id = None
        pid = None
        try:
            created = c.post('/api/v1/admin/affiliates',
                              json={'name': 'differential-tmp-affiliate',
                                    'email': 'differential-tmp-affiliate@example.com',
                                    'password': 'Tmp-Passw0rd!'},
                              headers=h)
            assert created.status_code == 200, created.text
            cj = created.json()
            assert cj['success'] is True
            assert cj['existing_user'] is False
            aff_id = cj['affiliate_id']

            product = c.post('/api/v1/admin/affiliate-products',
                              json={'name': 'differential-tmp-product-for-affiliate',
                                    'sales_page_url': 'https://example.com/tmp-aff'},
                              headers=h)
            assert product.status_code == 200, product.text
            pj = product.json()
            assert pj['success'] is True
            pid = pj['product_id']

            added = c.post(f'/api/v1/admin/affiliates/{aff_id}/accounts', json={'product_id': pid}, headers=h)
            assert added.status_code == 200, added.text
            assert added.json() == {'success': True}

            marked = c.post(f'/api/v1/admin/affiliates/{aff_id}/transactions/999999999/mark-paid', headers=h)
            assert marked.status_code == 200, marked.text
            assert marked.json() == {'success': True, 'updated': 0}
        finally:
            # Delete the affiliate FIRST — its account row (FK'd to both the
            # affiliate and the product) cascades away with it, so the tmp
            # product can then be deleted cleanly.
            if aff_id is not None:
                deleted_aff = c.delete(f'/api/v1/admin/affiliates/{aff_id}', headers=h)
                assert deleted_aff.status_code == 200, deleted_aff.text
                assert deleted_aff.json() == {'success': True}
            if pid is not None:
                deleted_prod = c.delete(f'/api/v1/admin/affiliate-products/{pid}', headers=h)
                assert deleted_prod.status_code == 200, deleted_prod.text
                assert deleted_prod.json() == {'success': True}

        after_affiliates = c.get('/api/v1/admin/affiliates', headers=h).json()
        assert after_affiliates == before_affiliates
        after_products = c.get('/api/v1/admin/affiliate-products', headers=h).json()
        assert after_products == before_products


# ─── round trip: login-admin user create/update/delete ─────────────────────

def test_login_admin_user_round_trip(php, py, token):
    h = {'Authorization': f'Bearer {token}'}
    for c in (php, py):
        before = c.get('/api/v1/admin/login/users', headers=h).json()
        assert before['success'] is True
        if before.get('available') is False:
            pytest.skip(f'Login DB not reachable from {c.base_url} — nothing to round-trip')

        created = c.post('/api/v1/admin/login/users',
                          json={'email': 'differential-tmp-login@example.com', 'first_name': 'Tmp'},
                          headers=h)
        assert created.status_code == 200, created.text
        cj = created.json()
        assert cj['success'] is True
        uid = cj['id']

        try:
            updated = c.post('/api/v1/admin/login/users/update',
                              json={'id': uid, 'first_name': 'TmpUpdated'}, headers=h)
            assert updated.status_code == 200, updated.text
            assert updated.json() == {'success': True}
        finally:
            deleted = c.post('/api/v1/admin/login/users/delete', json={'id': uid}, headers=h)
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {'success': True}

        after = c.get('/api/v1/admin/login/users', headers=h).json()
        assert after == before
