<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Automation;

use PDO;

/**
 * The automation record: the only code that touches `automations` / `automation_instances`. Owner-scoped throughout.
 * An instance's environment is not a column (the connector profile is its only source); the last check keeps what the
 * connector reported inside `detail` as JSON {"environment": ..., "text": ...} for display.
 */
final class AutomationStore
{
    public const KEY_RE = '/^[a-z0-9][a-z0-9-]{1,40}$/';
    private const COLS = 'id, automation_key, title, version, spec_json, playbook_id, workflow_id, sn_scope, updated_at';

    public function __construct(private readonly PDO $db) {}

    /** Creates version 1, or bumps the owner's existing key (same id) and stores the new title + spec. */
    public function save(int $userId, string $key, string $title, array $spec): array
    {
        if (!preg_match(self::KEY_RE, $key)) {
            throw new AutomationError('key must match ^[a-z0-9][a-z0-9-]{1,40}$');
        }
        $title = trim($title);
        if ($title === '' || mb_strlen($title) > 255) {
            throw new AutomationError('title is required (max 255 characters)');
        }
        if ($spec === []) {
            throw new AutomationError('spec must be a non-empty object');
        }
        $json = json_encode($spec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $now = gmdate('Y-m-d H:i:s');
        $st = $this->db->prepare('SELECT id FROM automations WHERE user_id = ? AND automation_key = ?');
        $st->execute([$userId, $key]);
        $id = $st->fetchColumn();
        if ($id !== false) {
            $this->db->prepare('UPDATE automations SET version = version + 1, title = ?, spec_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                ->execute([$title, $json, $now, $id, $userId]);
        } else {
            $this->db->prepare('INSERT INTO automations (user_id, automation_key, title, version, spec_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
                ->execute([$userId, $key, $title, $json, $now, $now]);
            $id = $this->db->lastInsertId();
        }
        return $this->get($userId, (int) $id);
    }

    /** Replaces the stored spec without touching the version (a PUT edit; only save() on an existing key bumps). */
    public function replaceSpec(int $userId, int $id, array $spec): void
    {
        $this->require($userId, $id);
        $this->db->prepare('UPDATE automations SET spec_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
            ->execute([json_encode($spec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), gmdate('Y-m-d H:i:s'), $id, $userId]);
    }

    /** Links the owner's playbook / workflow (null = leave as is) and stamps automation_id on those rows. */
    public function link(int $userId, int $id, ?int $playbookId, ?int $workflowId): array
    {
        $this->require($userId, $id);
        foreach ([['playbooks', 'playbook_id', $playbookId], ['agent_workflows', 'workflow_id', $workflowId]] as [$table, $col, $rid]) {
            if ($rid === null) {
                continue;
            }
            $st = $this->db->prepare("SELECT 1 FROM {$table} WHERE id = ? AND user_id = ?");
            $st->execute([$rid, $userId]);
            if ($st->fetchColumn() === false) {
                throw new AutomationError("{$col} not found", 404, 'not_found');
            }
        }
        foreach ([['playbooks', 'playbook_id', $playbookId], ['agent_workflows', 'workflow_id', $workflowId]] as [$table, $col, $rid]) {
            if ($rid === null) {
                continue;
            }
            $this->db->prepare("UPDATE {$table} SET automation_id = ? WHERE id = ? AND user_id = ?")->execute([$id, $rid, $userId]);
            $this->db->prepare("UPDATE automations SET {$col} = ? WHERE id = ? AND user_id = ?")->execute([$rid, $id, $userId]);
        }
        return $this->get($userId, $id);
    }

    public function setScope(int $userId, int $id, string $scope): void
    {
        $this->db->prepare('UPDATE automations SET sn_scope = ? WHERE id = ? AND user_id = ?')->execute([$scope, $id, $userId]);
    }

    public function get(int $userId, int $id): ?array
    {
        $st = $this->db->prepare('SELECT ' . self::COLS . ' FROM automations WHERE id = ? AND user_id = ?');
        $st->execute([$id, $userId]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r ? $this->row($r) : null;
    }

    public function list(int $userId): array
    {
        $st = $this->db->prepare('SELECT ' . self::COLS . ' FROM automations WHERE user_id = ? ORDER BY automation_key');
        $st->execute([$userId]);
        $out = [];
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $row = $this->row($r);
            $row['instances'] = $this->instances($row['id']);
            $out[] = $row;
        }
        return $out;
    }

    /** The automation's instances (call only after the owner check). */
    public function instances(int $automationId): array
    {
        $st = $this->db->prepare('SELECT mcp_server_id, installed_version, sn_item_sys_id, last_check_at, status, detail
            FROM automation_instances WHERE automation_id = ? ORDER BY mcp_server_id');
        $st->execute([$automationId]);
        return array_map(function (array $r): array {
            [$env, $text] = self::decodeDetail($r['detail'] ?? null);
            return ['mcp_server_id' => (int) $r['mcp_server_id'],
                'installed_version' => $r['installed_version'] === null ? null : (int) $r['installed_version'],
                'sn_item_sys_id' => $r['sn_item_sys_id'], 'last_check_at' => $r['last_check_at'],
                'status' => $r['status'], 'environment' => $env, 'detail' => $text];
        }, $st->fetchAll(PDO::FETCH_ASSOC));
    }

    public function saveInstance(int $automationId, int $serverId, string $status, ?int $version, ?string $sysId, ?string $environment, string $text): void
    {
        $detail = json_encode(['environment' => $environment, 'text' => $text], JSON_UNESCAPED_UNICODE);
        $now = gmdate('Y-m-d H:i:s');
        $st = $this->db->prepare('SELECT 1 FROM automation_instances WHERE automation_id = ? AND mcp_server_id = ?');
        $st->execute([$automationId, $serverId]);
        if ($st->fetchColumn() === false) {
            $this->db->prepare('INSERT INTO automation_instances (automation_id, mcp_server_id, installed_version, sn_item_sys_id, last_check_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$automationId, $serverId, $version, $sysId, $now, $status, $detail]);
        } else {
            $this->db->prepare('UPDATE automation_instances SET installed_version = ?, sn_item_sys_id = ?, last_check_at = ?, status = ?, detail = ? WHERE automation_id = ? AND mcp_server_id = ?')
                ->execute([$version, $sysId, $now, $status, $detail, $automationId, $serverId]);
        }
    }

    /**
     * The owner's MCP servers whose name starts with "ServiceNow": [{id, name, environment|null}], environment from the
     * latest check of any of the owner's automations on that server. Never includes URL or headers.
     */
    public function servers(int $userId): array
    {
        $st = $this->db->prepare('SELECT id, name FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY id');
        $st->execute([(string) $userId]);
        $out = [];
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            if (!str_starts_with((string) $r['name'], 'ServiceNow')) {
                continue;
            }
            $e = $this->db->prepare('SELECT i.detail FROM automation_instances i JOIN automations a ON a.id = i.automation_id
                WHERE a.user_id = ? AND i.mcp_server_id = ? AND i.last_check_at IS NOT NULL ORDER BY i.last_check_at DESC, i.automation_id DESC LIMIT 1');
            $e->execute([$userId, $r['id']]);
            $d = $e->fetchColumn();
            $out[] = ['id' => (int) $r['id'], 'name' => (string) $r['name'], 'environment' => $d === false ? null : self::decodeDetail($d)[0]];
        }
        return $out;
    }

    /** The owner's enabled server row (id, name, url, headers JSON) or null. */
    public function serverRow(int $userId, int $serverId): ?array
    {
        $st = $this->db->prepare('SELECT id, name, url, headers FROM mcp_servers WHERE id = ? AND user_id = ? AND enabled = 1');
        $st->execute([$serverId, (string) $userId]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r ?: null;
    }

    private function require(int $userId, int $id): void
    {
        if ($this->get($userId, $id) === null) {
            throw new AutomationError('automation not found', 404, 'not_found');
        }
    }

    private function row(array $r): array
    {
        $spec = json_decode((string) $r['spec_json'], true);
        return ['id' => (int) $r['id'], 'key' => (string) $r['automation_key'], 'title' => (string) $r['title'], 'version' => (int) $r['version'],
            'spec' => is_array($spec) ? $spec : [],
            'playbook_id' => $r['playbook_id'] === null ? null : (int) $r['playbook_id'],
            'workflow_id' => $r['workflow_id'] === null ? null : (int) $r['workflow_id'],
            'sn_scope' => $r['sn_scope'], 'updated_at' => $r['updated_at']];
    }

    /** [environment|null, text] from a detail column (JSON, or legacy plain text). */
    private static function decodeDetail(?string $detail): array
    {
        $d = is_string($detail) ? json_decode($detail, true) : null;
        if (!is_array($d)) {
            return [null, (string) $detail];
        }
        return [isset($d['environment']) && is_string($d['environment']) ? $d['environment'] : null, (string) ($d['text'] ?? '')];
    }
}
