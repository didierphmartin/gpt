<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Models\Agent;
use AgentTeam\Services\ParallelAgentExecutor;
use PHPUnit\Framework\TestCase;
use Mockery;

/** Executor subclass with the curl round replaced by a scripted fake. */
class FakeExecutor extends ParallelAgentExecutor
{
    /** @var array<int, array<string,array>> round index => (key => response) */
    public array $script = [];
    public int $round = 0;
    public array $seenBatchSizes = [];

    protected function callLLMs(array $states): array
    {
        $this->seenBatchSizes[] = count($states);
        $out = $this->script[$this->round] ?? [];
        $this->round++;
        // Only answer the keys still pending this round.
        return array_intersect_key($out, $states);
    }
}

final class ParallelAgentExecutorTest extends TestCase
{
    protected function tearDown(): void { Mockery::close(); }

    private function agent(int $id, string $name): Agent
    {
        return new Agent(['id' => $id, 'name' => $name, 'agent_type' => 'worker',
            'provider' => 'claude', 'instructions' => 'x']);
    }

    private function makeExecutor(): FakeExecutor
    {
        // ToolsManager stub: echoes a fixed result for any server tool.
        // Mocked against the real class (not a bare Mockery::mock()) because
        // AgentRunner::getToolsManager(): ToolsManager and
        // ToolsManager::execute(): array are both return-typed; a loose
        // double or a string return would trip a PHP TypeError at the
        // Mockery-generated method boundary.
        $tools = Mockery::mock(\Quantis\AIPortfolioAssistant\Services\ToolsManager::class);
        $tools->shouldReceive('execute')->andReturn(['result' => 'TOOL_OK']);
        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $runner->shouldReceive('getToolsManager')->andReturn($tools);
        $db = Mockery::mock(\PDO::class);
        // recordExecutions=false, no observer, no client bridge.
        return new FakeExecutor($runner, $db, [], false, null, null);
    }

    public function testTwoAgentsCompleteConcurrentlyInOneRound(): void
    {
        $exec = $this->makeExecutor();
        $exec->script = [
            0 => [
                'a' => ['success' => true, 'parsed' => ['text' => 'A done', 'tool_calls' => [], 'usage' => null]],
                'b' => ['success' => true, 'parsed' => ['text' => 'B done', 'tool_calls' => [], 'usage' => null]],
            ],
        ];
        $states = [
            ['key' => 'a', 'agent' => $this->agent(1, 'A'), 'input' => 'ta',
             'messages' => [['role' => 'user', 'content' => 'ta']], 'tools' => [], 'tools_filter' => null],
            ['key' => 'b', 'agent' => $this->agent(2, 'B'), 'input' => 'tb',
             'messages' => [['role' => 'user', 'content' => 'tb']], 'tools' => [], 'tools_filter' => null],
        ];
        $res = $exec->run($states);

        $this->assertTrue($res['a']['success']);
        $this->assertSame('A done', $res['a']['output']);
        $this->assertTrue($res['b']['success']);
        $this->assertSame('B done', $res['b']['output']);
        // Both were dispatched in the SAME batch (concurrency, not sequential).
        $this->assertSame([2], $exec->seenBatchSizes);
    }

    public function testToolCallDrivesAnotherRound(): void
    {
        $exec = $this->makeExecutor();
        $exec->script = [
            0 => ['a' => ['success' => true, 'parsed' => ['text' => null, 'usage' => null,
                'tool_calls' => [['id' => 't1', 'function' => ['name' => 'search', 'arguments' => '{}']]]]]],
            1 => ['a' => ['success' => true, 'parsed' => ['text' => 'final', 'tool_calls' => [], 'usage' => null]]],
        ];
        $states = [
            ['key' => 'a', 'agent' => $this->agent(1, 'A'), 'input' => 'ta',
             'messages' => [['role' => 'user', 'content' => 'ta']], 'tools' => [], 'tools_filter' => null],
        ];
        $res = $exec->run($states);

        $this->assertSame('final', $res['a']['output']);
        $this->assertSame(2, $exec->round); // took two rounds
    }
}
