<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\DispatchRouting;
use AgentTeam\Services\GraphWorkflowRunner;

/**
 * Dispatcher agents: outgoing edges are a MENU of branches the model picks
 * from by name (route_to), never a parallel fan-out. Exactly one branch runs;
 * the others (and anything reachable only through them) are skipped.
 */
class DispatchRoutingTest extends TestCase
{
    /** Start(1) → Dispatcher(2) → {Sales(3), Billing(4)}; Sales→Followup(5); {Followup, Billing}→Output(6) */
    private function graph(): array
    {
        $nodes = [
            1 => ['id' => 1, 'node_type' => 'start', 'config' => []],
            2 => ['id' => 2, 'node_type' => 'agent', 'config' => ['agent_name' => 'Receptionist']],
            3 => ['id' => 3, 'node_type' => 'agent', 'config' => ['agent_name' => 'Sales']],
            4 => ['id' => 4, 'node_type' => 'agent', 'config' => ['name' => 'Billing']],
            5 => ['id' => 5, 'node_type' => 'agent', 'config' => ['agent_name' => 'Followup']],
            6 => ['id' => 6, 'node_type' => 'output', 'config' => []],
        ];
        $e = fn(int $f, int $t) => ['from_node_id' => $f, 'to_node_id' => $t];
        $edges = [$e(1, 2), $e(2, 3), $e(2, 4), $e(3, 5), $e(5, 6), $e(4, 6)];
        return [$nodes, $edges];
    }

    public function testTargetsAreDownstreamAgentNodesByName(): void
    {
        [$nodes, $edges] = $this->graph();
        $t = DispatchRouting::targets(2, $edges, $nodes);
        $this->assertSame([['id' => 3, 'name' => 'Sales'], ['id' => 4, 'name' => 'Billing']], $t);
        // The output node is not a target
        $this->assertSame([], DispatchRouting::targets(5, $edges, $nodes));
    }

    public function testToolDefinitionEnumeratesTargetNames(): void
    {
        [$nodes, $edges] = $this->graph();
        $def = DispatchRouting::toolDefinition(DispatchRouting::targets(2, $edges, $nodes));
        $this->assertSame('route_to', $def['name']);
        $this->assertSame(['Sales', 'Billing'], $def['input_schema']['properties']['target']['enum']);
        $this->assertSame(['target'], $def['input_schema']['required']);
        $this->assertArrayHasKey('notes', $def['input_schema']['properties']);
    }

    public function testPromptBlockNamesEveryTargetAndTheTool(): void
    {
        [$nodes, $edges] = $this->graph();
        $p = DispatchRouting::promptBlock(DispatchRouting::targets(2, $edges, $nodes));
        $this->assertStringContainsString('Sales', $p);
        $this->assertStringContainsString('Billing', $p);
        $this->assertStringContainsString('route_to', $p);
    }

    public function testResolveMatchesTargetNameCaseInsensitively(): void
    {
        [$nodes, $edges] = $this->graph();
        $targets = DispatchRouting::targets(2, $edges, $nodes);
        $calls = [['name' => 'route_to', 'input' => ['target' => 'billing', 'notes' => 'invoice #42']]];
        $this->assertSame(['id' => 4, 'name' => 'Billing', 'notes' => 'invoice #42'], DispatchRouting::resolve($calls, $targets));
        $this->assertNull(DispatchRouting::resolve([['name' => 'route_to', 'input' => ['target' => 'Legal']]], $targets));
        $this->assertNull(DispatchRouting::resolve([], $targets));
        $this->assertNull(DispatchRouting::resolve([['name' => 'run_skill_script', 'input' => []]], $targets));
    }

    public function testSkipSetCascadesThroughBranchesReachableOnlyViaSkippedNodes(): void
    {
        [$nodes, $edges] = $this->graph();
        // Chose Billing(4): Sales(3) skipped, Followup(5) only reachable via Sales → skipped;
        // Output(6) also fed by Billing → NOT skipped.
        $this->assertSame([3, 5], DispatchRouting::skipSet([3], $edges));
        // Chose Sales(3): only Billing(4) skipped; Output(6) still fed by Followup.
        $this->assertSame([4], DispatchRouting::skipSet([4], $edges));
    }

    public function testDefaultInstructionsNameTheAgentInsteadOfInheritingAPersona(): void
    {
        $p = DispatchRouting::defaultInstructions('Human resources', 'HR desk', 'Dispatcher demo');
        $this->assertStringContainsString('You are "Human resources"', $p);
        $this->assertStringContainsString('HR desk', $p);
        $this->assertStringContainsString('Dispatcher demo', $p);
        // No description → still a usable prompt
        $this->assertStringContainsString('You are "IT claims"', DispatchRouting::defaultInstructions('IT claims', '', 'wf'));
    }

    public function testRoutedPromptTellsTheTargetWhoSentItAndNotToReroute(): void
    {
        $p = DispatchRouting::routedPrompt('Human resources', 'techBuddy', 'vacation question');
        $this->assertStringContainsString('## Routed request', $p);
        $this->assertStringContainsString('techBuddy', $p);
        $this->assertStringContainsString('vacation question', $p);
        $this->assertStringContainsString('Do not redirect', $p);
        $this->assertStringNotContainsString('Notes', DispatchRouting::routedPrompt('X', 'Y', ''));
    }

    public function testRoutedByFindsTheDispatcherThatChoseThisNode(): void
    {
        [$nodes, $edges] = $this->graph();
        $outputs = [2 => ['agent_name' => 'Receptionist', 'route' => ['id' => 4, 'name' => 'Billing', 'notes' => 'invoice']]];
        $this->assertSame(['from' => 'Receptionist', 'notes' => 'invoice'], DispatchRouting::routedBy(4, $edges, $outputs));
        $this->assertNull(DispatchRouting::routedBy(3, $edges, $outputs)); // Sales was not chosen
        $this->assertNull(DispatchRouting::routedBy(4, $edges, []));        // no dispatcher ran
    }

    public function testRunnerApplyRouteQueuesOnlyChosenAndMarksSkippedAsDone(): void
    {
        [$nodes, $edges] = $this->graph();
        $ref = new \ReflectionClass(GraphWorkflowRunner::class);
        $runner = $ref->newInstanceWithoutConstructor();
        $m = $ref->getMethod('applyRoute');
        $m->setAccessible(true);

        $queue = [];
        $executed = [1, 2];
        $output = ['type' => 'agent', 'route' => ['id' => 4, 'name' => 'Billing', 'notes' => '']];
        $routed = $m->invokeArgs($runner, [2, $output, $edges, &$queue, &$executed]);

        $this->assertTrue($routed);
        $this->assertSame([4], $queue);
        // Skipped nodes count as done so the merge at Output(6) is not blocked.
        $this->assertSame([1, 2, 3, 5], $executed);

        // A plain agent output is not a route.
        $q2 = []; $ex2 = [1, 2];
        $this->assertFalse($m->invokeArgs($runner, [2, ['type' => 'agent', 'output' => 'hi'], $edges, &$q2, &$ex2]));
        $this->assertSame([], $q2);
    }
}
