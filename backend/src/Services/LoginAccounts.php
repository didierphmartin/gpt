<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/**
 * The login service's users table, written directly by gpt on a corporate
 * install: gpt_admin creates every account, so gpt must create the login row
 * (the credential) alongside its own row (the role). Emails are lowercased.
 */
final class LoginAccounts
{
    public function __construct(private PDO $db)
    {
    }

    public static function fromConfig(array $config): ?self
    {
        $ld = $config['login_db'] ?? [];
        if (empty($ld['database']) || empty($ld['username'])) {
            return null;
        }
        $pdo = new PDO(
            sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $ld['host'] ?? '', $ld['database']),
            $ld['username'],
            $ld['password'] ?? '',
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5,
             PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
        return new self($pdo);
    }

    /**
     * Create the account, or — when a row already exists (a setup retried
     * after a partial failure) — overwrite its password and mark it verified.
     * gpt's sso_exchange refuses unverified accounts.
     */
    public function upsertVerified(string $email, string $passwordHash, string $firstName, string $lastName): void
    {
        $email = strtolower(trim($email));
        $stmt = $this->db->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ($stmt->fetchColumn() !== false) {
            $this->db->prepare('UPDATE users SET password = ?, first_name = ?, last_name = ?,
                email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ?')
                ->execute([$passwordHash, $firstName, $lastName, $email]);
            return;
        }
        $this->db->prepare("INSERT INTO users (email, password, first_name, last_name, provider,
            email_verified, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'email', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
            ->execute([$email, $passwordHash, $firstName, $lastName]);
    }

    public function setPassword(string $email, string $passwordHash): void
    {
        $this->db->prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?')
            ->execute([$passwordHash, strtolower(trim($email))]);
    }

    public function delete(string $email): void
    {
        $this->db->prepare('DELETE FROM users WHERE email = ?')->execute([strtolower(trim($email))]);
    }
}
