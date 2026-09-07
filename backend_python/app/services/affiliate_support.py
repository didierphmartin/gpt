"""Port of Services/AffiliateCommission.php, Services/AffiliateSupport.php and
Services/AffiliateRepository.php.

Extracted from app/controllers/affiliate_controller.py (Phase 7 final-review
wave, B6) — previously ported there as the module-private `_AffiliateCommission`
/ `_AffiliateSupport` / `_AffiliateRepository` classes, with a note that no
`app/services/*` package existed yet for these in that task's file-staging
guard. `affiliate_controller.py` re-imports all three under their old
module-private names so existing call sites and tests keep working unchanged.
"""
from __future__ import annotations

import secrets
from urllib.parse import quote

from app.support.phpcompat import php_floatval, php_strval, php_trim


class AffiliateCommission:
    """Port of Services/AffiliateCommission.php. Pure commission math — no DB access."""

    @staticmethod
    def compute(type_: str, value: float, sale: float) -> float:
        """Compute the commission for a single sale. `type_` is 'percent' or
        'fixed'; `value` is a percent (e.g. 20.0) or fixed amount; `sale` is the
        amount the prospect paid. Returns the commission rounded to 2 decimals,
        never negative."""
        if sale < 0:
            sale = 0.0
        if type_ == 'percent':
            return round(sale * value / 100, 2)
        if type_ == 'fixed':
            return round(max(0.0, value), 2)
        raise ValueError(f'Unknown commission type: {type_}')

    @staticmethod
    def resolve(account: dict, product: dict) -> tuple[str, float]:
        """Resolve the effective (type, value): account override wins when both
        of its fields are non-null, otherwise the product default is used."""
        type_ = account.get('commission_type')
        value = account.get('commission_value')
        if type_ is not None and value is not None:
            return php_strval(type_), php_floatval(value)
        return php_strval(product['commission_type']), php_floatval(product['commission_value'])


class AffiliateSupport:
    """Port of Services/AffiliateSupport.php. Pure helpers for affiliate keys
    and link construction — no DB access."""

    KEY_LENGTH = 16
    ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

    @staticmethod
    def generateKey() -> str:
        """Generate a URL-safe random affiliate key (CSPRNG, mirrors PHP's
        random_int). Uniqueness vs. the DB is the caller's job."""
        alphabet = AffiliateSupport.ALPHABET
        return ''.join(alphabet[secrets.randbelow(len(alphabet))] for _ in range(AffiliateSupport.KEY_LENGTH))

    @staticmethod
    def buildLink(salesPageUrl: str, key: str) -> str:
        """Append ?ref=KEY (or &ref=KEY) to a sales-page URL."""
        url = php_trim(salesPageUrl)
        sep = '&' if '?' in url else '?'
        return url + sep + 'ref=' + quote(key, safe='')


class AffiliateRepository:
    """Port of Services/AffiliateRepository.php. All affiliate-related data
    access + earnings aggregation. Controllers call this; it never decides
    HTTP status."""

    def __init__(self, db):
        self.db = db

    # ---- Affiliates -------------------------------------------------------

    def listAffiliates(self) -> list:
        """List affiliates with total earned + owed (pending)."""
        sql = (
            "\n            SELECT a.id, a.user_id, a.name, a.email, a.affiliate_key, a.status, a.created_at,\n"
            "                   COALESCE(SUM(s.commission_amount), 0) AS total_earned,\n"
            "                   COALESCE(SUM(CASE WHEN s.status='pending' THEN s.commission_amount ELSE 0 END), 0) AS owed,\n"
            "                   COUNT(DISTINCT acc.id) AS product_count\n"
            "            FROM affiliates a\n"
            "            LEFT JOIN affiliate_sales s    ON s.affiliate_id = a.id\n"
            "            LEFT JOIN affiliate_accounts acc ON acc.affiliate_id = a.id\n"
            "            GROUP BY a.id\n"
            "            ORDER BY a.created_at DESC"
        )
        return self.db.fetch_all(sql)

    def findAffiliate(self, id_: int) -> dict | None:
        return self.db.fetch_one('SELECT * FROM affiliates WHERE id = :id LIMIT 1', {':id': id_})

    def findAffiliateByUserId(self, userId: int) -> dict | None:
        return self.db.fetch_one('SELECT * FROM affiliates WHERE user_id = :uid LIMIT 1', {':uid': userId})

    def findAffiliateByKey(self, key: str) -> dict | None:
        return self.db.fetch_one('SELECT * FROM affiliates WHERE affiliate_key = :k LIMIT 1', {':k': key})

    def keyExists(self, key: str) -> bool:
        row = self.db.fetch_one('SELECT 1 FROM affiliates WHERE affiliate_key = :k LIMIT 1', {':k': key})
        return bool(row)

    def insertAffiliate(self, userId: int, name: str, email: str, key: str) -> int:
        """Insert an affiliate row. Returns new id."""
        return self.db.insert(
            'INSERT INTO affiliates (user_id, name, email, affiliate_key)\n'
            '             VALUES (:uid, :name, :email, :key)',
            {':uid': userId, ':name': name, ':email': email, ':key': key},
        )

    # ---- Products -----------------------------------------------------------

    def listProducts(self) -> list:
        return self.db.fetch_all('SELECT * FROM affiliate_products ORDER BY name ASC')

    def findProduct(self, id_: int) -> dict | None:
        return self.db.fetch_one('SELECT * FROM affiliate_products WHERE id = :id LIMIT 1', {':id': id_})

    def insertProduct(self, p: dict) -> int:
        return self.db.insert(
            'INSERT INTO affiliate_products (name, app_ref, sales_page_url, commission_type, commission_value, currency, active)\n'
            '             VALUES (:name, :app_ref, :url, :ctype, :cval, :cur, :active)',
            {':name': p['name'], ':app_ref': p['app_ref'], ':url': p['sales_page_url'],
             ':ctype': p['commission_type'], ':cval': p['commission_value'],
             ':cur': p['currency'], ':active': p['active']},
        )

    def updateProduct(self, id_: int, p: dict) -> None:
        self.db.execute(
            'UPDATE affiliate_products\n'
            '             SET name=:name, app_ref=:app_ref, sales_page_url=:url, commission_type=:ctype,\n'
            '                 commission_value=:cval, currency=:cur, active=:active\n'
            '             WHERE id=:id',
            {':id': id_, ':name': p['name'], ':app_ref': p['app_ref'], ':url': p['sales_page_url'],
             ':ctype': p['commission_type'], ':cval': p['commission_value'],
             ':cur': p['currency'], ':active': p['active']},
        )

    def deleteProduct(self, id_: int) -> int:
        return self.db.execute('DELETE FROM affiliate_products WHERE id = :id', {':id': id_})

    # ---- Accounts -----------------------------------------------------------

    def accountsForAffiliate(self, affiliateId: int) -> list:
        """Product accounts for an affiliate, joined to product + per-product earnings."""
        sql = (
            "\n            SELECT acc.id AS account_id, acc.affiliate_id, acc.product_id,\n"
            "                   acc.commission_type AS override_type, acc.commission_value AS override_value,\n"
            "                   p.name AS product_name, p.sales_page_url, p.currency,\n"
            "                   p.commission_type AS product_type, p.commission_value AS product_value,\n"
            "                   af.affiliate_key,\n"
            "                   COALESCE(SUM(s.commission_amount), 0) AS earnings,\n"
            "                   COALESCE(SUM(CASE WHEN s.status='pending' THEN s.commission_amount ELSE 0 END), 0) AS owed\n"
            "            FROM affiliate_accounts acc\n"
            "            JOIN affiliate_products p ON p.id = acc.product_id\n"
            "            JOIN affiliates af ON af.id = acc.affiliate_id\n"
            "            LEFT JOIN affiliate_sales s\n"
            "                   ON s.affiliate_id = acc.affiliate_id AND s.product_id = acc.product_id\n"
            "            WHERE acc.affiliate_id = :aid\n"
            "            GROUP BY acc.id\n"
            "            ORDER BY p.name ASC"
        )
        return self.db.fetch_all(sql, {':aid': affiliateId})

    def findAccount(self, affiliateId: int, productId: int) -> dict | None:
        return self.db.fetch_one(
            'SELECT * FROM affiliate_accounts WHERE affiliate_id = :a AND product_id = :p LIMIT 1',
            {':a': affiliateId, ':p': productId},
        )

    def insertAccount(self, affiliateId: int, productId: int, type_: str | None, value: float | None) -> int:
        return self.db.insert(
            'INSERT INTO affiliate_accounts (affiliate_id, product_id, commission_type, commission_value)\n'
            '             VALUES (:a, :p, :t, :v)',
            {':a': affiliateId, ':p': productId, ':t': type_, ':v': value},
        )

    def deleteAccount(self, affiliateId: int, productId: int) -> int:
        return self.db.execute(
            'DELETE FROM affiliate_accounts WHERE affiliate_id = :a AND product_id = :p',
            {':a': affiliateId, ':p': productId},
        )

    def updateAccount(self, affiliateId: int, productId: int, type_: str | None, value: float | None) -> int:
        """Set (or clear, with None/None) the per-account commission override."""
        return self.db.execute(
            'UPDATE affiliate_accounts SET commission_type = :t, commission_value = :v\n'
            '             WHERE affiliate_id = :a AND product_id = :p',
            {':a': affiliateId, ':p': productId, ':t': type_, ':v': value},
        )

    # ---- Sales ----------------------------------------------------------------

    def transactionsForAffiliate(self, affiliateId: int) -> list:
        sql = (
            "\n            SELECT s.id, s.product_id, p.name AS product_name, s.sale_amount, s.currency,\n"
            "                   s.commission_amount, s.status, s.external_ref, s.occurred_at, s.paid_at\n"
            "            FROM affiliate_sales s\n"
            "            JOIN affiliate_products p ON p.id = s.product_id\n"
            "            WHERE s.affiliate_id = :aid\n"
            "            ORDER BY s.occurred_at DESC"
        )
        return self.db.fetch_all(sql, {':aid': affiliateId})

    def insertSale(self, affiliateId: int, productId: int, sale: float, currency: str,
                    commission: float, externalRef: str | None) -> int:
        return self.db.insert(
            'INSERT INTO affiliate_sales (affiliate_id, product_id, sale_amount, currency, commission_amount, external_ref)\n'
            '             VALUES (:a, :p, :sale, :cur, :comm, :ext)',
            {':a': affiliateId, ':p': productId, ':sale': sale, ':cur': currency,
             ':comm': commission, ':ext': externalRef},
        )

    def saleByExternalRef(self, ref: str) -> dict | None:
        return self.db.fetch_one('SELECT * FROM affiliate_sales WHERE external_ref = :r LIMIT 1', {':r': ref})

    def markSalePaid(self, affiliateId: int, saleId: int) -> int:
        return self.db.execute(
            "UPDATE affiliate_sales SET status='paid', paid_at=NOW()\n"
            "             WHERE id = :id AND affiliate_id = :aid AND status='pending'",
            {':id': saleId, ':aid': affiliateId},
        )
