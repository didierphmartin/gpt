"""Port of Controllers/AffiliateController.php, together with the three
Services it depends on (Services/AffiliateRepository.php,
Services/AffiliateCommission.php, Services/AffiliateSupport.php). Those three
now live in app/services/affiliate_support.py (Phase 7 final-review wave, B6 —
previously ported here as module-private helper classes, with a note that no
app/services package existed yet for them in this task's file-staging guard).
Imported below under their old module-private names so existing call sites
and tests keep working unchanged.

Admin (existing admin JWT):      /api/v1/admin/affiliates*, /api/v1/admin/affiliate-products*
Affiliate self-scope (role=affiliate): /api/v1/affiliate/me, /api/v1/affiliate/me/transactions
Conversion (any authenticated caller / selling app): POST /api/v1/affiliate/conversions
"""
from __future__ import annotations

from app.controllers.auth_controller import password_hash
from app.services.affiliate_support import AffiliateCommission as _AffiliateCommission
from app.services.affiliate_support import AffiliateRepository as _AffiliateRepository
from app.services.affiliate_support import AffiliateSupport as _AffiliateSupport
from app.support.phpcompat import php_empty, php_floatval, php_intval, php_strval, php_trim


class AffiliateController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.repo = _AffiliateRepository(db)

    # ===== Admin: affiliates ==============================================

    def adminList(self, request) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        return {'success': True, 'affiliates': self.repo.listAffiliates()}

    def adminGet(self, request, id: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        affiliate = self.repo.findAffiliate(id)
        if not affiliate:
            return self._notFound('Affiliate')
        return {
            'success': True,
            'affiliate': affiliate,
            'accounts': self._decorateAccounts(self.repo.accountsForAffiliate(id)),
        }

    def adminCreate(self, request) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        body = request.get('body') or {}
        name = php_trim(body.get('name') if body.get('name') is not None else '')
        email = php_trim(body.get('email') if body.get('email') is not None else '')
        password = php_strval(body.get('password') if body.get('password') is not None else '')
        if name == '' or email == '':
            return self._badRequest('name and email are required')

        # Is this email already a registered user (client, prospect, affiliate…)?
        # Affiliate status lives in the `affiliates` table, independent of the
        # user's role — so an existing user just needs an affiliate row added,
        # not a brand-new account.
        existing = self.db.fetch_one('SELECT id FROM users WHERE email = :email LIMIT 1', {':email': email})
        isExisting = existing is not None

        if isExisting:
            if self.repo.findAffiliateByUserId(php_intval(existing['id'])):
                return self._badRequest('This user is already an affiliate')
        elif password == '':
            # Only a brand-new person needs a login provisioned, so the
            # password is required only in that case.
            return self._badRequest('password is required to register a new affiliate user')

        # Provision the auth user only if new, then the affiliate row, atomically.
        self.db.begin()
        try:
            if isExisting:
                userId = php_intval(existing['id'])
            else:
                userId = self.db.insert(
                    "INSERT INTO users (email, password, first_name, role, provider, created_at, updated_at)\n"
                    "                     VALUES (:email, :password, :name, 'affiliate', 'email', NOW(), NOW())",
                    {':email': email, ':password': password_hash(password), ':name': name},
                )

            key = _AffiliateSupport.generateKey()
            while self.repo.keyExists(key):
                key = _AffiliateSupport.generateKey()
            affiliateId = self.repo.insertAffiliate(userId, name, email, key)

            self.db.commit()
        except Exception as e:  # noqa: BLE001
            try:
                self.db.rollback()
            except Exception:  # noqa: BLE001
                pass
            msg = str(e)
            if 'Duplicate' in msg or '1062' in msg:
                return self._badRequest('A user with that email already exists')
            raise

        return {
            'success': True,
            'affiliate_id': affiliateId,
            'affiliate_key': key,
            'existing_user': isExisting,
        }

    def adminDelete(self, request, id: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        affiliate = self.repo.findAffiliate(id)
        if not affiliate:
            return self._notFound('Affiliate')
        userId = php_intval(affiliate['user_id'])

        # Always remove the affiliate row (cascades to its accounts + sales via
        # the affiliate-internal FKs). There is no FK from affiliates.user_id to
        # users (id types differ), so the user row is handled separately below.
        self.db.execute('DELETE FROM affiliates WHERE id = :id', {':id': id})

        # Remove the auth login ONLY if the account exists solely for affiliate
        # use (role = 'affiliate'). A shared account that is also a client or
        # prospect keeps its login so we don't destroy their other access/data.
        roleRow = self.db.fetch_one('SELECT role FROM users WHERE id = :uid LIMIT 1', {':uid': userId})
        if roleRow and roleRow.get('role') == 'affiliate':
            self.db.execute('DELETE FROM users WHERE id = :uid', {':uid': userId})
        return {'success': True}

    # ===== Admin: accounts ================================================

    def adminAddAccount(self, request, id: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        if not self.repo.findAffiliate(id):
            return self._notFound('Affiliate')
        body = request.get('body') or {}
        productId = php_intval(body.get('product_id') if body.get('product_id') is not None else 0)
        if not self.repo.findProduct(productId):
            return self._badRequest('Unknown product')
        if self.repo.findAccount(id, productId):
            return self._badRequest('Account already exists')

        type_, value = self._readOptionalOverride(body)
        self.repo.insertAccount(id, productId, type_, value)
        return {'success': True}

    def adminUpdateAccount(self, request, id: int, productId: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        if not self.repo.findAffiliate(id):
            return self._notFound('Affiliate')
        if not self.repo.findAccount(id, productId):
            return self._notFound('Account')

        # Empty/missing override clears it (account then inherits the product default).
        type_, value = self._readOptionalOverride(request.get('body') or {})
        self.repo.updateAccount(id, productId, type_, value)
        return {'success': True}

    def adminDeleteAccount(self, request, id: int, productId: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        self.repo.deleteAccount(id, productId)
        return {'success': True}

    # ===== Admin: transactions ============================================

    def adminTransactions(self, request, id: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        if not self.repo.findAffiliate(id):
            return self._notFound('Affiliate')
        return self._transactionsPayload(id)

    def adminMarkPaid(self, request, id: int, saleId: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        updated = self.repo.markSalePaid(id, saleId)
        return {'success': True, 'updated': updated}

    # ===== Admin: products ================================================

    def adminListProducts(self, request) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        return {'success': True, 'products': self.repo.listProducts()}

    def adminCreateProduct(self, request) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        p = self._validateProduct(request.get('body') or {})
        if 'error' in p:
            return p
        pid = self.repo.insertProduct(p)
        return {'success': True, 'product_id': pid}

    def adminUpdateProduct(self, request, id: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        if not self.repo.findProduct(id):
            return self._notFound('Product')
        p = self._validateProduct(request.get('body') or {})
        if 'error' in p:
            return p
        self.repo.updateProduct(id, p)
        return {'success': True}

    def adminDeleteProduct(self, request, id: int) -> dict:
        err = self._requireAdmin(request)
        if err:
            return err
        self.repo.deleteProduct(id)
        return {'success': True}

    # ===== Affiliate self-scope ===========================================

    def me(self, request) -> dict:
        affiliate = self._requireAffiliate(request)
        if 'error' in affiliate:
            return affiliate
        return {
            'success': True,
            'affiliate': {
                'id': affiliate['id'], 'name': affiliate['name'],
                'email': affiliate['email'], 'affiliate_key': affiliate['affiliate_key'],
                'status': affiliate['status'],
            },
            'accounts': self._decorateAccounts(self.repo.accountsForAffiliate(php_intval(affiliate['id']))),
        }

    def myTransactions(self, request) -> dict:
        affiliate = self._requireAffiliate(request)
        if 'error' in affiliate:
            return affiliate
        return self._transactionsPayload(php_intval(affiliate['id']))

    # ===== Conversion (selling apps) ======================================

    def recordConversion(self, request) -> dict:
        if not request.get('user_id'):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        body = request.get('body') or {}
        ref = php_trim(php_strval(body.get('ref') if body.get('ref') is not None else ''))
        productId = php_intval(body.get('product') if body.get('product') is not None else 0)
        amount = php_floatval(body.get('amount') if body.get('amount') is not None else 0)
        currency = (php_trim(php_strval(body.get('currency') if body.get('currency') is not None else 'USD'))
                    .upper()) or 'USD'
        externalRef = (php_trim(php_strval(body.get('external_ref')))
                       if ('external_ref' in body and body.get('external_ref') is not None) else None)
        if externalRef == '':
            externalRef = None

        if ref == '' or productId <= 0 or amount <= 0:
            return self._badRequest('ref, product and a positive amount are required')

        # Idempotency: if this external_ref was already recorded, return it.
        if externalRef is not None:
            existing = self.repo.saleByExternalRef(externalRef)
            if existing:
                return {'success': True, 'sale_id': php_intval(existing['id']), 'duplicate': True}

        affiliate = self.repo.findAffiliateByKey(ref)
        if not affiliate:
            return self._badRequest('Unknown affiliate ref')
        product = self.repo.findProduct(productId)
        if not product:
            return self._badRequest('Unknown product')
        account = self.repo.findAccount(php_intval(affiliate['id']), productId)
        if not account:
            return self._badRequest('Affiliate has no account on this product')

        type_, value = _AffiliateCommission.resolve(account, product)
        commission = _AffiliateCommission.compute(type_, value, amount)
        try:
            saleId = self.repo.insertSale(php_intval(affiliate['id']), productId, amount, currency,
                                          commission, externalRef)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if externalRef is not None and ('Duplicate' in msg or '1062' in msg):
                existing = self.repo.saleByExternalRef(externalRef)
                if existing:
                    return {'success': True, 'sale_id': php_intval(existing['id']), 'duplicate': True}
            raise

        return {'success': True, 'sale_id': saleId, 'commission_amount': commission}

    # ===== Helpers ========================================================

    def _transactionsPayload(self, affiliateId: int) -> dict:
        rows = self.repo.transactionsForAffiliate(affiliateId)
        paid = 0.0
        owed = 0.0
        for r in rows:
            if r['status'] == 'paid':
                paid += php_floatval(r['commission_amount'])
            else:
                owed += php_floatval(r['commission_amount'])
        return {
            'success': True,
            'transactions': rows,
            'totals': {'paid': round(paid, 2), 'owed': round(owed, 2), 'total': round(paid + owed, 2)},
        }

    def _decorateAccounts(self, accounts: list) -> list:
        """Add effective commission + generated link to each account row."""
        for a in accounts:
            type_, value = _AffiliateCommission.resolve(
                {'commission_type': a.get('override_type'), 'commission_value': a.get('override_value')},
                {'commission_type': a.get('product_type'), 'commission_value': a.get('product_value')},
            )
            a['effective_type'] = type_
            a['effective_value'] = value
            a['link'] = (_AffiliateSupport.buildLink(a['sales_page_url'], a['affiliate_key'])
                         if a.get('affiliate_key') is not None else None)
        return accounts

    def _readOptionalOverride(self, body: dict) -> tuple:
        type_ = body.get('commission_type')
        value = body.get('commission_value')
        if type_ in ('', None) or value in ('', None):
            return None, None
        if type_ not in ('percent', 'fixed'):
            return None, None
        return php_strval(type_), php_floatval(value)

    def _validateProduct(self, body: dict) -> dict:
        name = php_trim(body.get('name') if body.get('name') is not None else '')
        url = php_trim(body.get('sales_page_url') if body.get('sales_page_url') is not None else '')
        type_ = body.get('commission_type') if body.get('commission_type') is not None else 'percent'
        if name == '' or url == '':
            return self._badRequest('name and sales_page_url are required')
        if type_ not in ('percent', 'fixed'):
            return self._badRequest('commission_type must be percent or fixed')
        appRef = php_trim(body.get('app_ref') if body.get('app_ref') is not None else '')
        currency = (php_trim(body.get('currency') if body.get('currency') is not None else 'USD').upper()) or 'USD'
        return {
            'name': name,
            'app_ref': appRef if appRef != '' else None,
            'sales_page_url': url,
            'commission_type': type_,
            'commission_value': php_floatval(body.get('commission_value') if body.get('commission_value') is not None else 0),
            'currency': currency,
            'active': 0 if php_empty(body.get('active')) else 1,
        }

    def _requireAdmin(self, request) -> dict | None:
        userId = request.get('user_id')
        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        user = self.db.fetch_one('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': userId})
        if not user or (user.get('role') or '') != 'admin':
            return {'success': False, 'error': 'Admin access required', 'status_code': 403}
        return None

    def _requireAffiliate(self, request) -> dict:
        """Returns the affiliate row for the authenticated user, or an error dict."""
        userId = request.get('user_id')
        if not userId:
            return {'error': True, 'success': False, 'message': 'Authentication required', 'status_code': 401}
        affiliate = self.repo.findAffiliateByUserId(php_intval(userId))
        if not affiliate:
            return {'error': True, 'success': False, 'message': 'Affiliate access required', 'status_code': 403}
        return affiliate

    def _notFound(self, what: str) -> dict:
        return {'success': False, 'error': f'{what} not found', 'status_code': 404}

    def _badRequest(self, msg: str) -> dict:
        return {'success': False, 'error': msg, 'status_code': 400}
