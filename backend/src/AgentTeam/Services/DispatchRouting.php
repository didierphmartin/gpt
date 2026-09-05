<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Dispatcher routing for batch workflows — the batch twin of the voice
 * runner's handoff_to (frontend/assets/js/workflow-realtime-runner.js).
 *
 * For an agent of type 'dispatcher', its outgoing edges are a MENU of
 * branches the model may pick from by name, not a parallel fan-out. The
 * model calls route_to(target) once; exactly that branch runs and every
 * node reachable only through the unchosen branches is skipped.
 *
 * Pure functions over the graph shape used by GraphWorkflowRunner
 * (nodes indexed by id with node_type/config; edges with from_node_id /
 * to_node_id). No I/O, so both run paths can be reasoned about here.
 */
final class DispatchRouting
{
    public const TOOL_NAME = 'route_to';

    /** Downstream agent nodes of $nodeId as [['id' => int, 'name' => string], …] in edge order. */
    public static function targets(int $nodeId, array $edges, array $nodes): array
    {
        $out = [];
        foreach ($edges as $edge) {
            if ((int)$edge['from_node_id'] !== $nodeId) continue;
            $toId = (int)$edge['to_node_id'];
            $node = $nodes[$toId] ?? null;
            if (!$node || ($node['node_type'] ?? '') !== 'agent') continue;
            $cfg = $node['config'] ?? [];
            $name = (string)($cfg['agent_name'] ?? $cfg['name'] ?? "Agent {$toId}");
            $out[] = ['id' => $toId, 'name' => $name];
        }
        return $out;
    }

    /** Tool definition in the Claude shape ({name, description, input_schema}) — the
     *  common denominator AgentRunner's extra_tools use; other providers translate it. */
    public static function toolDefinition(array $targets): array
    {
        $names = array_column($targets, 'name');
        return [
            'name' => self::TOOL_NAME,
            'description' => 'REQUIRED tool to hand the request to exactly one downstream agent. '
                . 'Pick the agent whose role matches the request. Available targets: '
                . implode(', ', $names) . '. The chosen agent receives the original request, plus your notes.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'target' => [
                        'type' => 'string',
                        'enum' => $names,
                        'description' => 'Name of the agent to route to. MUST be one of the listed values.',
                    ],
                    'notes' => [
                        'type' => 'string',
                        'description' => 'Optional short note for the target agent (what you understood, what to focus on).',
                    ],
                ],
                'required' => ['target'],
            ],
        ];
    }

    /**
     * Instructions for a node the author left blank. Without this the chat
     * endpoint falls back to the user's CONVERSATION persona (Context tab,
     * 2026-09-02) — a workflow node must never inherit that.
     */
    public static function defaultInstructions(string $agentName, string $description, string $workflowName): string
    {
        $desc = trim($description);
        return "You are \"{$agentName}\"" . ($desc !== '' ? ", {$desc}" : '')
            . ", an agent in the workflow \"{$workflowName}\". "
            . "Handle the request you receive directly and completely, in the role your name implies.";
    }

    /**
     * Fragment appended to the CHOSEN target's instructions (the batch twin of
     * the voice prompt "the caller has been transferred to you for billing help").
     */
    public static function routedPrompt(string $targetName, string $fromName, string $notes): string
    {
        $n = trim($notes);
        return "## Routed request\n"
            . "The dispatcher \"{$fromName}\" reviewed this request and routed it to you, \"{$targetName}\", "
            . "because it falls under your responsibility. Handle it yourself as \"{$targetName}\". "
            . "Do not redirect the requester to another department or agent, and do not ask who should handle it."
            . ($n !== '' ? "\nNotes from the dispatcher: {$n}" : '');
    }

    /**
     * ['from' => dispatcherName, 'notes' => …] when an upstream dispatcher's
     * output routed to $nodeId, else null. $outputs = nodeOutputs by node id.
     */
    public static function routedBy(int $nodeId, array $edges, array $outputs): ?array
    {
        foreach ($edges as $edge) {
            if ((int)$edge['to_node_id'] !== $nodeId) continue;
            $out = $outputs[(int)$edge['from_node_id']] ?? null;
            $route = is_array($out) ? ($out['route'] ?? null) : null;
            if (is_array($route) && (int)($route['id'] ?? 0) === $nodeId) {
                return ['from' => (string)($out['agent_name'] ?? 'dispatcher'), 'notes' => (string)($route['notes'] ?? '')];
            }
        }
        return null;
    }

    /** Prompt fragment appended to the dispatcher's instructions (mirrors the voice TRANSFER RULES). */
    public static function promptBlock(array $targets): string
    {
        $lines = array_map(fn($t) => "  - {$t['name']}", $targets);
        return "## Routing\n"
            . "You are a dispatcher. Your only job is to decide which ONE of these agents should handle the request:\n"
            . implode("\n", $lines) . "\n"
            . "Read the request, then call the route_to function with target set to that agent's exact name "
            . "(optionally add notes). You MUST call route_to — answering in prose does not route the request. "
            . "Never call it more than once.";
    }

    /**
     * The chosen target from the model's tool calls, as
     * ['id' => int, 'name' => string, 'notes' => string], or null when no
     * route_to call names a known target.
     */
    public static function resolve(array $toolCalls, array $targets): ?array
    {
        foreach ($toolCalls as $call) {
            if (($call['name'] ?? '') !== self::TOOL_NAME) continue;
            $input = is_array($call['input'] ?? null) ? $call['input'] : (is_array($call['arguments'] ?? null) ? $call['arguments'] : []);
            $want = strtolower(trim((string)($input['target'] ?? '')));
            foreach ($targets as $t) {
                if (strtolower(trim($t['name'])) === $want) {
                    return ['id' => $t['id'], 'name' => $t['name'], 'notes' => trim((string)($input['notes'] ?? ''))];
                }
            }
        }
        return null;
    }

    /**
     * Node ids to skip given the unchosen direct targets: those nodes plus,
     * transitively, any node ALL of whose predecessors are skipped. A node
     * fed by at least one live predecessor stays runnable. Ascending order.
     */
    public static function skipSet(array $unchosenIds, array $edges): array
    {
        $skipped = array_fill_keys(array_map('intval', $unchosenIds), true);
        $preds = [];
        foreach ($edges as $edge) {
            $preds[(int)$edge['to_node_id']][] = (int)$edge['from_node_id'];
        }
        do {
            $grew = false;
            foreach ($preds as $nodeId => $from) {
                if (isset($skipped[$nodeId])) continue;
                $allSkipped = true;
                foreach ($from as $p) { if (!isset($skipped[$p])) { $allSkipped = false; break; } }
                if ($allSkipped) { $skipped[$nodeId] = true; $grew = true; }
            }
        } while ($grew);
        $ids = array_keys($skipped);
        sort($ids);
        return $ids;
    }
}
