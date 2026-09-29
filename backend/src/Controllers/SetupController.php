<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Services\Edition;
use Quantis\AIPortfolioAssistant\Services\LoginAccounts;

/**
 * First-run setup of a corporate install: creates the administrator, once.
 *
 * Both endpoints are public — before setup there is nobody to authenticate.
 * createAdmin is safe to expose because it refuses as soon as any gpt user
 * exists (any role -- "no admin" is not enough, or removing the last admin
 * would reopen setup to anyone), and it re-checks under a MySQL named lock so
 * two simultaneous submissions cannot both pass the check.
 */
class SetupController
{
    private const MIN_PASSWORD = 10;

    private PDO $db;
    private array $config;
    private ?LoginAccounts $accounts;
    private bool $accountsInjected;

    public function __construct(PDO $db, array $config, ?LoginAccounts $accounts = null)
    {
        $this->db = $db;
        $this->config = $config;
        $this->accounts = $accounts;
        $this->accountsInjected = func_num_args() >= 3;
    }

    public function status(array $request): array
    {
        return [
            'success' => true,
            'edition' => Edition::current($this->config),
            'needs_setup' => $this->needsSetup(),
        ];
    }

    public function createAdmin(array $request): array
    {
        if (!Edition::isCorporate($this->config)) {
            return $this->fail('Setup is only available in the corporate edition', 404);
        }

        $body = $request['body'] ?? [];
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $password = (string) ($body['password'] ?? '');
        $firstName = trim((string) ($body['first_name'] ?? ''));
        $lastName = trim((string) ($body['last_name'] ?? ''));

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return $this->fail('Enter a valid email address', 400);
        }
        if (strlen($password) < self::MIN_PASSWORD) {
            return $this->fail('The password must be at least ' . self::MIN_PASSWORD . ' characters', 400);
        }

        try {
            $accounts = $this->accounts();
        } catch (\Throwable $e) {
            return $this->fail('The login service database is not reachable', 503);
        }
        if ($accounts === null) {
            return $this->fail('The login service is not configured', 503);
        }

        if (!$this->lock()) {
            return $this->fail('Setup is busy, please try again', 503);
        }
        try {
            if (!$this->needsSetup()) {
                return $this->fail('Setup is already complete', 409);
            }
            $accounts->upsertVerified($email, password_hash($password, PASSWORD_BCRYPT), $firstName, $lastName);
            $this->upsertGptAdmin($email, $firstName, $lastName);
        } catch (\Throwable $e) {
            error_log('[setup] createAdmin failed: ' . $e->getMessage());
            return $this->fail('Could not create the administrator account', 500);
        } finally {
            $this->unlock();
        }

        return [
            'success' => true,
            'message' => 'Administrator account created',
            'email' => $email,
            'status_code' => 201,
        ];
    }

    private function needsSetup(): bool
    {
        if (!Edition::isCorporate($this->config)) {
            return false;
        }
        return (int) $this->db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0;
    }

    private function accounts(): ?LoginAccounts
    {
        if (!$this->accountsInjected) {
            $this->accounts = LoginAccounts::fromConfig($this->config);
            $this->accountsInjected = true;
        }
        return $this->accounts;
    }

    /** gpt holds the role, never a password: the login service is the credential store. */
    private function upsertGptAdmin(string $email, string $firstName, string $lastName): void
    {
        $stmt = $this->db->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ($stmt->fetchColumn() !== false) {
            $this->db->prepare("UPDATE users SET role = 'admin', password = NULL, email_verified = 1,
                updated_at = CURRENT_TIMESTAMP WHERE email = ?")->execute([$email]);
            return;
        }
        $this->db->prepare("INSERT INTO users (email, password, first_name, last_name, role, plan, provider,
            email_verified, created_at, updated_at)
            VALUES (?, NULL, ?, ?, 'admin', 'free', 'email', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
            ->execute([$email, $firstName, $lastName]);
    }

    /** True when the lock is held. GET_LOCK returns 1 on success, 0 on timeout, NULL on error. */
    protected function lock(): bool
    {
        if ($this->db->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'mysql') {
            return true;
        }
        return (string) $this->db->query("SELECT GET_LOCK('gpt_corporate_setup', 10)")->fetchColumn() === '1';
    }

    protected function unlock(): void
    {
        if ($this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql') {
            $this->db->query("SELECT RELEASE_LOCK('gpt_corporate_setup')");
        }
    }

    private function fail(string $message, int $status): array
    {
        return ['success' => false, 'message' => $message, 'status_code' => $status];
    }
}
