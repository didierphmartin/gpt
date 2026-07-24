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

/**
 * Executor subclass that fakes the network at the CHUNK boundary (not the
 * whole round) so the real callLLMs() chunking/cap/key-preservation logic is
 * exercised. Records the keys and size of every chunk dispatchChunk() sees.
 */
class ChunkSpyExecutor extends ParallelAgentExecutor
{
    /** @var array<int, array<int,string>> chunk index => list of keys seen */
    public array $seenChunkKeys = [];
    public array $seenChunkSizes = [];

    protected function dispatchChunk(array $chunk): array
    {
        $this->seenChunkKeys[] = array_keys($chunk);
        $this->seenChunkSizes[] = count($chunk);
        // Canned "completed" response (no tool calls) for every key in the chunk,
        // preserving the chunk's keys so callLLMs()'s union merge is meaningful.
        $out = [];
        foreach ($chunk as $key => $state) {
            $out[$key] = ['success' => true, 'parsed' =>
                ['text' => (string) $key . ' done', 'tool_calls' => [], 'usage' => null]];
        }
        return $out;
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

    private function makeChunkSpy(int $maxConcurrency): ChunkSpyExecutor
    {
        $tools = Mockery::mock(\Quantis\AIPortfolioAssistant\Services\ToolsManager::class);
        $runner = Mockery::mock(\AgentTeam\Services\AgentRunner::class);
        $runner->shouldReceive('getToolsManager')->andReturn($tools);
        $db = Mockery::mock(\PDO::class);
        // 7th ctor arg is the concurrency cap.
        return new ChunkSpyExecutor($runner, $db, [], false, null, null, $maxConcurrency);
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

    /**
     * Exercises the REAL callLLMs() chunking so the concurrency cap and
     * array_chunk(preserve_keys) are covered. Overriding dispatchChunk (not
     * callLLMs) leaves the cap/merge logic live. maxConcurrency=2 with three
     * string-keyed states must split into chunks of [2,1] with keys preserved
     * (['a','b'] then ['c'], NOT renumbered 0,1,2), and run() must return all
     * three keyed results.
     */
    public function testConcurrencyCapChunksStatesAndPreservesKeys(): void
    {
        $exec = $this->makeChunkSpy(2);
        $states = [];
        foreach (['a', 'b', 'c'] as $i => $key) {
            $states[] = ['key' => $key, 'agent' => $this->agent($i + 1, strtoupper($key)),
                'input' => "t{$key}",
                'messages' => [['role' => 'user', 'content' => "t{$key}"]],
                'tools' => [], 'tools_filter' => null];
        }
        $res = $exec->run($states);

        // Two chunks: first two keys, then the remaining one (the cap).
        $this->assertSame([2, 1], $exec->seenChunkSizes);
        $this->assertSame([['a', 'b'], ['c']], $exec->seenChunkKeys);
        // All three completed, keyed by their original string keys (preserve_keys).
        $this->assertSame(['a', 'b', 'c'], array_keys($res));
        $this->assertSame('a done', $res['a']['output']);
        $this->assertSame('b done', $res['b']['output']);
        $this->assertSame('c done', $res['c']['output']);
        $this->assertTrue($res['a']['success'] && $res['b']['success'] && $res['c']['success']);
    }
}
