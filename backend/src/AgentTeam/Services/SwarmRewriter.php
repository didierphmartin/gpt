<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Turns a swarm canvas into the graph that actually runs.
 *
 * A swarm is drawn as a node tagged Dispatcher fanning out to two or more
 * agents. The dispatcher is scaffolding: a swarm routes itself, so the node
 * is NOT compiled as an agent. Its children become the swarm, wired to each
 * other, carrying its routing prompt as their shared handoff guide.
 *
 * Pure: no I/O, no randomness, no state. The JS twin in
 * frontend/assets/js/swarm-rewrite.js must produce the same result, and
 * tests/fixtures/swarm/rewrite-cases.json is the contract both satisfy.
 */
class SwarmRewriter
{
    /** Handoffs beyond this end a run; mirrored in the interpreter. */
    public const HOP_BUDGET = 25;

    /**
     * @param array $graph {nodes: [...], edges: [...]}
     * @return array ok: {ok, agents, entry, dropped} | refusal: {ok:false, error, nodes}
     */
    public static function rewrite(array $graph): array
    {
        // PHP coerces numeric-string array keys to int, so read ids back out
        // as strings everywhere: an int 3 never === the string "3" an edge
        // carries, and the mismatch is silent.
        $nodes = [];
        $ids = [];
        foreach ($graph['nodes'] ?? [] as $n) {
            $id = (string) $n['id'];
            $nodes[$id] = $n;
            $ids[] = $id;
        }
        $edges = [];
        foreach ($graph['edges'] ?? [] as $e) {
            $edges[] = [(string) ($e['from'] ?? $e['from_node_id'] ?? ''), (string) ($e['to'] ?? $e['to_node_id'] ?? '')];
        }

        // Every returned list is ordered by node id, never by insertion:
        // PHP keeps insertion order and JS does not, and the two must agree.
        // Numeric-string ids sort numerically; anything else falls back to a
        // plain byte-order compare. This tiebreak must match the JS twin
        // exactly, so it is strcmp(), never localeCompare() (locale-aware,
        // decides non-numeric ties differently) — and the "is this numeric"
        // test is a literal /^\d+$/, never PHP's (int) cast vs JS's Number(),
        // which disagree with each other on strings like "a".
        $byId = static function (array $list): array {
            usort($list, static function ($a, $b) {
                $as = (string) $a;
                $bs = (string) $b;
                $an = (bool) preg_match('/^\d+$/', $as);
                $bn = (bool) preg_match('/^\d+$/', $bs);
                return ($an && $bn) ? ((int) $as <=> (int) $bs) : strcmp($as, $bs);
            });
            return array_values($list);
        };
        $children = static function (string $id) use ($edges): array {
            $out = [];
            foreach ($edges as [$f, $t]) {
                if ($f === $id) {
                    $out[] = $t;
                }
            }
            return $out;
        };
        $parents = static function (string $id) use ($edges): array {
            $out = [];
            foreach ($edges as [$f, $t]) {
                if ($t === $id) {
                    $out[] = $f;
                }
            }
            return $out;
        };
        $typeOf = static fn(array $n): string => (string) ($n['config']['type'] ?? $n['node_type'] ?? '');
        $isAgent = static fn(array $n): bool => in_array($typeOf($n), ['agent', 'agent-template'], true);
        $isDispatcher = static fn(array $n): bool => ($n['config']['agent_type'] ?? '') === 'dispatcher';

        // --- refusals, in the order a user is most likely to hit them ---
        $playbooks = [];
        $outputs = [];
        foreach ($ids as $id) {
            if ($typeOf($nodes[$id]) === 'playbook') {
                $playbooks[] = $id;
            }
            if ($typeOf($nodes[$id]) === 'output') {
                $outputs[] = $id;
            }
        }
        if ($playbooks !== []) {
            return ['ok' => false, 'error' => 'playbook_unsupported', 'nodes' => $byId($playbooks)];
        }
        if (count($outputs) > 1) {
            return ['ok' => false, 'error' => 'multiple_outputs', 'nodes' => $byId($outputs)];
        }

        $dispatchers = [];
        foreach ($ids as $id) {
            if ($isAgent($nodes[$id]) && $isDispatcher($nodes[$id])) {
                $dispatchers[] = $id;
            }
        }
        if (count($dispatchers) > 1) {
            return ['ok' => false, 'error' => 'nested_dispatchers', 'nodes' => $byId($dispatchers)];
        }
        if ($dispatchers === []) {
            return ['ok' => false, 'error' => 'no_dispatcher', 'nodes' => []];
        }
        $dispatcherId = $dispatchers[0];

        $entryTargets = [];
        foreach ($ids as $id) {
            if ($typeOf($nodes[$id]) !== 'start') {
                continue;
            }
            foreach ($children($id) as $c) {
                $entryTargets[] = $c;
            }
        }
        $entryTargets = $byId(array_unique($entryTargets));
        if (count($entryTargets) > 1) {
            return ['ok' => false, 'error' => 'two_entry_points', 'nodes' => $entryTargets];
        }

        // A self-edge on the dispatcher must not put it in its own menu (it
        // stays dissolved, spec §3b), and a duplicated Dispatcher->X edge
        // must not count X twice.
        $menu = $byId(array_unique(array_values(array_filter(
            $children($dispatcherId),
            static fn($c) => isset($nodes[$c]) && $isAgent($nodes[$c]) && $c !== $dispatcherId
        ))));
        if (count($menu) < 2) {
            return ['ok' => false, 'error' => 'dispatcher_needs_two_children', 'nodes' => [$dispatcherId]];
        }

        // A merge is any agent with more than one agent parent once the
        // dispatcher is removed: one conversation cannot arrive twice.
        foreach ($ids as $id) {
            if (!$isAgent($nodes[$id])) {
                continue;
            }
            $agentParents = array_values(array_filter(
                $parents($id),
                static fn($p) => $p !== $dispatcherId && isset($nodes[$p]) && $isAgent($nodes[$p])
            ));
            if (count($agentParents) > 1) {
                return ['ok' => false, 'error' => 'merge_node', 'nodes' => [$id]];
            }
        }

        // --- the rewrite ---
        // Walk outward from the menu: any agent reachable from a swarm member
        // is itself a member. Absorbing only the menu's direct children is not
        // enough — a member's child may have its own child, and then that
        // grandchild is a handoff target with no agent behind it, which the
        // interpreter would dereference and crash on. The loop re-reads
        // count($members) each pass, so newly absorbed members are walked too.
        $members = $menu;                                   // the swarm proper
        for ($i = 0; $i < count($members); $i++) {
            foreach ($children($members[$i]) as $c) {
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && $c !== $dispatcherId && !in_array($c, $members, true)) {
                    $members[] = $c;
                }
            }
        }
        $members = $byId($members);

        $nameOf = static fn(string $id): string => (string) ($nodes[$id]['config']['agent_name'] ?? $nodes[$id]['config']['name'] ?? "node {$id}");
        // PHP's trim()/rtrim() default charlist is " \t\n\r\0\x0B" (ASCII
        // only) and every trim() below relies on that. The JS twin uses its
        // own phpTrim() helper — never .trim() or /\s/ — to strip the
        // identical fixed set; those are Unicode-aware and also eat things
        // like U+00A0 NBSP, which would diverge from PHP here (finding 7).
        $roleOf = static function (string $id) use ($nodes): string {
            $text = trim((string) ($nodes[$id]['config']['instructions'] ?? ''));
            $first = trim(explode("\n", $text)[0] ?? '');
            // Truncate by codepoint (mb_substr), never by byte or UTF-16 unit.
            // The JS twin truncates via Array.from(...).slice(0,120) to match
            // this exactly — plain .slice(0,120) there would count UTF-16
            // units and can split an astral codepoint's surrogate pair.
            return mb_substr($first, 0, 120);
        };

        $agents = [];
        foreach ($members as $id) {
            $handoffs = [];
            if (in_array($id, $menu, true)) {
                foreach ($menu as $other) {           // the synthesised mesh
                    if ($other !== $id) {
                        $handoffs[] = $other;
                    }
                }
            }
            foreach ($children($id) as $c) {          // preserved edges to non-dispatcher agents
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && $c !== $dispatcherId && $c !== $id && !in_array($c, $handoffs, true)) {
                    $handoffs[] = $c;
                }
            }
            $handoffs = $byId($handoffs);
            $colleagues = array_map(
                static fn(string $h): array => ['name' => $nameOf($h), 'role' => $roleOf($h)],
                $handoffs
            );
            $own = (string) ($nodes[$id]['config']['instructions'] ?? '');
            $guide = $colleagues === []
                ? ''
                : self::handoffGuide((string) ($nodes[$dispatcherId]['config']['instructions'] ?? ''), $colleagues);

            $skills = $nodes[$id]['config']['bound_skill'] ?? null;
            // rtrim()'s default charlist is " \t\n\r\0\x0B" (ASCII only). The
            // JS twin strips the identical fixed set, never JS's Unicode-
            // aware \s (which also eats U+00A0 NBSP and would diverge here).
            $agents[$id] = [
                'id' => $id,
                'name' => $nameOf($id),
                'instructions' => $guide === '' ? $own : rtrim($own) . "\n\n" . $guide,
                'tools' => array_values((array) ($nodes[$id]['config']['tools'] ?? [])),
                'skills' => $skills ? [$skills] : [],
                'handoffs' => $handoffs,
            ];
        }

        $dispatcherCfg = $nodes[$dispatcherId]['config'] ?? [];
        return [
            'ok' => true,
            'agents' => $agents,
            'entry' => $menu[0],
            'dropped' => [
                'tools' => count((array) ($dispatcherCfg['tools'] ?? [])),
                'skills' => isset($dispatcherCfg['bound_skill']) ? 1 : 0,
            ],
        ];
    }

    /**
     * The block appended to every agent that can hand off: who the colleagues
     * are, and the dispatcher's routing rules, which say which subject belongs
     * to whom. The dispatcher's persona is deliberately not carried — nothing
     * speaks with that voice in a swarm.
     */
    public static function handoffGuide(string $dispatcherInstructions, array $colleagues): string
    {
        // trim() here is PHP's ASCII-only default (" \t\n\r\0\x0B"); the JS
        // twin's phpTrim() must match it exactly, not .trim() (finding 7).
        $lines = ["## Colleagues you can hand this to"];
        foreach ($colleagues as $c) {
            $role = trim((string) $c['role']);
            $lines[] = '- ' . $c['name'] . ($role !== '' ? ' — ' . $role : '');
        }
        $routing = trim($dispatcherInstructions);
        if ($routing !== '') {
            $lines[] = '';
            $lines[] = '## When to hand off';
            $lines[] = $routing;
        }
        $lines[] = '';
        $lines[] = 'Hand off when the request is theirs rather than yours, and say why in the reason.';
        $lines[] = 'Answer directly when it is yours.';
        $lines[] = 'Do not hand back what you were just handed unless the subject has genuinely changed.';
        return implode("\n", $lines);
    }
}
