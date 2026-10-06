<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/**
 * The roles of an installation: one `packages` row per role (key, display name,
 * capabilities). Built-in roles cannot be deleted; custom roles can while no person holds them.
 */
final class RoleStore
{
    public const BUILTIN = ['guest', 'prospect', 'user', 'admin', 'robot'];
    public const KEY_RE = '/^[a-z0-9]+(-[a-z0-9]+)*\z/';
    public const KEY_MAX = 64;
    public const NAME_MAX = 100;

    public function __construct(private readonly PDO $db)
    {
    }

    public static function isValidKey(string $key): bool
    {
        return strlen($key) <= self::KEY_MAX && preg_match(self::KEY_RE, $key) === 1;
    }

    /** @return array<int,array{role:string,name:string,builtin:bool,capabilities:array,used_by:int}> built-ins first */
    public function list(): array
    {
        $rows = $this->db->query('SELECT role, name, builtin, capabilities FROM packages')->fetchAll(PDO::FETCH_ASSOC);
        // A built-in role with no row yet (fresh install) is still a role, with no capabilities.
        $have = array_column($rows, 'role');
        foreach (self::BUILTIN as $key) {
            if (!in_array($key, $have, true)) {
                $rows[] = ['role' => $key, 'name' => null, 'builtin' => 1, 'capabilities' => '{}'];
            }
        }
        $out = array_map(fn(array $r) => $this->shape($r), $rows);
        usort($out, function (array $a, array $b): int {
            $ia = array_search($a['role'], self::BUILTIN, true);
            $ib = array_search($b['role'], self::BUILTIN, true);
            return match (true) {
                $ia !== false && $ib !== false => $ia <=> $ib,
                $ia !== false => -1,
                $ib !== false => 1,
                $a['builtin'] !== $b['builtin'] => $a['builtin'] ? -1 : 1,
                default => strcmp($a['name'], $b['name']) ?: strcmp($a['role'], $b['role']),
            };
        });
        return $out;
    }

    public function get(string $key): ?array
    {
        $stmt = $this->db->prepare('SELECT role, name, builtin, capabilities FROM packages WHERE role = ?');
        $stmt->execute([$key]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row && in_array($key, self::BUILTIN, true)) {
            $row = ['role' => $key, 'name' => null, 'builtin' => 1, 'capabilities' => '{}'];
        }
        return $row ? $this->shape($row) : null;
    }

    /** A role exists when it has a row, or is built-in (a fresh install has no rows yet). */
    public function exists(string $key): bool
    {
        return in_array($key, self::BUILTIN, true) || $this->hasRow($key);
    }

    private function hasRow(string $key): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM packages WHERE role = ?');
        $stmt->execute([$key]);
        return $stmt->fetchColumn() !== false;
    }

    public function create(string $key, string $name, ?string $copyFrom): array
    {
        if (!self::isValidKey($key)) {
            throw new RoleStoreError('invalid_key', 'Role key: lowercase letters and digits, words separated by single dashes, at most ' . self::KEY_MAX . ' characters', 422);
        }
        $name = $this->cleanName($name);
        if ($this->exists($key)) {
            throw new RoleStoreError('exists', "Role '$key' already exists", 409);
        }
        $caps = '{"providers":{},"sidebar":{}}';
        if ($copyFrom !== null && $copyFrom !== '') {
            $src = $this->get($copyFrom);
            if ($src === null) {
                throw new RoleStoreError('not_found', "Role '$copyFrom' not found", 404);
            }
            $caps = json_encode($src['capabilities'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        $this->db->prepare('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 0, ?)')
            ->execute([$key, $name, $caps]);
        return $this->get($key);
    }

    public function rename(string $key, string $name): array
    {
        $name = $this->cleanName($name);
        if (!$this->exists($key)) {
            throw new RoleStoreError('not_found', "Role '$key' not found", 404);
        }
        if ($this->hasRow($key)) {
            $this->db->prepare('UPDATE packages SET name = ? WHERE role = ?')->execute([$name, $key]);
        } else {
            $this->db->prepare('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 1, ?)')
                ->execute([$key, $name, '{}']);
        }
        return $this->get($key);
    }

    public function delete(string $key): void
    {
        $row = $this->get($key);
        if ($row === null) {
            throw new RoleStoreError('not_found', "Role '$key' not found", 404);
        }
        if ($row['builtin'] || in_array($key, self::BUILTIN, true)) {
            throw new RoleStoreError('builtin', "Built-in roles can't be deleted", 409);
        }
        $holders = $this->usersWith($key);
        if ($holders) {
            $emails = implode(', ', array_column($holders, 'email'));
            throw new RoleStoreError('in_use', "Role '$key' is held by: $emails", 409);
        }
        $this->db->prepare('DELETE FROM packages WHERE role = ?')->execute([$key]);
    }

    /** @return array<int,array{id:int,email:string}> the people (not the robot) holding the role */
    public function usersWith(string $key): array
    {
        $stmt = $this->db->prepare("SELECT id, email FROM users WHERE role = ? AND kind = 'person' ORDER BY id");
        $stmt->execute([$key]);
        return array_map(fn(array $r) => ['id' => (int) $r['id'], 'email' => (string) $r['email']], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function cleanName(string $name): string
    {
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > self::NAME_MAX) {
            throw new RoleStoreError('invalid_name', 'Role name is required (at most ' . self::NAME_MAX . ' characters)', 422);
        }
        return $name;
    }

    private function shape(array $r): array
    {
        $key = (string) $r['role'];
        $caps = json_decode((string) $r['capabilities'], true);
        $name = trim((string) ($r['name'] ?? ''));
        return [
            'role' => $key,
            'name' => $name !== '' ? $name : ucfirst($key),
            'builtin' => (bool) $r['builtin'] || in_array($key, self::BUILTIN, true),
            'capabilities' => is_array($caps) ? $caps : [],
            'used_by' => count($this->usersWith($key)),
        ];
    }
}
