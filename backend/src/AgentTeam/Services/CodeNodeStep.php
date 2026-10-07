<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The server runner's code-node rules, as pure functions. Twins of code-node.js
 * (parentsFor, routeAfter) so the browser and server run paths cannot drift.
 */
final class CodeNodeStep
{
    /** Node types whose execution means the run did real work (not a quiet poll). */
    private const WORK_TYPES = ['agent', 'playbook', 'output'];

    /** run()'s parents: executed parents with a non-empty output; Start flagged (CodeNode.parentsFor). */
    public static function parents(int $nodeId, array $edges, array $nodes, array $nodeOutputs): array
    {
        $out = [];
        foreach ($edges as $e) {
            if ((int) $e['to_node_id'] !== $nodeId) {
                continue;
            }
            $u = (int) $e['from_node_id'];
            $text = $nodeOutputs[$u]['output'] ?? null;
            if ($text === null || $text === '') {
                continue;
            }
            $start = ($nodes[$u]['node_type'] ?? '') === 'start';
            $cfg = $nodes[$u]['config'] ?? [];
            $out[] = ['name' => $start ? 'start' : (string) (($cfg['agent_name'] ?? '') ?: ($cfg['name'] ?? '') ?: "node_{$u}"),
                'text' => is_string($text) ? $text : json_encode($text), 'start' => $start];
        }
        return $out;
    }

    /**
     * What a code node's result means for the run (CodeNode.routeAfter): its output, the children on the
     * exit it took, and the children to skip. A failed run skips every child; an exit with no edge ends
     * that branch, which is not a failure.
     */
    public static function routeAfter(array $data, array $result, array $children): array
    {
        $children = array_map('intval', $children);
        if (empty($result['ok'])) {
            return ['success' => false, 'output' => 'Error: ' . ($result['error'] ?? 'code node failed'),
                'exit' => null, 'chosen' => [], 'skip' => $children];
        }
        $chosen = array_map('intval', $data['exit_targets'][$result['route']] ?? []);
        return ['success' => true, 'output' => (string) ($result['output_text'] ?? ''), 'exit' => $result['route'],
            'chosen' => $chosen, 'skip' => array_values(array_diff($children, $chosen))];
    }

    /**
     * quiet: a code node ran, did not error, and no work node ran. drain: a code node ran, the run did
     * real work, and nothing errored. An error exit or a failed code node is never quiet and never drains:
     * errors are always recorded.
     */
    public static function summarize(array $nodeOutputs): array
    {
        $types = [];
        $errored = false;
        foreach ($nodeOutputs as $o) {
            $type = $o['type'] ?? '';
            $types[] = $type;
            if ($type === 'code' && (($o['exit'] ?? null) === 'error' || ($o['success'] ?? true) === false)) {
                $errored = true;
            }
        }
        $codeRan = in_array('code', $types, true);
        $worked = (bool) array_intersect($types, self::WORK_TYPES);
        return ['quiet' => $codeRan && !$errored && !$worked, 'drain' => $codeRan && !$errored && $worked];
    }
}
