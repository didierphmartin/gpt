<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/**
 * Turns the names a compiled workflow graph uses (playbook_ref = pkey, code_component_ref / start_option_ref =
 * component name, edge from_port_name = exit name) into the ids and ports the graph repository stores.
 * Resolution is against the workflow owner's own rows, then the robot's (shared with robot-permitted users).
 */
final class WorkflowRefResolver
{
    private const PLAYBOOK_EXITS = ['done', 'failed'];

    public function __construct(private PDO $db)
    {
    }

    /**
     * @return array{nodes: array, edges: array}
     * @throws UnresolvedRefsException listing every name that did not resolve
     */
    public function resolve(int $userId, array $nodes, array $edges, ?int $robotId = null): array
    {
        $missing = [];
        $exitsByNode = [];   // node id => list of exit names the node's out-edges are named against

        foreach ($nodes as $i => $node) {
            $cfg = $node['config'] ?? $node['data'] ?? null;
            if (!is_array($cfg)) {
                continue;
            }
            $key = isset($node['config']) ? 'config' : 'data';
            $id = (string) ($node['id'] ?? '');

            if (isset($cfg['playbook_ref'])) {
                $ref = (string) $cfg['playbook_ref'];
                $pid = $this->playbookId($userId, $ref, $robotId);
                if ($pid === null) {
                    $missing[] = "playbook '$ref'";
                } else {
                    $cfg['playbook_id'] = $pid;
                }
                unset($cfg['playbook_ref']);
                $exitsByNode[$id] = self::PLAYBOOK_EXITS;
            }
            if (isset($cfg['code_component_ref'])) {
                $ref = (string) $cfg['code_component_ref'];
                $c = $this->component($userId, $ref, $robotId);
                if ($c === null) {
                    $missing[] = "code component '$ref'";
                } else {
                    $cfg['code_component_id'] = $c['id'];
                    $exitsByNode[$id] = $c['exits'];
                }
                unset($cfg['code_component_ref']);
            }
            if (isset($cfg['start_option_ref'])) {
                $ref = (string) $cfg['start_option_ref'];
                $c = $this->component($userId, $ref, $robotId);
                if ($c === null) {
                    $missing[] = "start option component '$ref'";
                } else {
                    $cfg['start_option'] = $c['id'];
                    $exitsByNode[$id] = $c['exits'];
                }
                unset($cfg['start_option_ref']);
            }
            $nodes[$i][$key] = $cfg;
        }

        foreach ($edges as $i => $edge) {
            if (!array_key_exists('from_port_name', $edge)) {
                continue;
            }
            $name = (string) $edge['from_port_name'];
            $from = (string) ($edge['from'] ?? $edge['from_node_id'] ?? '');
            $exits = $exitsByNode[$from] ?? null;
            $at = $exits === null ? false : array_search($name, $exits, true);
            if ($at === false) {
                $missing[] = "exit '$name' on node '$from'";
            } else {
                $edge['from_port'] = 'output_' . ($at + 1);
            }
            unset($edge['from_port_name']);
            $edges[$i] = $edge;
        }

        if ($missing) {
            throw new UnresolvedRefsException(array_values(array_unique($missing)));
        }
        return ['nodes' => $nodes, 'edges' => $edges];
    }

    /**
     * The links of a robot workflow's (resolved) nodes the robot cannot use: another user's code component, Start
     * option or playbook (the robot's published playbook copies included), or an agent neither the robot's nor
     * public/workspace. Named "code component #8" and so on; [] when every link is the robot's.
     */
    public function foreignToRobot(int $robotId, array $nodes): array
    {
        $missing = [];
        $has = function (string $sql, int $id) use ($robotId): bool {
            $st = $this->db->prepare($sql);
            $st->execute([$id, $robotId]);
            return $st->fetchColumn() !== false;
        };
        foreach ($nodes as $node) {
            $cfg = $node['config'] ?? $node['data'] ?? [];
            $cfg = is_array($cfg) ? $cfg : [];
            $type = (string) ($node['node_type'] ?? $node['type'] ?? $cfg['type'] ?? '');
            if (CodeComponentStore::isCodeNode($type, $cfg) && !empty($cfg['code_component_id'])
                && !$has('SELECT 1 FROM code_components WHERE id = ? AND user_id = ?', (int) $cfg['code_component_id'])) {
                $missing[] = 'code component #' . (int) $cfg['code_component_id'];
            }
            $option = StartOptionGraph::optionId(['node_type' => $type, 'config' => $cfg]);
            if ($option !== null && !$has('SELECT 1 FROM code_components WHERE id = ? AND user_id = ?', $option)) {
                $missing[] = "start option component #$option";
            }
            if (!empty($cfg['playbook_id'])
                && !$has('SELECT 1 FROM playbooks WHERE id = ? AND user_id = ? AND source_id IS NULL', (int) $cfg['playbook_id'])) {
                $missing[] = 'playbook #' . (int) $cfg['playbook_id'];
            }
            $agent = $node['agent_id'] ?? null;
            if (is_numeric($agent) && (int) $agent > 0 && !$has("SELECT 1 FROM agents WHERE id = ?
                    AND (user_id = ? OR visibility IN ('public', 'workspace'))", (int) $agent)) {
                $missing[] = 'agent #' . (int) $agent;
            }
        }
        return array_values(array_unique($missing));
    }

    private function playbookId(int $userId, string $pkey, ?int $robotId): ?int
    {
        foreach ($robotId === null ? [$userId] : array_unique([$userId, $robotId]) as $owner) {
            // the robot's published copies (source_id set, the ServiceNow bridge's) are not shared rows
            $st = $this->db->prepare('SELECT id FROM playbooks WHERE user_id = ? AND pkey = ?'
                . ($owner === $robotId ? ' AND source_id IS NULL' : '') . ' ORDER BY id LIMIT 1');
            $st->execute([$owner, $pkey]);
            $id = $st->fetchColumn();
            if ($id !== false) {
                return (int) $id;
            }
        }
        return null;
    }

    /** @return array{id: int, exits: list<string>}|null */
    private function component(int $userId, string $name, ?int $robotId): ?array
    {
        $st = $this->db->prepare('SELECT id, exits FROM code_components WHERE user_id = ? AND name = ? ORDER BY id LIMIT 1');
        $row = false;
        foreach ($robotId === null ? [$userId] : [$userId, $robotId] as $owner) {
            $st->execute([$owner, $name]);
            $row = $st->fetch(PDO::FETCH_ASSOC);
            $st->closeCursor();
            if ($row) {
                break;
            }
        }
        if (!$row) {
            return null;
        }
        $exits = json_decode((string) $row['exits'], true);
        return ['id' => (int) $row['id'], 'exits' => is_array($exits) ? array_values($exits) : []];
    }
}
