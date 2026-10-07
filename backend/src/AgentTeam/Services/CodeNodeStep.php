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

    /** Characters of an error exit's output kept in its log line (the compiled ErrorExitTaken.REASON_MAX). */
    public const REASON_MAX = 200;

    /** An error exit's output as one line of at most REASON_MAX characters (ErrorExitTaken.reason): it may be a whole tool error page or email body. */
    public static function reason(string $out): string
    {
        $line = trim((string) preg_replace('/\s+/u', ' ', $out));
        return mb_strlen($line) <= self::REASON_MAX ? $line : mb_substr($line, 0, self::REASON_MAX) . '…';
    }

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

    /** One line per code node that took its error exit: "code node '<name>' took its error exit: <reason>". */
    public static function errorExits(array $nodeOutputs, array $nodes): array
    {
        $lines = [];
        foreach ($nodeOutputs as $id => $o) {
            if (($o['type'] ?? '') === 'code' && ($o['exit'] ?? null) === 'error') {
                $name = trim((string) ($nodes[$id]['config']['name'] ?? '')) ?: 'Code';
                $reason = self::reason((string) ($o['output'] ?? ''));
                $lines[] = "code node '{$name}' took its error exit" . ($reason !== '' ? ": {$reason}" : '');
            }
        }
        return $lines;
    }

    /**
     * quiet: a code node ran, did not error, and no work node ran. drain: a code node ran, a work node
     * downstream of the exit it took ran, and nothing errored (a work node beside the poll, fed by Start,
     * runs every tick and must not make a no-work run drain). A code node "ran" only when it took an
     * exit: a disabled one (no exit) neither quiets nor drains the run. An error exit or a failed code
     * node is never quiet and never drains: errors are always recorded.
     *
     * @param array $edges the graph's edges (from_node_id, to_node_id, from_port)
     * @param array $nodes the graph's nodes by id (a code node's config carries its exits)
     */
    public static function summarize(array $nodeOutputs, array $edges, array $nodes): array
    {
        $codeRan = false;
        $errored = false;
        $worked = false;
        $behindExit = [];   // node ids downstream of an exit a code node took
        foreach ($nodeOutputs as $id => $o) {
            $type = $o['type'] ?? '';
            if (in_array($type, self::WORK_TYPES, true)) {
                $worked = true;
            }
            if ($type !== 'code') {
                continue;
            }
            if (($o['exit'] ?? null) === 'error' || ($o['success'] ?? true) === false) {
                $errored = true;
            } elseif (is_string($o['exit'] ?? null)) {
                $codeRan = true;
                $behindExit += self::downstreamOfExit((int) $id, $o['exit'], $edges, $nodes);
            }
        }
        $workedBehindExit = false;
        foreach (array_keys($behindExit) as $id) {
            if (in_array($nodeOutputs[$id]['type'] ?? '', self::WORK_TYPES, true)) {
                $workedBehindExit = true;
            }
        }
        return ['quiet' => $codeRan && !$errored && !$worked, 'drain' => $codeRan && !$errored && $workedBehindExit];
    }

    /** Every node reachable from the children on code node $id's $exit port (ids as keys). */
    private static function downstreamOfExit(int $id, string $exit, array $edges, array $nodes): array
    {
        $exits = array_values((array) ($nodes[$id]['config']['exits'] ?? ['next']));
        $k = array_search($exit, $exits, true);
        if ($k === false) {
            return [];
        }
        $port = 'output_' . ($k + 1);
        $todo = [];
        foreach ($edges as $e) {
            if ((int) $e['from_node_id'] === $id && ($e['from_port'] ?? 'output_1') === $port) {
                $todo[] = (int) $e['to_node_id'];
            }
        }
        $seen = [];
        while ($todo) {
            $n = array_pop($todo);
            if (isset($seen[$n])) {
                continue;
            }
            $seen[$n] = true;
            foreach ($edges as $e) {
                if ((int) $e['from_node_id'] === $n) {
                    $todo[] = (int) $e['to_node_id'];
                }
            }
        }
        return $seen;
    }
}
