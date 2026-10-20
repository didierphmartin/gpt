<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;

final class StartOptionGraphTest extends TestCase
{
    public function testExpandedNodeCarriesTheStartTrigger(): void
    {
        $t = ['label' => 'L', 'work_exit' => 'new_mail', 'watch' => ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => []]];
        $g = \AgentTeam\Services\StartOptionGraph::expand(['nodes' => [['id' => '3', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 9]]], 'edges' => []],
            fn(int $id) => ['name' => 'C', 'code' => 'x', 'exits' => ['new_mail'], 'mcp_servers' => [], 'timeout_s' => 30, 'start_trigger' => $t]);
        self::assertSame($t, $g['nodes'][1]['config']['start_trigger']);
    }

    public function testExpandedNodeCarriesTheStartArgs(): void
    {
        $t = ['label' => 'L', 'work_exit' => 'w', 'watch' => ['server' => 'S', 'tool' => 't', 'args' => []]];
        $args = ['tag' => 'okta-reset', 'version' => 2];
        $comp = fn(int $id) => ['name' => 'C', 'code' => 'x', 'exits' => ['w'], 'mcp_servers' => [], 'timeout_s' => 30, 'start_trigger' => $t];
        $g = \AgentTeam\Services\StartOptionGraph::expand(['nodes' => [['id' => '3', 'node_type' => 'start',
            'config' => ['type' => 'start', 'start_option' => 9, 'start_args' => $args]]], 'edges' => []], $comp);
        self::assertSame($args, $g['nodes'][1]['config']['args']);
        $g = \AgentTeam\Services\StartOptionGraph::expand(['nodes' => [['id' => '3', 'node_type' => 'start',
            'config' => ['type' => 'start', 'start_option' => 9]]], 'edges' => []], $comp);
        self::assertSame([], $g['nodes'][1]['config']['args']);
    }
}
