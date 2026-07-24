<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/**
 * All affiliate-related data access + earnings aggregation. Controllers call
 * this; it never decides HTTP status. Commission math lives in
 * AffiliateCommission; link/key helpers in AffiliateSupport.
 */
class AffiliateRepository
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    // ---- Affiliates -------------------------------------------------------

    /** List affiliates with total earned + owed (pending). */
    public function listAffiliates(): array
    {
        $sql = "
            SELECT a.id, a.user_id, a.name, a.email, a.affiliate_key, a.status, a.created_at,
                   COALESCE(SUM(s.commission_amount), 0) AS total_earned,
                   COALESCE(SUM(CASE WHEN s.status='pending' THEN s.commission_amount ELSE 0 END), 0) AS owed,
                   COUNT(DISTINCT acc.id) AS product_count
            FROM affiliates a
            LEFT JOIN affiliate_sales s    ON s.affiliate_id = a.id
            LEFT JOIN affiliate_accounts acc ON acc.affiliate_id = a.id
            GROUP BY a.id
            ORDER BY a.created_at DESC";
        return $this->db->query($sql)->fetchAll(PDO::FETCH_ASSOC);
    }

    public function findAffiliate(int $id): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM affiliates WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findAffiliateByUserId(int $userId): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM affiliates WHERE user_id = :uid LIMIT 1");
        $stmt->execute([':uid' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findAffiliateByKey(string $key): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM affiliates WHERE affiliate_key = :k LIMIT 1");
        $stmt->execute([':k' => $key]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function keyExists(string $key): bool
    {
        $stmt = $this->db->prepare("SELECT 1 FROM affiliates WHERE affiliate_key = :k LIMIT 1");
        $stmt->execute([':k' => $key]);
        return (bool) $stmt->fetchColumn();
    }

    /** Insert an affiliate row. Returns new id. */
    public function insertAffiliate(int $userId, string $name, string $email, string $key): int
    {
        $stmt = $this->db->prepare(
            "INSERT INTO affiliates (user_id, name, email, affiliate_key)
             VALUES (:uid, :name, :email, :key)"
        );
        $stmt->execute([':uid' => $userId, ':name' => $name, ':email' => $email, ':key' => $key]);
        return (int) $this->db->lastInsertId();
    }

    // ---- Products ---------------------------------------------------------

    public function listProducts(): array
    {
        return $this->db->query("SELECT * FROM affiliate_products ORDER BY name ASC")
            ->fetchAll(PDO::FETCH_ASSOC);
    }

    public function findProduct(int $id): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM affiliate_products WHERE id = :id LIMIT 1");
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function insertProduct(array $p): int
    {
        $stmt = $this->db->prepare(
            "INSERT INTO affiliate_products (name, app_ref, sales_page_url, commission_type, commission_value, currency, active)
             VALUES (:name, :app_ref, :url, :ctype, :cval, :cur, :active)"
        );
        $stmt->execute([
            ':name' => $p['name'], ':app_ref' => $p['app_ref'], ':url' => $p['sales_page_url'],
            ':ctype' => $p['commission_type'], ':cval' => $p['commission_value'],
            ':cur' => $p['currency'], ':active' => $p['active'],
        ]);
        return (int) $this->db->lastInsertId();
    }

    public function updateProduct(int $id, array $p): void
    {
        $stmt = $this->db->prepare(
            "UPDATE affiliate_products
             SET name=:name, app_ref=:app_ref, sales_page_url=:url, commission_type=:ctype,
                 commission_value=:cval, currency=:cur, active=:active
             WHERE id=:id"
        );
        $stmt->execute([
            ':id' => $id, ':name' => $p['name'], ':app_ref' => $p['app_ref'], ':url' => $p['sales_page_url'],
            ':ctype' => $p['commission_type'], ':cval' => $p['commission_value'],
            ':cur' => $p['currency'], ':active' => $p['active'],
        ]);
    }

    public function deleteProduct(int $id): int
    {
        $stmt = $this->db->prepare("DELETE FROM affiliate_products WHERE id = :id");
        $stmt->execute([':id' => $id]);
        return $stmt->rowCount();
    }

    // ---- Accounts ---------------------------------------------------------

    /** Product accounts for an affiliate, joined to product + per-product earnings. */
    public function accountsForAffiliate(int $affiliateId): array
    {
        $sql = "
            SELECT acc.id AS account_id, acc.affiliate_id, acc.product_id,
                   acc.commission_type AS override_type, acc.commission_value AS override_value,
                   p.name AS product_name, p.sales_page_url, p.currency,
                   p.commission_type AS product_type, p.commission_value AS product_value,
                   af.affiliate_key,
                   COALESCE(SUM(s.commission_amount), 0) AS earnings,
                   COALESCE(SUM(CASE WHEN s.status='pending' THEN s.commission_amount ELSE 0 END), 0) AS owed
            FROM affiliate_accounts acc
            JOIN affiliate_products p ON p.id = acc.product_id
            JOIN affiliates af ON af.id = acc.affiliate_id
            LEFT JOIN affiliate_sales s
                   ON s.affiliate_id = acc.affiliate_id AND s.product_id = acc.product_id
            WHERE acc.affiliate_id = :aid
            GROUP BY acc.id
            ORDER BY p.name ASC";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':aid' => $affiliateId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public function findAccount(int $affiliateId, int $productId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM affiliate_accounts WHERE affiliate_id = :a AND product_id = :p LIMIT 1"
        );
        $stmt->execute([':a' => $affiliateId, ':p' => $productId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function insertAccount(int $affiliateId, int $productId, ?string $type, ?float $value): int
    {
        $stmt = $this->db->prepare(
            "INSERT INTO affiliate_accounts (affiliate_id, product_id, commission_type, commission_value)
             VALUES (:a, :p, :t, :v)"
        );
        $stmt->execute([':a' => $affiliateId, ':p' => $productId, ':t' => $type, ':v' => $value]);
        return (int) $this->db->lastInsertId();
    }

    public function deleteAccount(int $affiliateId, int $productId): int
    {
        $stmt = $this->db->prepare(
            "DELETE FROM affiliate_accounts WHERE affiliate_id = :a AND product_id = :p"
        );
        $stmt->execute([':a' => $affiliateId, ':p' => $productId]);
        return $stmt->rowCount();
    }

    /** Set (or clear, with null/null) the per-account commission override. */
    public function updateAccount(int $affiliateId, int $productId, ?string $type, ?float $value): int
    {
        $stmt = $this->db->prepare(
            "UPDATE affiliate_accounts SET commission_type = :t, commission_value = :v
             WHERE affiliate_id = :a AND product_id = :p"
        );
        $stmt->execute([':a' => $affiliateId, ':p' => $productId, ':t' => $type, ':v' => $value]);
        return $stmt->rowCount();
    }

    // ---- Sales ------------------------------------------------------------

    public function transactionsForAffiliate(int $affiliateId): array
    {
        $sql = "
            SELECT s.id, s.product_id, p.name AS product_name, s.sale_amount, s.currency,
                   s.commission_amount, s.status, s.external_ref, s.occurred_at, s.paid_at
            FROM affiliate_sales s
            JOIN affiliate_products p ON p.id = s.product_id
            WHERE s.affiliate_id = :aid
            ORDER BY s.occurred_at DESC";
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':aid' => $affiliateId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public function insertSale(int $affiliateId, int $productId, float $sale, string $currency, float $commission, ?string $externalRef): int
    {
        $stmt = $this->db->prepare(
            "INSERT INTO affiliate_sales (affiliate_id, product_id, sale_amount, currency, commission_amount, external_ref)
             VALUES (:a, :p, :sale, :cur, :comm, :ext)"
        );
        $stmt->execute([
            ':a' => $affiliateId, ':p' => $productId, ':sale' => $sale,
            ':cur' => $currency, ':comm' => $commission, ':ext' => $externalRef,
        ]);
        return (int) $this->db->lastInsertId();
    }

    public function saleByExternalRef(string $ref): ?array
    {
        $stmt = $this->db->prepare("SELECT * FROM affiliate_sales WHERE external_ref = :r LIMIT 1");
        $stmt->execute([':r' => $ref]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function markSalePaid(int $affiliateId, int $saleId): int
    {
        $stmt = $this->db->prepare(
            "UPDATE affiliate_sales SET status='paid', paid_at=NOW()
             WHERE id = :id AND affiliate_id = :aid AND status='pending'"
        );
        $stmt->execute([':id' => $saleId, ':aid' => $affiliateId]);
        return $stmt->rowCount();
    }
}
