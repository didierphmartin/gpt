<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\CodeComponent;

use AgentTeam\Services\CodeNodeEmit;
use AgentTeam\Services\ScheduledWorkflowService;
use PDO;

/**
 * The code components collection: the only code that touches `code_components`. A component is a
 * code node's body (code, exits, MCP servers, timeout) under a name unique per user; workflow code
 * nodes link to it by config.code_component_id. Owner-scoped throughout.
 */
final class CodeComponentStore
{
    private const NAME_MAX = 191;
    private const COLS = 'id, name, description, code, exits, mcp_servers, timeout_s, start_trigger, updated_at';
    private const LABEL_MAX = 60;

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
        $before = $id === null ? null : $this->get($userId, $id);
        if ($id !== null && $before === null) {
            throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
        }
        $clash = $this->getByName($userId, $c['name']);
        if ($id === null && $clash !== null) {
            $id = $clash['id'];
            $before = $clash;
        } elseif ($clash !== null && $clash['id'] !== $id) {
            throw new CodeComponentError('name_taken', "A code component named \"{$c['name']}\" already exists.", 409);
        }
        if ($before !== null && $before['start_trigger'] !== null) {
            $t = $before['start_trigger'];
            if (!in_array($t['work_exit'], $c['exits'], true)) {
                throw new CodeComponentError('start_exit',
                    "Exit \"{$t['work_exit']}\" starts workflows: keep it or change the Start option first.", 422);
            }
            if (!in_array($t['watch']['server'], $c['mcp_servers'], true)) {
                throw new CodeComponentError('start_exit',
                    "MCP server \"{$t['watch']['server']}\" starts workflows: keep it or change the Start option first.", 422);
            }
        }
        $vals = [$c['name'], $c['description'], $c['code'], json_encode($c['exits']), json_encode($c['mcp_servers']), $c['timeout_s']];
        if ($id === null) {
            $this->db->prepare('INSERT INTO code_components (user_id, name, description, code, exits, mcp_servers, timeout_s, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')->execute([$userId, ...$vals]);
            $id = (int) $this->db->lastInsertId();
        } else {
            $outer = !$this->db->inTransaction();
            if ($outer) {
                $this->db->beginTransaction();
            }
            try {
                $this->db->prepare('UPDATE code_components SET name = ?, description = ?, code = ?, exits = ?, mcp_servers = ?, timeout_s = ?,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([...$vals, $id, $userId]);
                if ($before['exits'] !== $c['exits']) {
                    $this->remapExits($userId, $id, $before['exits'], $c['exits']);
                }
                if ($outer) {
                    $this->db->commit();
                }
            } catch (\Throwable $e) {
                if ($outer && $this->db->inTransaction()) {
                    $this->db->rollBack();
                }
                throw $e;
            }
        }
        return $this->get($userId, $id);
    }

    public function delete(int $userId, int $id): void
    {
        $c = $this->get($userId, $id);
        if ($c === null) {
            throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
        }
        if ($c['start_trigger'] !== null) {
            throw new CodeComponentError('is_option', 'This code component is a Start option: remove the option first.', 409);
        }
        $used = $this->usedBy($userId, $id);
        if ($used !== []) {
            $names = array_map(fn($n) => "node \"{$n['node_name']}\" in workflow \"{$n['workflow_name']}\"", $used);
            throw new CodeComponentError('in_use', 'This code component is used by ' . implode(', ', $names) . '.', 409);
        }
        $this->db->prepare('DELETE FROM code_components WHERE id = ? AND user_id = ?')->execute([$id, $userId]);
    }

    /** Make the component a Start option (spec §1); the trigger is validated against the component. */
    public function setStartTrigger(int $userId, int $id, array $trigger): array
    {
        $c = $this->get($userId, $id) ?? throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
        $t = self::validateStartTrigger($c, $trigger);
        $this->db->prepare('UPDATE code_components SET start_trigger = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
            ->execute([json_encode($t, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), $id, $userId]);
        return $this->get($userId, $id);
    }

    /** The user's workflows whose schedule runs on this option, with the linked node's name when there is one. */
    public function startTriggerImpact(int $userId, int $id): array
    {
        $st = $this->db->prepare('SELECT DISTINCT s.workflow_id, w.name FROM scheduled_workflows s
            JOIN agent_workflows w ON w.id = s.workflow_id
            WHERE s.user_id = ? AND s.trigger_component_id = ? ORDER BY w.name');
        $st->execute([$userId, $id]);
        $nodes = [];
        foreach ($this->linkedNodes($userId, $id) as $n) {
            $nodes[$n['workflow_id']] ??= $n['node_name'];
        }
        return array_map(fn($r) => ['workflow_id' => (int) $r['workflow_id'], 'workflow_name' => (string) $r['name'],
            'node_name' => $nodes[(int) $r['workflow_id']] ?? null], $st->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Remove the option: its schedule rows are deleted (a 'none' row would still run once at its time) and the
     * component stops being an option. Graphs are not touched; their linked nodes stay (spec decision 6).
     */
    public function clearStartTrigger(int $userId, int $id): array
    {
        if ($this->get($userId, $id) === null) {
            throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
        }
        $impact = $this->startTriggerImpact($userId, $id);
        $outer = !$this->db->inTransaction();
        if ($outer) {
            $this->db->beginTransaction();
        }
        try {
            $this->db->prepare('DELETE FROM scheduled_workflows WHERE user_id = ? AND trigger_component_id = ?')->execute([$userId, $id]);
            $this->db->prepare('UPDATE code_components SET start_trigger = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
                ->execute([$id, $userId]);
            if ($outer) {
                $this->db->commit();
            }
        } catch (\Throwable $e) {
            if ($outer && $this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
        return $impact;
    }

    /** A schedule save naming an option becomes that option's event schedule (spec §3); other bodies pass through. */
    public function scheduleBody(int $userId, array $body): array
    {
        if (empty($body['trigger_component_id'])) {
            return $body;
        }
        $id = (int) $body['trigger_component_id'];
        return ['repeat_type' => 'event', 'event_trigger' => $this->watchFor($userId, $id), 'cron' => null,
            'trigger_component_id' => $id] + $body;
    }

    /** The option's watch, as an event schedule stores it: {server, tool, args}. */
    public function watchFor(int $userId, int $id): array
    {
        $c = $this->get($userId, $id) ?? throw new CodeComponentError('not_found', "Code component #{$id} not found", 404);
        if ($c['start_trigger'] === null) {
            throw new CodeComponentError('not_option', "\"{$c['name']}\" is not a Start option.", 422);
        }
        return $c['start_trigger']['watch'];
    }

    /**
     * A workflow_nodes row is a code node. The column decides when it has a value; a DB whose node_type
     * is still the old ENUM (no 'code') stores '' for one, and then the config's type decides.
     */
    public static function isCodeNode(?string $nodeType, mixed $cfg): bool
    {
        return ($nodeType ?? '') !== '' ? $nodeType === 'code' : is_array($cfg) && ($cfg['type'] ?? null) === 'code';
    }

    /** The user's workflow code nodes that link to the component. */
    public function usedBy(int $userId, int $id): array
    {
        return array_map(fn($n) => array_diff_key($n, ['node_id' => 1]), $this->linkedNodes($userId, $id));
    }

    /** usedBy plus each node's workflow_nodes.id. */
    private function linkedNodes(int $userId, int $id): array
    {
        // The link lives in the node's config JSON: decoded here, so the query stays portable (MySQL and SQLite).
        $st = $this->db->prepare("SELECT n.id AS node_id, n.node_type, n.config, w.id AS workflow_id, w.name AS workflow_name
            FROM workflow_nodes n JOIN agent_workflows w ON w.id = n.workflow_id
            WHERE w.user_id = ? ORDER BY w.name, n.id");
        $st->execute([(string) $userId]);
        $nodes = [];
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $cfg = json_decode((string) $r['config'], true);
            if (self::isCodeNode($r['node_type'], $cfg) && (int) ($cfg['code_component_id'] ?? 0) === $id) {
                $nodes[] = ['workflow_id' => (int) $r['workflow_id'], 'workflow_name' => (string) $r['workflow_name'],
                    'node_name' => (string) ($cfg['name'] ?? 'Code'), 'node_id' => (int) $r['node_id']];
            }
        }
        return $nodes;
    }

    /**
     * Edges are stored by port index (output_k = exit k), so an exit change moves each linked node's
     * edges BY NAME, as the editor's CodeNode.remapExits does: a surviving exit keeps its edges on its
     * new port, a removed exit's edges go; one exit left moves every edge onto output_1 (duplicates
     * dropped); one exit before lands on output_1 unless its name survives. Ports beyond the old exits
     * are left alone.
     */
    private function remapExits(int $userId, int $id, array $oldExits, array $newExits): void
    {
        $select = $this->db->prepare('SELECT id, to_node_id, to_port, from_port FROM workflow_edges WHERE from_node_id = ? ORDER BY id');
        $move = $this->db->prepare('UPDATE workflow_edges SET from_port = ? WHERE id = ?');
        $drop = $this->db->prepare('DELETE FROM workflow_edges WHERE id = ?');
        foreach ($this->linkedNodes($userId, $id) as $node) {
            $select->execute([$node['node_id']]);
            $edges = [];
            foreach ($select->fetchAll(PDO::FETCH_ASSOC) as $e) {
                $k = preg_match('/^output_(\d+)$/', (string) $e['from_port'], $m) ? (int) $m[1] : 0;
                if ($k >= 1 && $k <= count($oldExits)) {
                    $edges[] = $e + ['k' => $k];
                }
            }
            // old port order, so a collapse keeps the edge of the earliest exit (as the editor does)
            usort($edges, fn($a, $b) => [$a['k'], (int) $a['id']] <=> [$b['k'], (int) $b['id']]);
            $seen = [];
            foreach ($edges as $e) {
                if (count($newExits) === 1) {
                    $key = $e['to_node_id'] . '|' . $e['to_port'];
                    if (isset($seen[$key])) {
                        $drop->execute([$e['id']]);
                        continue;
                    }
                    $seen[$key] = true;
                    $j = 0;
                } else {
                    $exit = $oldExits[$e['k'] - 1];
                    $found = array_search($exit, $newExits, true);
                    $j = count($oldExits) === 1 && $found === false ? 0 : ($found === false ? -1 : $found);
                }
                if ($j < 0) {
                    $drop->execute([$e['id']]);
                } elseif ('output_' . ($j + 1) !== $e['from_port']) {
                    $move->execute(['output_' . ($j + 1), $e['id']]);
                }
            }
        }
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

    /** {label, watch: {server, tool, args}, work_exit} against the component; args stay a JSON object. */
    private static function validateStartTrigger(array $c, array $t): array
    {
        $bad = fn(string $why) => throw new CodeComponentError('invalid', $why, 422);
        $label = trim((string) ($t['label'] ?? ''));
        $label = $label === '' ? $c['name'] : $label;
        if (mb_strlen($label) > self::LABEL_MAX) {
            $bad('The option label is at most ' . self::LABEL_MAX . ' characters.');
        }
        try {   // the shape an event schedule accepts (ScheduledWorkflowService::eventTrigger), normalised
            $watch = json_decode(ScheduledWorkflowService::eventTrigger($t['watch'] ?? null));
        } catch (\InvalidArgumentException $e) {
            $bad($e->getMessage());
        }
        if (!in_array($watch->server, $c['mcp_servers'], true)) {
            $bad("MCP server \"{$watch->server}\" is not one of this component's servers.");
        }
        $exit = (string) ($t['work_exit'] ?? '');
        if (!in_array($exit, $c['exits'], true)) {
            $bad("Exit \"{$exit}\" is not one of this component's exits.");
        }
        return ['label' => $label, 'watch' => $watch, 'work_exit' => $exit];
    }

    private function row(array $r): array
    {
        return ['id' => (int) $r['id'], 'name' => (string) $r['name'], 'description' => (string) ($r['description'] ?? ''),
            'code' => (string) $r['code'], 'exits' => json_decode((string) $r['exits'], true) ?: [],
            'mcp_servers' => json_decode((string) $r['mcp_servers'], true) ?: [], 'timeout_s' => (int) $r['timeout_s'],
            'start_trigger' => ($r['start_trigger'] ?? null) ? json_decode((string) $r['start_trigger'], true) : null,
            'updated_at' => $r['updated_at']];
    }
}
