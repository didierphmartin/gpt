<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Models\Agent;
use AgentTeam\Services\ParallelAgentExecutor;
use PHPUnit\Framework\TestCase;
use Mockery;

class RoundSpyExecutor extends ParallelAgentExecutor
{
    public array $seenKeys = [];
    protected function dispatchChunk(array $chunk): array
    {
        $this->seenKeys[] = array_keys($chunk);
        $out = [];
        foreach ($chunk as $k => $s) {
            $out[$k] = ['success' => true, 'parsed' => ['text' => "resp-$k", 'tool_calls' => [], 'usage' => null]];
        }
        return $out;
    }
}

final class ParallelExecutorRoundReuseTest extends TestCase
{
    protected function tearDown(): void { Mockery::close(); }

    public function testRunConcurrentRoundConsumesGraphShapedStates(): void
    {
        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $db = Mockery::mock(\PDO::class);
        $exec = new RoundSpyExecutor($runner, $db, [], false);

        $agent = new Agent(['id' => 1, 'name' => 'N1', 'agent_type' => 'worker', 'provider' => 'claude']);
        $states = [
            101 => ['agent' => $agent, 'messages' => [['role' => 'user', 'content' => 'x']],
                    'tools' => [], 'force_skill' => false, 'skill_ran' => false],
            102 => ['agent' => $agent, 'messages' => [['role' => 'user', 'content' => 'y']],
                    'tools' => [], 'force_skill' => false, 'skill_ran' => false],
        ];

        $responses = $exec->runConcurrentRound($states);

        $this->assertArrayHasKey(101, $responses);
        $this->assertArrayHasKey(102, $responses);
        $this->assertTrue($responses[101]['success']);
        $this->assertSame('resp-101', $responses[101]['parsed']['text']);
        $this->assertSame([[101, 102]], $exec->seenKeys); // single window (<= cap 6), keys preserved
    }
}
