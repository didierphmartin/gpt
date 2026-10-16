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
}
