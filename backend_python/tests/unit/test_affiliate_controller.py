"""Unit tests for AffiliateController (Phase 7, Task 4).

PHP sources:
  backend/src/Controllers/AffiliateController.php (1-397)
  backend/src/Services/AffiliateRepository.php
  backend/src/Services/AffiliateCommission.php
  backend/src/Services/AffiliateSupport.php

`self.db` stands in for the single PDO the PHP controller + repository share
(FakeDb below), so SQL assertions cover both the controller's direct queries
(admin/affiliate identity, adminDelete's role check) and the repository's.
"""
import pytest
from starlette.datastructures import Headers

from app.controllers.affiliate_controller import (
    AffiliateController,
    _AffiliateCommission,
    _AffiliateSupport,
)
from app.support.http import Ctx


class FakeDb:
    """Records every statement so tests can assert SQL byte-for-byte."""

    def __init__(self, one=None, all_=None, insert_id=1, rowcount=1, raise_on=None):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.insert_id = insert_id
        self.rowcount = rowcount
        self.raise_on = raise_on or {}
        self.calls = []
        self.began = 0
        self.committed = 0
        self.rolledback = 0

    def fetch_one(self, sql, params=None):
        self.calls.append(('fetch_one', sql, params))
        return self.one.pop(0) if self.one else None

    def fetch_all(self, sql, params=None):
        self.calls.append(('fetch_all', sql, params))
        return self.all_.pop(0) if self.all_ else []

    def execute(self, sql, params=None):
        self.calls.append(('execute', sql, params))
        if 'execute' in self.raise_on:
            raise self.raise_on['execute']
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append(('insert', sql, params))
        if 'insert' in self.raise_on:
            raise self.raise_on['insert']
        return self.insert_id

    def begin(self):
        self.began += 1

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1


def ctx(body=None, user_id=3):
    return Ctx(method='POST', uri='/', headers=Headers({}), query={}, body=body or {}, raw_body='',
               params={}, user_id=user_id, authenticated=user_id is not None, remote_addr='')


ADMIN_ROW = {'role': 'admin'}
USER_ROW = {'role': 'user'}


# ─── AffiliateCommission (pure math) ────────────────────────────────────────

def test_commission_compute_percent_and_fixed():
    assert _AffiliateCommission.compute('percent', 20.0, 100.0) == 20.0
    assert _AffiliateCommission.compute('percent', 33.333, 10.0) == 3.33
    assert _AffiliateCommission.compute('fixed', 15.0, 999.0) == 15.0
    assert _AffiliateCommission.compute('fixed', -5.0, 10.0) == 0.0   # never negative


def test_commission_compute_negative_sale_clamped_to_zero():
    assert _AffiliateCommission.compute('percent', 20.0, -50.0) == 0.0


def test_commission_compute_unknown_type_raises():
    with pytest.raises(ValueError, match='Unknown commission type: bogus'):
        _AffiliateCommission.compute('bogus', 1.0, 1.0)


def test_commission_resolve_override_wins_when_both_fields_set():
    account = {'commission_type': 'fixed', 'commission_value': 5.0}
    product = {'commission_type': 'percent', 'commission_value': 10.0}
    assert _AffiliateCommission.resolve(account, product) == ('fixed', 5.0)


def test_commission_resolve_falls_back_to_product_when_override_partial_or_absent():
    product = {'commission_type': 'percent', 'commission_value': 10.0}
    assert _AffiliateCommission.resolve({'commission_type': None, 'commission_value': None}, product) == ('percent', 10.0)
    assert _AffiliateCommission.resolve({'commission_type': 'fixed', 'commission_value': None}, product) == ('percent', 10.0)
    assert _AffiliateCommission.resolve({}, product) == ('percent', 10.0)


# ─── AffiliateSupport (pure helpers) ────────────────────────────────────────

def test_support_generate_key_shape():
    key = _AffiliateSupport.generateKey()
    assert len(key) == 16
    assert all(c in _AffiliateSupport.ALPHABET for c in key)


def test_support_generate_key_uniqueness():
    # Port of AffiliateSupportTest::testKeysAreUnique (backend/tests/Unit/AffiliateSupportTest.php).
    a = _AffiliateSupport.generateKey()
    b = _AffiliateSupport.generateKey()
    assert a != b


def test_support_build_link_question_mark_vs_ampersand():
    assert _AffiliateSupport.buildLink('https://x.com/sale', 'AB12') == 'https://x.com/sale?ref=AB12'
    assert _AffiliateSupport.buildLink('https://x.com/sale?a=1', 'AB12') == 'https://x.com/sale?a=1&ref=AB12'
    assert _AffiliateSupport.buildLink('  https://x.com/sale  ', 'AB12') == 'https://x.com/sale?ref=AB12'


def test_support_build_link_urlencodes_key():
    assert _AffiliateSupport.buildLink('https://x.com', 'a b/c') == 'https://x.com?ref=a%20b%2Fc'


# ─── admin gate (shared by every admin* endpoint) ───────────────────────────

def test_requireAdmin_unauthenticated_and_non_admin():
    ctrl = AffiliateController(FakeDb(), {})
    assert ctrl.adminList(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}
    ctrl2 = AffiliateController(FakeDb(one=[USER_ROW]), {})
    assert ctrl2.adminList(ctx()) == {'success': False, 'error': 'Admin access required', 'status_code': 403}
    ctrl3 = AffiliateController(FakeDb(one=[None]), {})
    assert ctrl3.adminList(ctx()) == {'success': False, 'error': 'Admin access required', 'status_code': 403}


def test_requireAdmin_sql():
    db = FakeDb(one=[ADMIN_ROW])
    AffiliateController(db, {}).adminList(ctx())
    assert db.calls[0] == ('fetch_one', 'SELECT role FROM users WHERE id = :id LIMIT 1', {':id': 3})


# ─── adminList / adminGet ───────────────────────────────────────────────────

def test_adminList_sql():
    db = FakeDb(one=[ADMIN_ROW], all_=[[{'id': 1}]])
    result = AffiliateController(db, {}).adminList(ctx())
    assert result == {'success': True, 'affiliates': [{'id': 1}]}
    assert db.calls[-1][1].strip().startswith('SELECT a.id, a.user_id')


def test_adminGet_not_found():
    db = FakeDb(one=[ADMIN_ROW, None])
    result = AffiliateController(db, {}).adminGet(ctx(), 999)
    assert result == {'success': False, 'error': 'Affiliate not found', 'status_code': 404}


def test_adminGet_success_decorates_accounts():
    aff = {'id': 5, 'user_id': 1}
    account = {'account_id': 1, 'affiliate_id': 5, 'product_id': 2, 'override_type': None,
               'override_value': None, 'product_type': 'percent', 'product_value': 10.0,
               'affiliate_key': 'KEY123', 'sales_page_url': 'https://x.com'}
    db = FakeDb(one=[ADMIN_ROW, aff], all_=[[account]])
    result = AffiliateController(db, {}).adminGet(ctx(), 5)
    assert result['success'] is True
    assert result['affiliate'] == aff
    decorated = result['accounts'][0]
    assert decorated['effective_type'] == 'percent' and decorated['effective_value'] == 10.0
    assert decorated['link'] == 'https://x.com?ref=KEY123'


# ─── adminCreate ─────────────────────────────────────────────────────────────

def test_adminCreate_name_and_email_required():
    db = FakeDb(one=[ADMIN_ROW])
    assert AffiliateController(db, {}).adminCreate(ctx(body={'name': '', 'email': ''})) == {
        'success': False, 'error': 'name and email are required', 'status_code': 400}


def test_adminCreate_existing_user_already_affiliate():
    db = FakeDb(one=[ADMIN_ROW, {'id': 10}, {'id': 99, 'user_id': 10}])
    result = AffiliateController(db, {}).adminCreate(ctx(body={'name': 'Bob', 'email': 'bob@x.com'}))
    assert result == {'success': False, 'error': 'This user is already an affiliate', 'status_code': 400}


def test_adminCreate_new_person_requires_password():
    db = FakeDb(one=[ADMIN_ROW, None])   # no existing user row
    result = AffiliateController(db, {}).adminCreate(ctx(body={'name': 'Bob', 'email': 'bob@x.com'}))
    assert result == {'success': False, 'error': 'password is required to register a new affiliate user',
                       'status_code': 400}


def test_adminCreate_existing_user_no_password_needed_sql():
    db = FakeDb(one=[ADMIN_ROW, {'id': 10}, None], insert_id=77)   # user exists, not yet an affiliate
    result = AffiliateController(db, {}).adminCreate(ctx(body={'name': 'Bob', 'email': 'bob@x.com'}))
    assert result['success'] is True
    assert result['existing_user'] is True
    assert result['affiliate_id'] == 77
    assert len(result['affiliate_key']) == 16
    assert db.began == 1 and db.committed == 1
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert insert_call[1].strip().startswith('INSERT INTO affiliates')
    assert insert_call[2][':uid'] == 10 and insert_call[2][':name'] == 'Bob' and insert_call[2][':email'] == 'bob@x.com'
    # no `users` INSERT happened for an existing user
    assert not any(c[0] == 'insert' and 'INSERT INTO users' in c[1] for c in db.calls)


def test_adminCreate_new_person_bcrypt_and_insert_sql():
    db = FakeDb(one=[ADMIN_ROW, None], insert_id=42)
    result = AffiliateController(db, {}).adminCreate(
        ctx(body={'name': 'New', 'email': 'new@x.com', 'password': 'sekret'}))
    assert result['success'] is True and result['existing_user'] is False
    user_insert = next(c for c in db.calls if c[0] == 'insert' and 'INSERT INTO users' in c[1])
    assert user_insert[1] == (
        "INSERT INTO users (email, password, first_name, role, provider, created_at, updated_at)\n"
        "                     VALUES (:email, :password, :name, 'affiliate', 'email', NOW(), NOW())")
    assert user_insert[2][':email'] == 'new@x.com' and user_insert[2][':name'] == 'New'
    assert user_insert[2][':password'].startswith('$2b$')   # bcrypt hash (PHP's password_hash emits $2y$; both verify)


def test_adminCreate_duplicate_rolls_back_and_returns_400():
    db = FakeDb(one=[ADMIN_ROW, None], raise_on={'insert': RuntimeError('Duplicate entry for key email')})
    result = AffiliateController(db, {}).adminCreate(
        ctx(body={'name': 'New', 'email': 'new@x.com', 'password': 'sekret'}))
    assert result == {'success': False, 'error': 'A user with that email already exists', 'status_code': 400}
    assert db.rolledback == 1


def test_adminCreate_non_duplicate_error_propagates():
    db = FakeDb(one=[ADMIN_ROW, None], raise_on={'insert': RuntimeError('connection reset')})
    with pytest.raises(RuntimeError, match='connection reset'):
        AffiliateController(db, {}).adminCreate(ctx(body={'name': 'New', 'email': 'new@x.com', 'password': 'x'}))
    assert db.rolledback == 1


# ─── adminDelete ─────────────────────────────────────────────────────────────

def test_adminDelete_not_found():
    db = FakeDb(one=[ADMIN_ROW, None])
    assert AffiliateController(db, {}).adminDelete(ctx(), 5) == {
        'success': False, 'error': 'Affiliate not found', 'status_code': 404}


def test_adminDelete_removes_user_only_when_role_is_affiliate():
    aff = {'id': 5, 'user_id': 20}
    db = FakeDb(one=[ADMIN_ROW, aff, {'role': 'affiliate'}])
    result = AffiliateController(db, {}).adminDelete(ctx(), 5)
    assert result == {'success': True}
    delete_calls = [c for c in db.calls if c[0] == 'execute']
    assert delete_calls == [
        ('execute', 'DELETE FROM affiliates WHERE id = :id', {':id': 5}),
        ('execute', 'DELETE FROM users WHERE id = :uid', {':uid': 20}),
    ]


def test_adminDelete_keeps_shared_account_login():
    aff = {'id': 5, 'user_id': 20}
    db = FakeDb(one=[ADMIN_ROW, aff, {'role': 'user'}])
    result = AffiliateController(db, {}).adminDelete(ctx(), 5)
    assert result == {'success': True}
    delete_calls = [c for c in db.calls if c[0] == 'execute']
    assert delete_calls == [('execute', 'DELETE FROM affiliates WHERE id = :id', {':id': 5})]


# ─── admin accounts ──────────────────────────────────────────────────────────

def test_adminAddAccount_not_found_unknown_product_and_dupe():
    db = FakeDb(one=[ADMIN_ROW, None])
    assert AffiliateController(db, {}).adminAddAccount(ctx(), 5) == {
        'success': False, 'error': 'Affiliate not found', 'status_code': 404}

    db2 = FakeDb(one=[ADMIN_ROW, {'id': 5}, None])
    assert AffiliateController(db2, {}).adminAddAccount(ctx(body={'product_id': 9}), 5) == {
        'success': False, 'error': 'Unknown product', 'status_code': 400}

    db3 = FakeDb(one=[ADMIN_ROW, {'id': 5}, {'id': 9}, {'id': 1}])
    assert AffiliateController(db3, {}).adminAddAccount(ctx(body={'product_id': 9}), 5) == {
        'success': False, 'error': 'Account already exists', 'status_code': 400}


def test_adminAddAccount_success_with_override():
    db = FakeDb(one=[ADMIN_ROW, {'id': 5}, {'id': 9}, None], insert_id=3)
    result = AffiliateController(db, {}).adminAddAccount(
        ctx(body={'product_id': 9, 'commission_type': 'fixed', 'commission_value': '12.5'}), 5)
    assert result == {'success': True}
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert insert_call[2] == {':a': 5, ':p': 9, ':t': 'fixed', ':v': 12.5}


def test_adminUpdateAccount_not_found_variants():
    db = FakeDb(one=[ADMIN_ROW, None])
    assert AffiliateController(db, {}).adminUpdateAccount(ctx(), 5, 9) == {
        'success': False, 'error': 'Affiliate not found', 'status_code': 404}
    db2 = FakeDb(one=[ADMIN_ROW, {'id': 5}, None])
    assert AffiliateController(db2, {}).adminUpdateAccount(ctx(), 5, 9) == {
        'success': False, 'error': 'Account not found', 'status_code': 404}


def test_adminUpdateAccount_clears_override_when_blank():
    db = FakeDb(one=[ADMIN_ROW, {'id': 5}, {'id': 1}])
    result = AffiliateController(db, {}).adminUpdateAccount(ctx(body={'commission_type': '', 'commission_value': ''}), 5, 9)
    assert result == {'success': True}
    execute_call = next(c for c in db.calls if c[0] == 'execute')
    assert execute_call[2] == {':a': 5, ':p': 9, ':t': None, ':v': None}


def test_adminDeleteAccount_no_existence_check():
    """PHP's adminDeleteAccount has NO findAffiliate/findAccount guard — it just deletes."""
    db = FakeDb(one=[ADMIN_ROW])
    result = AffiliateController(db, {}).adminDeleteAccount(ctx(), 5, 9)
    assert result == {'success': True}
    assert db.calls[-1] == ('execute', 'DELETE FROM affiliate_accounts WHERE affiliate_id = :a AND product_id = :p',
                            {':a': 5, ':p': 9})


# ─── admin transactions ──────────────────────────────────────────────────────

def test_adminTransactions_not_found():
    db = FakeDb(one=[ADMIN_ROW, None])
    assert AffiliateController(db, {}).adminTransactions(ctx(), 5) == {
        'success': False, 'error': 'Affiliate not found', 'status_code': 404}


def test_adminTransactions_totals():
    db = FakeDb(one=[ADMIN_ROW, {'id': 5}],
                all_=[[{'status': 'paid', 'commission_amount': 10.5}, {'status': 'pending', 'commission_amount': 4.25}]])
    result = AffiliateController(db, {}).adminTransactions(ctx(), 5)
    assert result['totals'] == {'paid': 10.5, 'owed': 4.25, 'total': 14.75}


def test_adminMarkPaid_no_existence_check():
    db = FakeDb(one=[ADMIN_ROW], rowcount=1)
    result = AffiliateController(db, {}).adminMarkPaid(ctx(), 5, 77)
    assert result == {'success': True, 'updated': 1}
    assert db.calls[-1] == ('execute',
                            "UPDATE affiliate_sales SET status='paid', paid_at=NOW()\n"
                            "             WHERE id = :id AND affiliate_id = :aid AND status='pending'",
                            {':id': 77, ':aid': 5})


# ─── admin products ──────────────────────────────────────────────────────────

def test_adminCreateProduct_validation():
    db = FakeDb(one=[ADMIN_ROW])
    assert AffiliateController(db, {}).adminCreateProduct(ctx(body={'name': '', 'sales_page_url': ''})) == {
        'success': False, 'error': 'name and sales_page_url are required', 'status_code': 400}
    db2 = FakeDb(one=[ADMIN_ROW])
    assert AffiliateController(db2, {}).adminCreateProduct(
        ctx(body={'name': 'P', 'sales_page_url': 'u', 'commission_type': 'bogus'})) == {
        'success': False, 'error': 'commission_type must be percent or fixed', 'status_code': 400}


def test_adminCreateProduct_defaults_and_sql():
    db = FakeDb(one=[ADMIN_ROW], insert_id=8)
    result = AffiliateController(db, {}).adminCreateProduct(ctx(body={'name': 'P', 'sales_page_url': 'https://x.com'}))
    assert result == {'success': True, 'product_id': 8}
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert insert_call[2] == {':name': 'P', ':app_ref': None, ':url': 'https://x.com',
                              ':ctype': 'percent', ':cval': 0.0, ':cur': 'USD', ':active': 0}


def test_adminUpdateProduct_not_found_and_success():
    db = FakeDb(one=[ADMIN_ROW, None])
    assert AffiliateController(db, {}).adminUpdateProduct(ctx(body={'name': 'P', 'sales_page_url': 'u'}), 5) == {
        'success': False, 'error': 'Product not found', 'status_code': 404}

    db2 = FakeDb(one=[ADMIN_ROW, {'id': 5}])
    result = AffiliateController(db2, {}).adminUpdateProduct(
        ctx(body={'name': 'P2', 'sales_page_url': 'https://y.com', 'active': True, 'currency': 'eur'}), 5)
    assert result == {'success': True}
    execute_call = next(c for c in db2.calls if c[0] == 'execute')
    assert execute_call[2][':cur'] == 'EUR'
    assert execute_call[2][':active'] == 1


def test_adminDeleteProduct():
    db = FakeDb(one=[ADMIN_ROW])
    assert AffiliateController(db, {}).adminDeleteProduct(ctx(), 5) == {'success': True}
    assert db.calls[-1] == ('execute', 'DELETE FROM affiliate_products WHERE id = :id', {':id': 5})


# ─── affiliate self-scope ────────────────────────────────────────────────────

def test_requireAffiliate_unauthenticated_and_not_affiliate():
    db = FakeDb()
    assert AffiliateController(db, {}).me(ctx(user_id=None)) == {
        'error': True, 'success': False, 'message': 'Authentication required', 'status_code': 401}
    db2 = FakeDb(one=[None])
    assert AffiliateController(db2, {}).me(ctx()) == {
        'error': True, 'success': False, 'message': 'Affiliate access required', 'status_code': 403}


def test_me_success_shape():
    aff = {'id': 5, 'name': 'Bob', 'email': 'bob@x.com', 'affiliate_key': 'K1', 'status': 'active',
           'user_id': 3, 'created_at': 'c'}
    db = FakeDb(one=[aff], all_=[[]])
    result = AffiliateController(db, {}).me(ctx())
    assert result == {
        'success': True,
        'affiliate': {'id': 5, 'name': 'Bob', 'email': 'bob@x.com', 'affiliate_key': 'K1', 'status': 'active'},
        'accounts': [],
    }


def test_myTransactions_uses_requireAffiliate():
    db = FakeDb(one=[None])
    assert AffiliateController(db, {}).myTransactions(ctx()) == {
        'error': True, 'success': False, 'message': 'Affiliate access required', 'status_code': 403}


# ─── recordConversion (public route, any authenticated caller) ─────────────

def test_recordConversion_requires_authentication():
    db = FakeDb()
    assert AffiliateController(db, {}).recordConversion(ctx(user_id=None)) == {
        'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_recordConversion_validation():
    db = FakeDb()
    assert AffiliateController(db, {}).recordConversion(ctx(body={'product': 1, 'amount': 10})) == {
        'success': False, 'error': 'ref, product and a positive amount are required', 'status_code': 400}
    db2 = FakeDb()
    assert AffiliateController(db2, {}).recordConversion(ctx(body={'ref': 'X', 'product': 0, 'amount': 10})) == {
        'success': False, 'error': 'ref, product and a positive amount are required', 'status_code': 400}
    db3 = FakeDb()
    assert AffiliateController(db3, {}).recordConversion(ctx(body={'ref': 'X', 'product': 1, 'amount': 0})) == {
        'success': False, 'error': 'ref, product and a positive amount are required', 'status_code': 400}


def test_recordConversion_idempotent_on_external_ref():
    db = FakeDb(one=[{'id': 555}])
    result = AffiliateController(db, {}).recordConversion(
        ctx(body={'ref': 'AFF1', 'product': 1, 'amount': 10, 'external_ref': 'order-1'}))
    assert result == {'success': True, 'sale_id': 555, 'duplicate': True}


def test_recordConversion_unknown_affiliate_and_product_and_no_account():
    db = FakeDb(one=[None])   # saleByExternalRef skipped (no external_ref); findAffiliateByKey -> None
    assert AffiliateController(db, {}).recordConversion(ctx(body={'ref': 'BAD', 'product': 1, 'amount': 10})) == {
        'success': False, 'error': 'Unknown affiliate ref', 'status_code': 400}

    db2 = FakeDb(one=[{'id': 1, 'affiliate_key': 'AFF1'}, None])
    assert AffiliateController(db2, {}).recordConversion(ctx(body={'ref': 'AFF1', 'product': 99, 'amount': 10})) == {
        'success': False, 'error': 'Unknown product', 'status_code': 400}

    db3 = FakeDb(one=[{'id': 1}, {'id': 99}, None])
    assert AffiliateController(db3, {}).recordConversion(ctx(body={'ref': 'AFF1', 'product': 99, 'amount': 10})) == {
        'success': False, 'error': 'Affiliate has no account on this product', 'status_code': 400}


def test_recordConversion_success_computes_commission_and_inserts_sql():
    affiliate = {'id': 1}
    product = {'id': 99, 'commission_type': 'percent', 'commission_value': 20.0}
    account = {'commission_type': None, 'commission_value': None}
    db = FakeDb(one=[affiliate, product, account], insert_id=321)
    result = AffiliateController(db, {}).recordConversion(
        ctx(body={'ref': 'AFF1', 'product': 99, 'amount': 50.0, 'currency': 'eur'}))
    assert result == {'success': True, 'sale_id': 321, 'commission_amount': 10.0}
    insert_call = next(c for c in db.calls if c[0] == 'insert')
    assert insert_call[2] == {':a': 1, ':p': 99, ':sale': 50.0, ':cur': 'EUR', ':comm': 10.0, ':ext': None}


def test_recordConversion_duplicate_insert_resolves_to_existing_sale():
    affiliate = {'id': 1}
    product = {'id': 99, 'commission_type': 'percent', 'commission_value': 20.0}
    account = {'commission_type': None, 'commission_value': None}
    existing_after_conflict = {'id': 900}
    db = FakeDb(one=[None, affiliate, product, account, existing_after_conflict],
                raise_on={'insert': RuntimeError('Duplicate entry for external_ref')})
    result = AffiliateController(db, {}).recordConversion(
        ctx(body={'ref': 'AFF1', 'product': 99, 'amount': 50.0, 'external_ref': 'order-9'}))
    assert result == {'success': True, 'sale_id': 900, 'duplicate': True}


def test_recordConversion_non_duplicate_insert_error_propagates():
    affiliate = {'id': 1}
    product = {'id': 99, 'commission_type': 'percent', 'commission_value': 20.0}
    account = {'commission_type': None, 'commission_value': None}
    db = FakeDb(one=[affiliate, product, account], raise_on={'insert': RuntimeError('connection reset')})
    with pytest.raises(RuntimeError, match='connection reset'):
        AffiliateController(db, {}).recordConversion(ctx(body={'ref': 'AFF1', 'product': 99, 'amount': 50.0}))
