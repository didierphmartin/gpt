<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * App Key Repository
 *
 * CRUD + verification for `app_keys` — long-lived, scoped credentials that
 * let client code call the backend without a user's login JWT.
 *
 * Storage model (see app_keys table):
 *   - key_prefix : first 12 chars of the key ("ak_xxxxxxxx"). Indexed, not
 *                  secret. Used for an O(log N) lookup.
 *   - key_hash   : hex HMAC-SHA256(server_secret, full_key). A DB leak does
 *                  not expose usable keys.
 *
 * The full key value is returned exactly once — by create() — and is never
 * recoverable afterwards.
 */
class AppKeyRepository
{
    private const KEY_BYTES   = 16;   // 16 random bytes -> 32 hex chars
    private const PREFIX_LEN  = 12;   // "ak_" + 9 hex chars

    private PDO $db;
    private string $serverSecret;

    public function __construct(PDO $db, string $serverSecret)
    {
        if ($serverSecret === '') {
            // Fail loud: an empty pepper would make every hash trivially
            // forgeable by anyone who reads the table.
            throw new \RuntimeException('AppKeyRepository: app_key_secret is not configured.');
        }
        $this->db = $db;
        $this->serverSecret = $serverSecret;
    }

    /**
     * Mint a new app key.
     *
     * @param int    $userId        The user the key operates on behalf of.
     * @param string $applicationId Free identifier for the owning application.
     * @param string $name          Human label for this key.
     * @param array  $scopes        Non-empty list of scope strings.
     * @return array  Row data PLUS `full_key` — the only time the raw key is visible.
     */
    public function create(int $userId, string $applicationId, string $name, array $scopes): array
    {
        $fullKey = 'ak_' . bin2hex(random_bytes(self::KEY_BYTES));
        $prefix  = substr($fullKey, 0, self::PREFIX_LEN);
        $hash    = $this->hash($fullKey);

        $stmt = $this->db->prepare(
            "INSERT INTO app_keys (user_id, application_id, name, key_prefix, key_hash, scopes)
             VALUES (:user_id, :application_id, :name, :key_prefix, :key_hash, :scopes)"
        );
        $stmt->execute([
            ':user_id'        => $userId,
            ':application_id' => $applicationId,
            ':name'           => $name,
            ':key_prefix'     => $prefix,
            ':key_hash'       => $hash,
            ':scopes'         => json_encode(array_values($scopes)),
        ]);
        $id = (int) $this->db->lastInsertId();

        return [
            'id'             => $id,
            'user_id'        => $userId,
            'application_id' => $applicationId,
            'name'           => $name,
            'key_prefix'     => $prefix,
            'scopes'         => array_values($scopes),
            'full_key'       => $fullKey,
            'created_at'     => date('Y-m-d H:i:s'),
        ];
    }

    /**
     * Verify a presented key. Returns the key row (no hash) or null.
     *
     * Flow: prefix lookup → constant-time hash compare → not-revoked check.
     */
    public function findByKey(string $fullKey): ?array
    {
        $fullKey = trim($fullKey);
        if (!str_starts_with($fullKey, 'ak_') || strlen($fullKey) < self::PREFIX_LEN) {
            return null;
        }
        $prefix = substr($fullKey, 0, self::PREFIX_LEN);

        $stmt = $this->db->prepare(
            "SELECT id, user_id, application_id, name, key_prefix, key_hash, scopes,
                    created_at, last_used_at, revoked_at
             FROM app_keys
             WHERE key_prefix = :prefix AND revoked_at IS NULL
             LIMIT 1"
        );
        $stmt->execute([':prefix' => $prefix]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        if (!hash_equals((string) $row['key_hash'], $this->hash($fullKey))) {
            return null;
        }

        unset($row['key_hash']);
        $row['scopes'] = $this->decodeScopes($row['scopes']);
        $row['id'] = (int) $row['id'];
        $row['user_id'] = (int) $row['user_id'];
        return $row;
    }

    /**
     * Stamp last_used_at. Fire-and-forget — a failure here must never block
     * the request that the key just authorized.
     */
    public function recordUse(int $keyId): void
    {
        try {
            $stmt = $this->db->prepare("UPDATE app_keys SET last_used_at = NOW() WHERE id = ?");
            $stmt->execute([$keyId]);
        } catch (\Throwable $e) {
            error_log('[AppKeyRepository] recordUse failed: ' . $e->getMessage());
        }
    }

    /**
     * Soft-delete a key (sets revoked_at). Returns true if a row was changed.
     * Admin-only at the controller layer, so no ownership filter here.
     */
    public function revoke(int $keyId): bool
    {
        $stmt = $this->db->prepare(
            "UPDATE app_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL"
        );
        $stmt->execute([$keyId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * List keys (admin view). Optional filters. Never returns key_hash.
     */
    public function listAll(?string $applicationId = null, ?int $userId = null): array
    {
        $sql = "SELECT id, user_id, application_id, name, key_prefix, scopes,
                       created_at, last_used_at, revoked_at
                FROM app_keys WHERE 1=1";
        $params = [];
        if ($applicationId !== null) {
            $sql .= " AND application_id = :application_id";
            $params[':application_id'] = $applicationId;
        }
        if ($userId !== null) {
            $sql .= " AND user_id = :user_id";
            $params[':user_id'] = $userId;
        }
        $sql .= " ORDER BY created_at DESC";

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            $row['user_id'] = (int) $row['user_id'];
            $row['scopes'] = $this->decodeScopes($row['scopes']);
        }
        return $rows;
    }

    /**
     * Fetch one key's metadata by id (no hash). Used by revoke's 404 check.
     */
    public function findById(int $keyId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT id, user_id, application_id, name, key_prefix, scopes,
                    created_at, last_used_at, revoked_at
             FROM app_keys WHERE id = ? LIMIT 1"
        );
        $stmt->execute([$keyId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $row['id'] = (int) $row['id'];
        $row['user_id'] = (int) $row['user_id'];
        $row['scopes'] = $this->decodeScopes($row['scopes']);
        return $row;
    }

    private function hash(string $fullKey): string
    {
        return hash_hmac('sha256', $fullKey, $this->serverSecret);
    }

    private function decodeScopes($raw): array
    {
        if (is_array($raw)) {
            return $raw;
        }
        $decoded = json_decode((string) $raw, true);
        return is_array($decoded) ? $decoded : [];
    }
}
