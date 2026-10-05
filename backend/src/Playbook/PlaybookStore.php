<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

use PDO;

/**
 * The playbook collection: the only code that touches the `playbooks` table.
 * A playbook is its Console text, stored verbatim, plus a key unique per user;
 * the title is copied from the text on every save. Owner-scoped throughout.
 */
final class PlaybookStore
{
    private const KEY_RE = '/^[a-z0-9]+(-[a-z0-9]+)*$/';
    private const KEY_MAX = 64;

    public function __construct(private readonly PDO $db) {}

    /** "Okta password reset" -> "okta-password-reset" (at most 64 characters; "playbook" when nothing is left). */
    public static function keyFromTitle(string $title): string
    {
        $key = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($title)), '-');
        $key = rtrim(substr($key, 0, self::KEY_MAX), '-');
        return $key === '' ? 'playbook' : $key;
    }

    public static function isValidKey(string $key): bool
    {
        return strlen($key) <= self::KEY_MAX && preg_match(self::KEY_RE, $key) === 1;
    }

    public function list(int $userId): array
    {
        $st = $this->db->prepare('SELECT id, pkey, title, text, updated_at FROM playbooks WHERE user_id = ? ORDER BY title');
        $st->execute([$userId]);
        $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) {
            $r['id'] = (int) $r['id'];
            $used = $this->usedBy($userId, $r['id']);
            $r['used_by'] = count($used['agents']) + count($used['nodes']);
        }
        return $rows;
    }

    public function get(int $userId, int $id): ?array
    {
        $st = $this->db->prepare('SELECT id, pkey, title, text, updated_at FROM playbooks WHERE id = ? AND user_id = ?');
        $st->execute([$id, $userId]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : ['id' => (int) $row['id']] + $row;
    }

    public function getByKey(int $userId, string $pkey): ?array
    {
        $st = $this->db->prepare('SELECT id, pkey, title, text, updated_at FROM playbooks WHERE pkey = ? AND user_id = ?');
        $st->execute([$pkey, $userId]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : ['id' => (int) $row['id']] + $row;
    }

    /** Create ($id null) or update. The text must parse; the key defaults to the title's (create) or stays (update). */
    public function save(int $userId, ?int $id, string $text, ?string $pkey): array
    {
        try {
            $title = PlaybookDocument::fromConsoleText($text)->title;
        } catch (\InvalidArgumentException $e) {
            throw new PlaybookStoreError('invalid_text', $e->getMessage(), 422);
        }
        $current = $id === null ? null : $this->get($userId, $id);
        if ($id !== null && $current === null) {
            throw new PlaybookStoreError('not_found', "Playbook #{$id} not found", 404);
        }
        $key = $pkey ?? ($current['pkey'] ?? self::keyFromTitle($title));
        if (!self::isValidKey($key)) {
            throw new PlaybookStoreError('invalid_key',
                "Key \"{$key}\": lowercase letters, digits and single dashes, at most 64 characters (e.g. okta-reset).", 422);
        }
        $clash = $this->getByKey($userId, $key);
        if ($clash !== null && $clash['id'] !== $id) {
            throw new PlaybookStoreError('key_taken', "Key \"{$key}\" is already used by \"{$clash['title']}\".", 409);
        }
        if ($id === null) {
            $st = $this->db->prepare('INSERT INTO playbooks (user_id, pkey, title, text, created_at, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)');
            $st->execute([$userId, $key, $title, $text]);
            $id = (int) $this->db->lastInsertId();
        } else {
            $st = $this->db->prepare('UPDATE playbooks SET pkey = ?, title = ?, text = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ?');
            $st->execute([$key, $title, $text, $id, $userId]);
        }
        return $this->get($userId, $id);
    }

    public function delete(int $userId, int $id): void
    {
        if ($this->get($userId, $id) === null) {
            throw new PlaybookStoreError('not_found', "Playbook #{$id} not found", 404);
        }
        $used = $this->usedBy($userId, $id);
        $names = array_merge(
            array_map(fn($a) => "agent \"{$a['name']}\"", $used['agents']),
            array_map(fn($n) => "node \"{$n['node_name']}\" in workflow \"{$n['workflow_name']}\"", $used['nodes'])
        );
        if ($names !== []) {
            throw new PlaybookStoreError('in_use', 'This playbook is used by ' . implode(', ', $names) . '.', 409);
        }
        $this->db->prepare('DELETE FROM playbooks WHERE id = ? AND user_id = ?')->execute([$id, $userId]);
    }

    /** The agents and workflow nodes (the user's own) that link to the playbook. */
    public function usedBy(int $userId, int $id): array
    {
        $st = $this->db->prepare("SELECT id, name FROM agents WHERE user_id = ? AND playbook_id = ? ORDER BY name");
        $st->execute([$userId, $id]);
        $agents = array_map(fn($a) => ['id' => (int) $a['id'], 'name' => (string) $a['name']], $st->fetchAll(PDO::FETCH_ASSOC));

        // The node's link lives in its config JSON: decoded here, so the query stays portable (MySQL and SQLite).
        $st = $this->db->prepare("SELECT n.config, w.id AS workflow_id, w.name AS workflow_name
            FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id
            WHERE w.user_id = ? AND n.node_type = 'playbook' ORDER BY w.name, n.id");
        $st->execute([(string) $userId]);
        $nodes = [];
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $cfg = json_decode((string) $r['config'], true);
            if (is_array($cfg) && (int) ($cfg['playbook_id'] ?? 0) === $id) {
                $nodes[] = ['workflow_id' => (int) $r['workflow_id'], 'workflow_name' => (string) $r['workflow_name'],
                    'node_name' => (string) ($cfg['name'] ?? 'Playbook')];
            }
        }
        return ['agents' => $agents, 'nodes' => $nodes];
    }
}
