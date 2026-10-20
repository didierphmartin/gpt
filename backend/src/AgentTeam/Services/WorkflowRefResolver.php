<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use PDO;

/**
 * Turns the names a compiled workflow graph uses (playbook_ref = pkey, code_component_ref / start_option_ref =
 * component name, edge from_port_name = exit name) into the ids and ports the graph repository stores.
 * Resolution is against the workflow owner's own rows only.
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
    public function resolve(int $userId, array $nodes, array $edges): array
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
                $pid = $this->playbookId($userId, $ref);
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
                $c = $this->component($userId, $ref);
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
                $c = $this->component($userId, $ref);
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

    private function playbookId(int $userId, string $pkey): ?int
    {
        $st = $this->db->prepare('SELECT id FROM playbooks WHERE user_id = ? AND pkey = ? ORDER BY id LIMIT 1');
        $st->execute([$userId, $pkey]);
        $id = $st->fetchColumn();
        return $id === false ? null : (int) $id;
    }

    /** @return array{id: int, exits: list<string>}|null */
    private function component(int $userId, string $name): ?array
    {
        $st = $this->db->prepare('SELECT id, exits FROM code_components WHERE user_id = ? AND name = ? LIMIT 1');
        $st->execute([$userId, $name]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $exits = json_decode((string) $row['exits'], true);
        return ['id' => (int) $row['id'], 'exits' => is_array($exits) ? array_values($exits) : []];
    }
}
