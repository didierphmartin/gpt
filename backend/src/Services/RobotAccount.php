<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/**
 * The one robot service user of an installation (it owns published playbooks and
 * runs unattended work) and its built-in `robot` role. Never signs in: no password.
 */
final class RobotAccount
{
    public const EMAIL = 'robot@synergyai.invalid';
    public const NAME = 'SynergyAI Operations';
    public const ROLE = 'robot';

    /** The robot's user id, creating its role row and the user when missing. */
    public static function ensure(PDO $db): int
    {
        $existing = self::id($db);
        if ($existing !== null) {
            return $existing;
        }
        self::ensureRole($db);
        [$first, $last] = explode(' ', self::NAME, 2);
        $db->prepare("INSERT INTO users (email, first_name, last_name, password, provider, role, kind, email_verified)
            VALUES (?, ?, ?, NULL, 'email', ?, 'service', 1)")
            ->execute([self::EMAIL, $first, $last, self::ROLE]);
        return (int) $db->lastInsertId();
    }

    /** The robot's user id, or null when it does not exist yet. */
    public static function id(PDO $db): ?int
    {
        $id = $db->query("SELECT id FROM users WHERE kind = 'service' ORDER BY id LIMIT 1")->fetchColumn();
        return $id === false ? null : (int) $id;
    }

    private static function ensureRole(PDO $db): void
    {
        $has = $db->prepare('SELECT 1 FROM packages WHERE role = ?');
        $has->execute([self::ROLE]);
        if ($has->fetchColumn() !== false) {
            return;
        }
        $caps = $db->prepare('SELECT capabilities FROM packages WHERE role = ?');
        $caps->execute(['user']);
        $copy = $caps->fetchColumn();
        $db->prepare('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 1, ?)')
            ->execute([self::ROLE, 'Robot', $copy === false ? '{}' : (string) $copy]);
    }
}
