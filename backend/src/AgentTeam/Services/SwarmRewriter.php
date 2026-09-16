<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Turns a swarm canvas into the graph that actually runs.
 *
 * A swarm is the agents fanned out directly from Start (spec §3). Nothing
 * dissolves and nothing is synthesised: the members are exactly the agents
 * on the other end of Start's edges, wired into a full mesh with each other
 * plus whatever they hand off to beyond that. The Dispatcher tag belongs to
 * workflow mode; in a swarm every member routes, so the tag is refused
 * wherever it appears.
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
     * @return array ok: {ok, agents, entry} | refusal: {ok:false, error, nodes}
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

        // The Dispatcher tag belongs to workflow mode. In a swarm every member
        // routes, so the tag has no meaning here wherever it appears — including
        // on a node nothing connects to.
        $tagged = [];
        foreach ($ids as $id) {
            if ($isAgent($nodes[$id]) && $isDispatcher($nodes[$id])) {
                $tagged[] = $id;
            }
        }
        if ($tagged !== []) {
            return ['ok' => false, 'error' => 'dispatcher_in_swarm', 'nodes' => $byId($tagged)];
        }

        // The swarm is what was drawn from Start (spec §3). No node is
        // dissolved and none is synthesised: the members are exactly the
        // agents on the other end of Start's edges.
        $menu = [];
        foreach ($ids as $id) {
            if ($typeOf($nodes[$id]) !== 'start') {
                continue;
            }
            foreach ($children($id) as $c) {
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && !in_array($c, $menu, true)) {
                    $menu[] = $c;          // a doubled edge must not double a member
                }
            }
        }
        $menu = $byId($menu);
        if (count($menu) < 2) {
            return ['ok' => false, 'error' => 'start_needs_two_agents', 'nodes' => []];
        }

        // A merge is any agent with more than one agent parent: one
        // conversation cannot arrive twice.
        foreach ($ids as $id) {
            if (!$isAgent($nodes[$id])) {
                continue;
            }
            $agentParents = array_values(array_filter(
                $parents($id),
                static fn($p) => isset($nodes[$p]) && $isAgent($nodes[$p])
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
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && !in_array($c, $members, true)) {
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
            foreach ($children($id) as $c) {          // preserved edges to other agents
                if (isset($nodes[$c]) && $isAgent($nodes[$c]) && $c !== $id && !in_array($c, $handoffs, true)) {
                    $handoffs[] = $c;
                }
            }
            $handoffs = $byId($handoffs);
            $colleagues = array_map(
                static fn(string $h): array => ['name' => $nameOf($h), 'role' => $roleOf($h)],
                $handoffs
            );
            $own = (string) ($nodes[$id]['config']['instructions'] ?? '');
            $guide = $colleagues === [] ? '' : self::handoffGuide($colleagues);

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

        return [
            'ok' => true,
            'agents' => $agents,
            'entry' => $menu[0],
        ];
    }

    /**
     * The block appended to every agent that can hand off: who the colleagues
     * are, each carrying its own role summary. There is no dispatcher and no
     * shared routing prose in a swarm — each member decides for itself.
     */
    public static function handoffGuide(array $colleagues): string
    {
        // trim() here is PHP's ASCII-only default (" \t\n\r\0\x0B"); the JS
        // twin's phpTrim() must match it exactly, not .trim() (finding 7).
        $lines = ["## Colleagues you can hand this to"];
        foreach ($colleagues as $c) {
            $role = trim((string) $c['role']);
            $lines[] = '- ' . $c['name'] . ($role !== '' ? ' — ' . $role : '');
        }
        $lines[] = '';
        $lines[] = 'Hand off when the request is theirs rather than yours, and say why in the reason.';
        $lines[] = 'Answer directly when it is yours.';
        $lines[] = 'Do not hand back what you were just handed unless the subject has genuinely changed.';
        return implode("\n", $lines);
    }
}
