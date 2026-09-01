<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Quantis\AIPortfolioAssistant\Playbook\{
    GateManager,
    PlaybookActionSpace,
    PlaybookDocument,
    PlaybookNativeTools,
};

final class PlaybookActionSpaceTest extends PlaybookDbTestCase
{
    private function doc(): PlaybookDocument
    {
        return PlaybookDocument::fromArray(['title' => 'T',
            'trigger' => ['kind' => 'request', 'description' => 'd'], 'instructions' => '#Resolve Request.']);
    }

    private function space(array $actions, FakeMcpExecutor $mcp, array $policy = []): PlaybookActionSpace
    {
        $native = new PlaybookNativeTools($this->state);
        return new PlaybookActionSpace($actions, $native, $mcp, $this->state, $policy + [
            'writes_enabled' => false,
            'on_unbound' => 'prompt_handoff',
        ]);
    }

    private function actions(): array
    {
        return [
            ['name' => '#Search Okta User by Email', 'kind' => 'bound', 'target' => 'okta.search_users'],
            ['name' => '#Reset Okta Password', 'kind' => 'bound', 'target' => 'okta.reset_password'],
            ['name' => '#Reset User Factors Custom', 'kind' => 'unbound', 'target' => null],
            ['name' => '#Resolve Request', 'kind' => 'native', 'target' => 'resolve_request'],
        ];
    }

    public function testDefinitionsIncludeBoundAndUnbound(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp);
        $defs = $space->toolDefinitions();
        $names = array_map(fn($d) => $d['function']['name'], $defs);

        $this->assertContains('okta__search_users', $names);
        $this->assertContains('unbound__reset_user_factors_custom', $names);
        // native tools still present
        $this->assertContains('resolve_request', $names);

        $searchDef = $defs[array_search('okta__search_users', $names, true)];
        $this->assertStringContainsString('#Search Okta User by Email', $searchDef['function']['description']);
        $this->assertSame(
            ['email' => ['type' => 'string']],
            $searchDef['function']['parameters']['properties']
        );

        $unboundDef = $defs[array_search('unbound__reset_user_factors_custom', $names, true)];
        $this->assertStringContainsString('NOT AVAILABLE', $unboundDef['function']['description']);
        $this->assertSame(['type' => 'object', 'properties' => []], $unboundDef['function']['parameters']);
    }

    public function testWhitelistRejectsUnknownName(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'some_made_up_tool', []);
        $this->assertFalse($result['ok']);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('skipped', $ledger[0]['outcome']);
    }

    public function testMcpDispatchMapsToServerAndTool(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'okta__search_users', ['email' => 'a@b.com']);
        $this->assertTrue($result['ok']);
        $this->assertCount(1, $mcp->calls);
        $this->assertSame('okta', $mcp->calls[0]['server']);
        $this->assertSame('search_users', $mcp->calls[0]['tool']);
        $this->assertSame(['email' => 'a@b.com'], $mcp->calls[0]['args']);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('ok', $ledger[0]['outcome']);
        $this->assertSame('okta.search_users', $ledger[0]['tool']);
    }

    public function testReplayGuardAvoidsSecondMcpCall(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $first = $space->execute($id, 0, 'okta__search_users', ['email' => 'a@b.com']);
        $this->assertTrue($first['ok']);

        $second = $space->execute($id, 1, 'okta__search_users', ['email' => 'a@b.com']);
        $this->assertTrue($second['ok']);
        $this->assertSame('replayed', $second['outcome']);

        // Fake recorded only ONE real call
        $this->assertCount(1, $mcp->calls);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(2, $ledger);
        $this->assertSame('ok', $ledger[0]['outcome']);
        $this->assertSame('replayed', $ledger[1]['outcome']);
    }

    public function testWritePolicyBlocksWhenDisabled(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp, ['writes_enabled' => false]);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'okta__reset_password', ['user_id' => '123']);
        $this->assertFalse($result['ok']);
        $this->assertSame('writes disabled by policy', $result['error']);
        $this->assertCount(0, $mcp->calls);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('skipped', $ledger[0]['outcome']);
    }

    public function testWritePolicyAllowsWhenEnabled(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp, ['writes_enabled' => true]);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'okta__reset_password', ['user_id' => '123']);
        $this->assertTrue($result['ok']);
        $this->assertCount(1, $mcp->calls);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('ok', $ledger[0]['outcome']);
    }

    public function testUnboundExecuteReturnsGuidance(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp, ['on_unbound' => 'prompt_handoff']);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'unbound__reset_user_factors_custom', []);
        $this->assertFalse($result['ok']);
        $this->assertTrue($result['unbound']);
        $this->assertSame('prompt_handoff', $result['policy']);
        $this->assertStringContainsString('hand off to a human', $result['guidance']);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('skipped', $ledger[0]['outcome']);
    }

    public function testNativeToolStillExecutesThroughActionSpace(): void
    {
        $mcp = new FakeMcpExecutor();
        $space = $this->space($this->actions(), $mcp);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'resolve_request', ['outcome' => 'success', 'summary' => 'done']);
        $this->assertTrue($result['ok']);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('ok', $ledger[0]['outcome']);
        $this->assertSame('resolve_request', $ledger[0]['tool']);
    }

    public function testNativeVerbNeverBlockedByWritePolicy(): void
    {
        // Controller ruling: the write policy governs MCP/connector writes only. Native verbs
        // act on our own run record and must never be blocked, even with writes_enabled=false.
        $mcp = new FakeMcpExecutor();
        $actions = array_merge($this->actions(), [
            ['name' => '#Send Direct Message', 'kind' => 'native', 'target' => 'send_direct_message'],
        ]);
        $space = $this->space($actions, $mcp, ['writes_enabled' => false]);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'send_direct_message', ['text' => 'hello']);
        $this->assertTrue($result['ok']);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('ok', $ledger[0]['outcome']);
    }

    public function testSensitiveNativeArgsAreRedactedInLedger(): void
    {
        $mcp = new FakeMcpExecutor();
        $actions = array_merge($this->actions(), [
            ['name' => '#Send Direct Message', 'kind' => 'native', 'target' => 'send_direct_message'],
        ]);
        $space = $this->space($actions, $mcp);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'send_direct_message', [
            'text' => 'Secret token 12345',
            'sensitive' => true,
        ]);
        $this->assertTrue($result['ok']);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame(1, (int)$ledger[0]['sensitive']);
        $this->assertStringNotContainsString('Secret token', $ledger[0]['args']);
        $this->assertStringContainsString('«redacted»', $ledger[0]['args']);
        $this->assertSame('«redacted»', $ledger[0]['result_summary']);
    }

    public function testAgentBoundTargetTreatedAsUnboundForNow(): void
    {
        $mcp = new FakeMcpExecutor();
        $actions = [
            ['name' => '#Escalate to Triage Agent', 'kind' => 'bound', 'target' => 'agent.triage'],
        ];
        $space = $this->space($actions, $mcp);
        $defs = $space->toolDefinitions();
        $names = array_map(fn($d) => $d['function']['name'], $defs);
        $this->assertContains('unbound__escalate_to_triage_agent', $names);

        $id = $this->state->createRun(1, $this->doc(), [], []);
        $result = $space->execute($id, 0, 'unbound__escalate_to_triage_agent', []);
        $this->assertFalse($result['ok']);
        $this->assertTrue($result['unbound']);
    }

    public function testGateTimeoutIsLedgeredAsFailedNotOk(): void
    {
        $mcp = new FakeMcpExecutor();
        $native = new PlaybookNativeTools($this->state);
        $bridge = new FakeGateBridge([]); // empty queue => ask() returns null (timeout)
        $gates = new GateManager($this->state, $bridge);
        $space = new PlaybookActionSpace($this->actions(), $native, $mcp, $this->state, [
            'writes_enabled' => false, 'on_unbound' => 'prompt_handoff',
        ], $gates);
        $id = $this->state->createRun(1, $this->doc(), [], []);

        $result = $space->execute($id, 0, 'request_approval', [
            'approver' => 'mgr', 'question' => 'reset the password?',
        ]);

        $this->assertFalse($result['ok']);
        $this->assertTrue($result['timeout']);
        $this->assertTrue($result['gate']);

        $ledger = $this->state->ledgerAll($id);
        $this->assertCount(1, $ledger);
        $this->assertSame('failed', $ledger[0]['outcome']);
        $this->assertStringContainsString('timeout', $ledger[0]['result_summary']);
    }
}
