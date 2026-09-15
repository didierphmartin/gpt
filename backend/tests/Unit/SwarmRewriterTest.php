<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\SwarmRewriter;

/**
 * The swarm rewrite, driven by the shared contract in
 * tests/fixtures/swarm/rewrite-cases.json. The JS implementation is tested
 * against the same file; a change that satisfies one side only fails here.
 */
class SwarmRewriterTest extends TestCase
{
    /** @return array<string, array{array, array}> */
    public static function cases(): array
    {
        $raw = json_decode(file_get_contents(__DIR__ . '/../fixtures/swarm/rewrite-cases.json'), true);
        $out = [];
        foreach ($raw['cases'] as $c) {
            $out[$c['name']] = [$c['graph'], $c['expect']];
        }
        return $out;
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('cases')]
    public function testRewriteMatchesTheContract(array $graph, array $expect): void
    {
        $got = SwarmRewriter::rewrite($graph);

        if (!($expect['ok'] ?? false)) {
            $this->assertFalse($got['ok'], 'expected a refusal');
            $this->assertSame($expect['error'], $got['error']);
            $this->assertSame($expect['nodes'], array_values($got['nodes']), 'the refusal must name the offending nodes');
            return;
        }

        $this->assertTrue($got['ok'], 'expected acceptance, got: ' . ($got['error'] ?? '?'));
        // array_keys hands back ints for numeric-string keys; the fixture is JSON,
        // so its ids are strings. Compare on one side's terms, not both.
        $this->assertSame($expect['agents'], array_map('strval', array_keys($got['agents'])), 'agents, by node id');
        $this->assertSame($expect['entry'], $got['entry']);

        // handoffs as sorted [from, to] pairs
        $pairs = [];
        foreach ($got['agents'] as $id => $a) {
            foreach ($a['handoffs'] as $to) {
                $pairs[] = [(string) $id, (string) $to];
            }
        }
        sort($pairs);
        $want = $expect['handoffs'];
        sort($want);
        $this->assertSame($want, $pairs);

        foreach ($expect['guide_contains'] ?? [] as $needle) {
            $all = implode("\n", array_column($got['agents'], 'instructions'));
            $this->assertStringContainsString($needle, $all, "guide should mention: {$needle}");
        }
        foreach ($expect['tools_by_agent'] ?? [] as $id => $tools) {
            $this->assertSame($tools, $got['agents'][$id]['tools'], "tools of agent {$id}");
        }
        foreach ($expect['skills_by_agent'] ?? [] as $id => $skills) {
            $this->assertSame($skills, $got['agents'][$id]['skills'], "skills of agent {$id}");
        }
        if (isset($expect['dropped_from_dispatcher'])) {
            $this->assertSame($expect['dropped_from_dispatcher']['tools'], $got['dropped']['tools']);
            $this->assertSame($expect['dropped_from_dispatcher']['skills'], $got['dropped']['skills']);
        }
    }

    public function testTheDispatcherPersonaIsNotCarriedButItsRoutingIs(): void
    {
        $guide = SwarmRewriter::handoffGuide(
            "Greet the caller warmly and be friendly.\nWhen they mention vacations, transfer to Human resources.",
            [['name' => 'Human resources', 'role' => 'leave and payroll']]
        );
        $this->assertStringContainsString('Human resources', $guide);
        $this->assertStringContainsString('transfer to Human resources', $guide);
        $this->assertStringContainsString('Do not hand back', $guide, 'the volley guard must be present');
    }

    public function testWorkflowCarriesAnOrchestrationDefaultingToWorkflow(): void
    {
        $w = new \AgentTeam\Models\Workflow(['id' => 1, 'name' => 'x', 'user_id' => '3']);
        $this->assertSame('workflow', $w->getOrchestration(), 'default');
        $this->assertSame('workflow', $w->toArray()['orchestration'] ?? null);

        $s = new \AgentTeam\Models\Workflow(['id' => 2, 'name' => 'y', 'user_id' => '3', 'orchestration' => 'swarm']);
        $this->assertSame('swarm', $s->getOrchestration());
        $this->assertSame('swarm', $s->toArray()['orchestration'] ?? null);

        // anything unrecognised falls back rather than propagating
        $j = new \AgentTeam\Models\Workflow(['id' => 3, 'name' => 'z', 'user_id' => '3', 'orchestration' => 'nonsense']);
        $this->assertSame('workflow', $j->getOrchestration());
    }
}
