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
    private const KEY_RE = '/^[a-z0-9]+(-[a-z0-9]+)*\z/';
    private const KEY_MAX = 64;
    private const TITLE_MAX = 255;

    public function __construct(private readonly PDO $db) {}

    /** "Okta password reset" -> "okta-password-reset", "Ça va" -> "ca-va" (accents dropped; at most 64 characters;
     *  "playbook" when nothing is left). */
    public static function keyFromTitle(string $title): string
    {
        $nfd = \Normalizer::normalize($title, \Normalizer::FORM_D);
        $title = (string) preg_replace('/\p{M}+/u', '', $nfd === false ? $title : $nfd);
        $key = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($title)), '-');
        $key = rtrim(substr($key, 0, self::KEY_MAX), '-');
        return $key === '' ? 'playbook' : $key;
    }

    public static function isValidKey(string $key): bool
    {
        return strlen($key) <= self::KEY_MAX && preg_match(self::KEY_RE, $key) === 1;
    }

    /** $base when the user has no playbook with it, else $base-2, $base-3… (still at most 64 characters). */
    public function freeKey(int $userId, string $base): string
    {
        $key = $base;
        for ($i = 2; $this->getByKey($userId, $key) !== null; $i++) {
            $suffix = "-{$i}";
            $key = rtrim(substr($base, 0, self::KEY_MAX - strlen($suffix)), '-') . $suffix;
        }
        return $key;
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
        unset($r);
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
        if (mb_strlen($title) > self::TITLE_MAX) {
            throw new PlaybookStoreError('invalid_text', "The title is longer than 255 characters (" . mb_strlen($title) . "); shorten the \"Title:\" line.", 422);
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

    /**
     * Publish the user's playbook to the robot as a frozen copy (one version). The robot row with the same key is
     * updated in place when it came from this same playbook; from another (or a deleted) source it is refused
     * with `replaces` unless $confirmReplace.
     */
    public function publish(int $userId, int $id, int $robotId, bool $confirmReplace): array
    {
        $src = $this->get($userId, $id);
        if ($src === null) {
            throw new PlaybookStoreError('not_found', "Playbook #{$id} not found", 404);
        }
        $own = $this->db->prepare('SELECT id FROM playbooks WHERE user_id = ? AND source_id = ? ORDER BY id LIMIT 1');
        $own->execute([$robotId, $id]);
        $ownId = $own->fetchColumn();
        $ownId = $ownId === false ? null : (int) $ownId;
        $holder = $this->getByKey($robotId, $src['pkey']);
        if ($holder !== null && $holder['id'] === $ownId) {
            $holder = null; // the key is already ours
        }
        $targetId = $ownId;
        if ($holder !== null) {
            $held = $this->db->prepare('SELECT source_id, published_by, published_at FROM playbooks WHERE id = ?');
            $held->execute([$holder['id']]);
            $meta = $held->fetch(PDO::FETCH_ASSOC);
            $sameSource = $ownId === null && $meta['source_id'] !== null && (int) $meta['source_id'] === $id;
            if ($sameSource) {
                $targetId = $holder['id'];
            } elseif (!$confirmReplace) {
                throw new PlaybookStoreError('replaces',
                    "The robot already has \"{$src['pkey']}\", published by " . $this->personName($meta['published_by']) . '.',
                    409, ['published_by' => $this->personName($meta['published_by']), 'published_at' => $meta['published_at']]);
            } elseif ($ownId === null) {
                $targetId = $holder['id'];
            }
        }
        $outer = !$this->db->inTransaction();
        if ($outer) {
            $this->db->beginTransaction();
        }
        try {
            if ($holder !== null && $targetId === $ownId && $ownId !== null) {
                // our copy moves onto a key another copy holds: that copy goes
                $this->db->prepare('DELETE FROM playbooks WHERE id = ? AND user_id = ?')->execute([$holder['id'], $robotId]);
            }
            $row = $this->save($robotId, $targetId, $src['text'], $src['pkey']);
            $this->db->prepare('UPDATE playbooks SET published_by = ?, published_at = CURRENT_TIMESTAMP, source_id = ? WHERE id = ? AND user_id = ?')
                ->execute([$userId, $id, $row['id'], $robotId]);
            if ($outer) {
                $this->db->commit();
            }
        } catch (\Throwable $e) {
            if ($outer && $this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
        $st = $this->db->prepare('SELECT id, pkey, title, text, updated_at, published_by, published_at, source_id FROM playbooks WHERE id = ?');
        $st->execute([$row['id']]);
        $out = $st->fetch(PDO::FETCH_ASSOC);
        return ['id' => (int) $out['id']] + $out;
    }

    /** The robot's collection with who published each and the title of its source (null when the source is gone). */
    public function robotList(int $robotId): array
    {
        $st = $this->db->prepare('SELECT p.id, p.pkey, p.title, p.text, p.updated_at, p.published_by, p.published_at, p.source_id,
                s.title AS source_title
            FROM playbooks p LEFT JOIN playbooks s ON s.id = p.source_id WHERE p.user_id = ? ORDER BY p.title');
        $st->execute([$robotId]);
        $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) {
            $r['id'] = (int) $r['id'];
            $r['published_by_name'] = $r['published_by'] === null ? null : $this->personName($r['published_by']);
        }
        unset($r);
        return $rows;
    }

    public function unpublish(int $robotId, int $robotPlaybookId): void
    {
        if ($this->get($robotId, $robotPlaybookId) === null) {
            throw new PlaybookStoreError('not_found', "Playbook #{$robotPlaybookId} not found", 404);
        }
        $this->db->prepare('DELETE FROM playbooks WHERE id = ? AND user_id = ?')->execute([$robotPlaybookId, $robotId]);
    }

    /** source playbook id => 'published' (robot copy equals the source) | 'changed' (the source was edited since). */
    public function publishStatus(int $userId, int $robotId): array
    {
        $st = $this->db->prepare('SELECT s.id, s.text AS source_text, r.text AS robot_text
            FROM playbooks r JOIN playbooks s ON s.id = r.source_id AND s.user_id = ? WHERE r.user_id = ? ORDER BY r.id');
        $st->execute([$userId, $robotId]);
        $map = [];
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $map[(int) $r['id']] = $r['source_text'] === $r['robot_text'] ? 'published' : 'changed';
        }
        return $map;
    }

    /** First + last name, else the email; '' when the user is gone. */
    private function personName(mixed $userId): string
    {
        if ($userId === null) {
            return '';
        }
        $st = $this->db->prepare('SELECT email, first_name, last_name FROM users WHERE id = ?');
        $st->execute([$userId]);
        $u = $st->fetch(PDO::FETCH_ASSOC);
        if ($u === false) {
            return '';
        }
        $name = trim(trim((string) $u['first_name']) . ' ' . trim((string) $u['last_name']));
        return $name !== '' ? $name : (string) $u['email'];
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
