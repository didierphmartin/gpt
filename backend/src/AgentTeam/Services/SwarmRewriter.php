<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Turns a swarm canvas into the graph that actually runs.
 *
 * A swarm is exactly the agents fanned out directly from Start (spec §3),
 * wired into a full mesh with each other and nothing else. An agent not
 * connected to Start is refused rather than absorbed: every agent in a
 * swarm can hand to every other, so a partial mesh (a member's child
 * reachable only through its parent) would contradict that. The Dispatcher
 * tag belongs to workflow mode; in a swarm every member routes, so the tag
 * is refused wherever it appears.
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

        // Every agent in the swarm can hand to every other (spec, revised).
        // An agent connected to a member but not to Start — "connected to
        // Start" means Start has an edge TO it, not merely a path from it —
        // would otherwise be reachable only through that one parent, a
        // partial mesh the owner has ruled out. Refuse it by name rather
        // than silently absorbing or dropping it.
        $notOnStart = [];
        foreach ($ids as $id) {
            if ($isAgent($nodes[$id]) && !in_array($id, $menu, true)) {
                $notOnStart[] = $id;
            }
        }
        if ($notOnStart !== []) {
            return ['ok' => false, 'error' => 'agent_not_on_start', 'nodes' => $byId($notOnStart)];
        }

        // --- the rewrite ---
        // The swarm is exactly the menu: no absorption, no transitive walk.
        $members = $menu;

        // Only a non-empty STRING counts as a name. Casting whatever is there
        // diverges from the JS twin on non-strings — PHP renders false as ""
        // and JS as "false" — and the two must agree byte for byte.
        $nameOf = static function (string $id) use ($nodes): string {
            foreach (['agent_name', 'name'] as $k) {
                $v = $nodes[$id]['config'][$k] ?? null;
                if (is_string($v) && $v !== '') {
                    return $v;
                }
            }
            return "node {$id}";
        };
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
            foreach ($menu as $other) {               // the full mesh
                if ($other !== $id) {
                    $handoffs[] = $other;
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
                // A genuine list or nothing. `(array)` would turn an object or a
                // scalar into a one-or-more element list here while the JS twin
                // throws or splits a string into characters.
                'tools' => self::toolList($nodes[$id]['config']['tools'] ?? null),
                // Presence, not truthiness: PHP treats the string "0" as false
                // and JS does not.
                'skills' => self::hasSkill($skills) ? [$skills] : [],
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
    /** A genuine list, or nothing. Must match swarm-rewrite.js's Array.isArray check. */
    private static function toolList(mixed $v): array
    {
        return is_array($v) && array_is_list($v) ? $v : [];
    }

    /** Presence, not truthiness — PHP's "0" is falsy and JS's is not. */
    private static function hasSkill(mixed $v): bool
    {
        return $v !== null && $v !== '' && $v !== false;
    }

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
