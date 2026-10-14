<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\CodeComponent;

use AgentTeam\Services\CodeNodeEmit;
use PDO;

/**
 * The code components collection: the only code that touches `code_components`. A component is a
 * code node's body (code, exits, MCP servers, timeout) under a name unique per user; workflow code
 * nodes link to it by config.code_component_id. Owner-scoped throughout.
 */
final class CodeComponentStore
{
    private const NAME_MAX = 191;
    private const COLS = 'id, name, description, code, exits, mcp_servers, timeout_s, updated_at';

    public function __construct(private readonly PDO $db) {}

    public function list(int $userId): array
    {
        $st = $this->db->prepare('SELECT ' . self::COLS . ' FROM code_components WHERE user_id = ? ORDER BY name');
        $st->execute([$userId]);
        $rows = array_map(fn($r) => $this->row($r), $st->fetchAll(PDO::FETCH_ASSOC));
        foreach ($rows as &$r) {
            $r['used_by'] = count($this->usedBy($userId, $r['id']));
        }
        unset($r);
        return $rows;
    }

    public function get(int $userId, int $id): ?array
    {
        $st = $this->db->prepare('SELECT ' . self::COLS . ' FROM code_components WHERE id = ? AND user_id = ?');
        $st->execute([$id, $userId]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r === false ? null : $this->row($r);
    }

    public function getByName(int $userId, string $name): ?array
    {
        $st = $this->db->prepare('SELECT ' . self::COLS . ' FROM code_components WHERE name = ? AND user_id = ?');
        $st->execute([$name, $userId]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r === false ? null : $this->row($r);
    }

    /** Create ($id null; an existing name updates that row, as agents do) or update by id. */
    public function save(int $userId, ?int $id, array $data): array
    {
        $c = self::validate($data);
        if ($id !== null && $this->get($userId, $id) === null) {
            throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
        }
        $clash = $this->getByName($userId, $c['name']);
        if ($id === null && $clash !== null) {
            $id = $clash['id'];
        } elseif ($clash !== null && $clash['id'] !== $id) {
            throw new CodeComponentError('name_taken', "A code component named \"{$c['name']}\" already exists.", 409);
        }
        $vals = [$c['name'], $c['description'], $c['code'], json_encode($c['exits']), json_encode($c['mcp_servers']), $c['timeout_s']];
        if ($id === null) {
            $this->db->prepare('INSERT INTO code_components (user_id, name, description, code, exits, mcp_servers, timeout_s, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')->execute([$userId, ...$vals]);
            $id = (int) $this->db->lastInsertId();
        } else {
            $this->db->prepare('UPDATE code_components SET name = ?, description = ?, code = ?, exits = ?, mcp_servers = ?, timeout_s = ?,
                updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([...$vals, $id, $userId]);
        }
        return $this->get($userId, $id);
    }

    public function delete(int $userId, int $id): void
    {
        if ($this->get($userId, $id) === null) {
            throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
        }
        $used = $this->usedBy($userId, $id);
        if ($used !== []) {
            $names = array_map(fn($n) => "node \"{$n['node_name']}\" in workflow \"{$n['workflow_name']}\"", $used);
            throw new CodeComponentError('in_use', 'This code component is used by ' . implode(', ', $names) . '.', 409);
        }
        $this->db->prepare('DELETE FROM code_components WHERE id = ? AND user_id = ?')->execute([$id, $userId]);
    }

    /** The user's workflow code nodes that link to the component. */
    public function usedBy(int $userId, int $id): array
    {
        // The link lives in the node's config JSON: decoded here, so the query stays portable (MySQL and SQLite).
        $st = $this->db->prepare("SELECT n.config, w.id AS workflow_id, w.name AS workflow_name
            FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id
            WHERE w.user_id = ? AND n.node_type = 'code' ORDER BY w.name, n.id");
        $st->execute([(string) $userId]);
        $nodes = [];
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $cfg = json_decode((string) $r['config'], true);
            if (is_array($cfg) && (int) ($cfg['code_component_id'] ?? 0) === $id) {
                $nodes[] = ['workflow_id' => (int) $r['workflow_id'], 'workflow_name' => (string) $r['workflow_name'],
                    'node_name' => (string) ($cfg['name'] ?? 'Code')];
            }
        }
        return $nodes;
    }

    /** The editor's rules (CodeNode.validateConfig): a name, 1-8 unique exits, server names, 1-300 s. */
    private static function validate(array $d): array
    {
        $bad = fn(string $why) => throw new CodeComponentError('invalid', $why, 422);
        $name = trim((string) ($d['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > self::NAME_MAX) {
            $bad('The name is required (at most 191 characters).');
        }
        $code = $d['code'] ?? '';
        if (!is_string($code)) {
            $bad('code must be text.');
        }
        $exits = $d['exits'] ?? null;
        if (!is_array($exits) || $exits === [] || count($exits) > 8 || count(array_unique($exits)) !== count($exits)) {
            $bad('exits must be 1 to 8 unique names.');
        }
        foreach ($exits as $e) {
            if (!is_string($e) || !preg_match(CodeNodeEmit::EXIT_RE, $e)) {
                $bad('Exit names are lowercase letters, digits and _ (got ' . json_encode($e) . ').');
            }
        }
        $servers = $d['mcp_servers'] ?? [];
        if (!is_array($servers) || array_filter($servers, fn($s) => !is_string($s)) !== []) {
            $bad('mcp_servers must be a list of MCP server names.');
        }
        $timeout = $d['timeout_s'] ?? 30;
        if (!is_int($timeout) || $timeout < 1 || $timeout > 300) {
            $bad('timeout_s must be 1 to 300 seconds.');
        }
        return ['name' => $name, 'description' => (string) ($d['description'] ?? ''), 'code' => $code,
            'exits' => array_values($exits), 'mcp_servers' => array_values($servers), 'timeout_s' => $timeout];
    }

    private function row(array $r): array
    {
        return ['id' => (int) $r['id'], 'name' => (string) $r['name'], 'description' => (string) ($r['description'] ?? ''),
            'code' => (string) $r['code'], 'exits' => json_decode((string) $r['exits'], true) ?: [],
            'mcp_servers' => json_decode((string) $r['mcp_servers'], true) ?: [], 'timeout_s' => (int) $r['timeout_s'],
            'updated_at' => $r['updated_at']];
    }
}
