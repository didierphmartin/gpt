<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\Services\AffiliateRepository;
use Quantis\AIPortfolioAssistant\Services\AffiliateCommission;
use Quantis\AIPortfolioAssistant\Services\AffiliateSupport;
use PDO;

/**
 * Affiliate management.
 *
 * Admin (existing admin JWT):      /api/v1/admin/affiliates*, /api/v1/admin/affiliate-products*
 * Affiliate self-scope (role=affiliate): /api/v1/affiliate/me, /api/v1/affiliate/me/transactions
 * Conversion (any authenticated caller / selling app): POST /api/v1/affiliate/conversions
 */
class AffiliateController
{
    private PDO $db;
    private array $config;
    private AffiliateRepository $repo;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->repo = new AffiliateRepository($db);
    }

    // ===== Admin: affiliates ==============================================

    public function adminList(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        return ['success' => true, 'affiliates' => $this->repo->listAffiliates()];
    }

    public function adminGet(array $request, int $id): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $affiliate = $this->repo->findAffiliate($id);
        if (!$affiliate) return $this->notFound('Affiliate');
        return [
            'success' => true,
            'affiliate' => $affiliate,
            'accounts' => $this->decorateAccounts($this->repo->accountsForAffiliate($id)),
        ];
    }

    public function adminCreate(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $body = $request['body'] ?? [];
        $name = trim($body['name'] ?? '');
        $email = trim($body['email'] ?? '');
        $password = (string) ($body['password'] ?? '');
        if ($name === '' || $email === '') {
            return $this->badRequest('name and email are required');
        }

        // Is this email already a registered user (client, prospect, affiliate…)?
        // Affiliate status lives in the `affiliates` table, independent of the
        // user's role — so an existing user just needs an affiliate row added,
        // not a brand-new account.
        $stmt = $this->db->prepare("SELECT id FROM users WHERE email = :email LIMIT 1");
        $stmt->execute([':email' => $email]);
        $existingUserId = $stmt->fetchColumn();
        $isExisting = $existingUserId !== false;

        if ($isExisting) {
            if ($this->repo->findAffiliateByUserId((int) $existingUserId)) {
                return $this->badRequest('This user is already an affiliate');
            }
        } elseif ($password === '') {
            // Only a brand-new person needs a login provisioned, so the
            // password is required only in that case.
            return $this->badRequest('password is required to register a new affiliate user');
        }

        // Provision the auth user only if new, then the affiliate row, atomically.
        $this->db->beginTransaction();
        try {
            if ($isExisting) {
                $userId = (int) $existingUserId;
            } else {
                $stmt = $this->db->prepare(
                    "INSERT INTO users (email, password, first_name, role, provider, created_at, updated_at)
                     VALUES (:email, :password, :name, 'affiliate', 'email', NOW(), NOW())"
                );
                $stmt->execute([
                    ':email' => $email,
                    ':password' => password_hash($password, PASSWORD_DEFAULT),
                    ':name' => $name,
                ]);
                $userId = (int) $this->db->lastInsertId();
            }

            do { $key = AffiliateSupport::generateKey(); } while ($this->repo->keyExists($key));
            $affiliateId = $this->repo->insertAffiliate($userId, $name, $email, $key);

            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            if (str_contains($e->getMessage(), 'Duplicate') || str_contains($e->getMessage(), '1062')) {
                return $this->badRequest('A user with that email already exists');
            }
            throw $e;
        }

        return [
            'success' => true,
            'affiliate_id' => $affiliateId,
            'affiliate_key' => $key,
            'existing_user' => $isExisting,
        ];
    }

    public function adminDelete(array $request, int $id): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $affiliate = $this->repo->findAffiliate($id);
        if (!$affiliate) return $this->notFound('Affiliate');
        $userId = (int) $affiliate['user_id'];

        // Always remove the affiliate row (cascades to its accounts + sales via
        // the affiliate-internal FKs). There is no FK from affiliates.user_id to
        // users (id types differ), so the user row is handled separately below.
        $delAffiliate = $this->db->prepare("DELETE FROM affiliates WHERE id = :id");
        $delAffiliate->execute([':id' => $id]);

        // Remove the auth login ONLY if the account exists solely for affiliate
        // use (role = 'affiliate'). A shared account that is also a client or
        // prospect keeps its login so we don't destroy their other access/data.
        $roleStmt = $this->db->prepare("SELECT role FROM users WHERE id = :uid LIMIT 1");
        $roleStmt->execute([':uid' => $userId]);
        if ($roleStmt->fetchColumn() === 'affiliate') {
            $delUser = $this->db->prepare("DELETE FROM users WHERE id = :uid");
            $delUser->execute([':uid' => $userId]);
        }
        return ['success' => true];
    }

    // ===== Admin: accounts ================================================

    public function adminAddAccount(array $request, int $id): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        if (!$this->repo->findAffiliate($id)) return $this->notFound('Affiliate');
        $body = $request['body'] ?? [];
        $productId = (int) ($body['product_id'] ?? 0);
        if (!$this->repo->findProduct($productId)) return $this->badRequest('Unknown product');
        if ($this->repo->findAccount($id, $productId)) return $this->badRequest('Account already exists');

        [$type, $value] = $this->readOptionalOverride($body);
        $this->repo->insertAccount($id, $productId, $type, $value);
        return ['success' => true];
    }

    public function adminUpdateAccount(array $request, int $id, int $productId): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        if (!$this->repo->findAffiliate($id)) return $this->notFound('Affiliate');
        if (!$this->repo->findAccount($id, $productId)) return $this->notFound('Account');

        // Empty/missing override clears it (account then inherits the product default).
        [$type, $value] = $this->readOptionalOverride($request['body'] ?? []);
        $this->repo->updateAccount($id, $productId, $type, $value);
        return ['success' => true];
    }

    public function adminDeleteAccount(array $request, int $id, int $productId): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $this->repo->deleteAccount($id, $productId);
        return ['success' => true];
    }

    // ===== Admin: transactions ============================================

    public function adminTransactions(array $request, int $id): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        if (!$this->repo->findAffiliate($id)) return $this->notFound('Affiliate');
        return $this->transactionsPayload($id);
    }

    public function adminMarkPaid(array $request, int $id, int $saleId): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $updated = $this->repo->markSalePaid($id, $saleId);
        return ['success' => true, 'updated' => $updated];
    }

    // ===== Admin: products ================================================

    public function adminListProducts(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        return ['success' => true, 'products' => $this->repo->listProducts()];
    }

    public function adminCreateProduct(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $p = $this->validateProduct($request['body'] ?? []);
        if (isset($p['error'])) return $p;
        $pid = $this->repo->insertProduct($p);
        return ['success' => true, 'product_id' => $pid];
    }

    public function adminUpdateProduct(array $request, int $id): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        if (!$this->repo->findProduct($id)) return $this->notFound('Product');
        $p = $this->validateProduct($request['body'] ?? []);
        if (isset($p['error'])) return $p;
        $this->repo->updateProduct($id, $p);
        return ['success' => true];
    }

    public function adminDeleteProduct(array $request, int $id): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $this->repo->deleteProduct($id);
        return ['success' => true];
    }

    // ===== Affiliate self-scope ===========================================

    public function me(array $request): array
    {
        $affiliate = $this->requireAffiliate($request);
        if (isset($affiliate['error'])) return $affiliate;
        return [
            'success' => true,
            'affiliate' => [
                'id' => $affiliate['id'], 'name' => $affiliate['name'],
                'email' => $affiliate['email'], 'affiliate_key' => $affiliate['affiliate_key'],
                'status' => $affiliate['status'],
            ],
            'accounts' => $this->decorateAccounts($this->repo->accountsForAffiliate((int) $affiliate['id'])),
        ];
    }

    public function myTransactions(array $request): array
    {
        $affiliate = $this->requireAffiliate($request);
        if (isset($affiliate['error'])) return $affiliate;
        return $this->transactionsPayload((int) $affiliate['id']);
    }

    // ===== Conversion (selling apps) ======================================

    public function recordConversion(array $request): array
    {
        if (!($request['user_id'] ?? null)) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $body = $request['body'] ?? [];
        $ref = trim((string) ($body['ref'] ?? ''));
        $productId = (int) ($body['product'] ?? 0);
        $amount = (float) ($body['amount'] ?? 0);
        $currency = strtoupper(trim((string) ($body['currency'] ?? 'USD'))) ?: 'USD';
        $externalRef = isset($body['external_ref']) ? trim((string) $body['external_ref']) : null;
        if ($externalRef === '') $externalRef = null;

        if ($ref === '' || $productId <= 0 || $amount <= 0) {
            return $this->badRequest('ref, product and a positive amount are required');
        }

        // Idempotency: if this external_ref was already recorded, return it.
        if ($externalRef !== null && ($existing = $this->repo->saleByExternalRef($externalRef))) {
            return ['success' => true, 'sale_id' => (int) $existing['id'], 'duplicate' => true];
        }

        $affiliate = $this->repo->findAffiliateByKey($ref);
        if (!$affiliate) return $this->badRequest('Unknown affiliate ref');
        $product = $this->repo->findProduct($productId);
        if (!$product) return $this->badRequest('Unknown product');
        $account = $this->repo->findAccount((int) $affiliate['id'], $productId);
        if (!$account) return $this->badRequest('Affiliate has no account on this product');

        [$type, $value] = AffiliateCommission::resolve($account, $product);
        $commission = AffiliateCommission::compute($type, $value, $amount);
        try {
            $saleId = $this->repo->insertSale((int) $affiliate['id'], $productId, $amount, $currency, $commission, $externalRef);
        } catch (\Throwable $e) {
            if ($externalRef !== null && (str_contains($e->getMessage(), 'Duplicate') || str_contains($e->getMessage(), '1062'))) {
                $existing = $this->repo->saleByExternalRef($externalRef);
                if ($existing) {
                    return ['success' => true, 'sale_id' => (int) $existing['id'], 'duplicate' => true];
                }
            }
            throw $e;
        }

        return ['success' => true, 'sale_id' => $saleId, 'commission_amount' => $commission];
    }

    // ===== Helpers ========================================================

    private function transactionsPayload(int $affiliateId): array
    {
        $rows = $this->repo->transactionsForAffiliate($affiliateId);
        $paid = 0.0; $owed = 0.0;
        foreach ($rows as $r) {
            if ($r['status'] === 'paid') $paid += (float) $r['commission_amount'];
            else $owed += (float) $r['commission_amount'];
        }
        return [
            'success' => true,
            'transactions' => $rows,
            'totals' => ['paid' => round($paid, 2), 'owed' => round($owed, 2), 'total' => round($paid + $owed, 2)],
        ];
    }

    /** Add effective commission + generated link to each account row. */
    private function decorateAccounts(array $accounts): array
    {
        foreach ($accounts as &$a) {
            [$type, $value] = AffiliateCommission::resolve(
                ['commission_type' => $a['override_type'], 'commission_value' => $a['override_value']],
                ['commission_type' => $a['product_type'], 'commission_value' => $a['product_value']]
            );
            $a['effective_type'] = $type;
            $a['effective_value'] = $value;
            $a['link'] = isset($a['affiliate_key'])
                ? AffiliateSupport::buildLink($a['sales_page_url'], $a['affiliate_key'])
                : null;
        }
        return $accounts;
    }

    private function readOptionalOverride(array $body): array
    {
        $type = $body['commission_type'] ?? null;
        $value = $body['commission_value'] ?? null;
        if ($type === '' || $type === null || $value === '' || $value === null) {
            return [null, null];
        }
        if (!in_array($type, ['percent', 'fixed'], true)) return [null, null];
        return [(string) $type, (float) $value];
    }

    private function validateProduct(array $body): array
    {
        $name = trim($body['name'] ?? '');
        $url = trim($body['sales_page_url'] ?? '');
        $type = $body['commission_type'] ?? 'percent';
        if ($name === '' || $url === '') return $this->badRequest('name and sales_page_url are required');
        if (!in_array($type, ['percent', 'fixed'], true)) return $this->badRequest('commission_type must be percent or fixed');
        return [
            'name' => $name,
            'app_ref' => trim($body['app_ref'] ?? '') ?: null,
            'sales_page_url' => $url,
            'commission_type' => $type,
            'commission_value' => (float) ($body['commission_value'] ?? 0),
            'currency' => strtoupper(trim($body['currency'] ?? 'USD')) ?: 'USD',
            'active' => !empty($body['active']) ? 1 : 0,
        ];
    }

    private function requireAdmin(array $request): ?array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId) return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        $stmt = $this->db->prepare('SELECT role FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || ($user['role'] ?? '') !== 'admin') {
            return ['success' => false, 'error' => 'Admin access required', 'status_code' => 403];
        }
        return null;
    }

    /** Returns the affiliate row for the authenticated user, or an error array. */
    private function requireAffiliate(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId) return ['error' => true, 'success' => false, 'message' => 'Authentication required', 'status_code' => 401];
        $affiliate = $this->repo->findAffiliateByUserId((int) $userId);
        if (!$affiliate) return ['error' => true, 'success' => false, 'message' => 'Affiliate access required', 'status_code' => 403];
        return $affiliate;
    }

    private function notFound(string $what): array
    {
        return ['success' => false, 'error' => "{$what} not found", 'status_code' => 404];
    }

    private function badRequest(string $msg): array
    {
        return ['success' => false, 'error' => $msg, 'status_code' => 400];
    }
}
