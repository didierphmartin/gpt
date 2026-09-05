<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Providers;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Providers\DeepSeekProvider;

/**
 * DeepSeek thinking mode rejects a replayed assistant tool-call turn
 * whose `reasoning_content` key is ABSENT (HTTP 400 "must be passed
 * back"), but accepts an empty string. A forced-tool turn (thinking
 * disabled) produces no reasoning, so the replay must always carry
 * the key — verified live against api.deepseek.com on 2026-09-03.
 */
class DeepSeekReplayReasoningTest extends TestCase
{
    private function build(array $history): array
    {
        $provider = new DeepSeekProvider(new Configuration(['providers' => ['deepseek' => ['api_key' => 'x']]]));
        $m = new \ReflectionMethod($provider, 'buildMessages');
        $m->setAccessible(true);
        return $m->invoke($provider, $history, 'next question', 'sys');
    }

    public function testToolCallTurnWithoutReasoningReplaysEmptyReasoningKey(): void
    {
        $messages = $this->build([
            ['role' => 'user', 'content' => 'run it'],
            ['role' => 'assistant', 'content' => '', 'tool_calls' => [['id' => 'c1', 'type' => 'function', 'function' => ['name' => 'run', 'arguments' => '{}']]]],
            ['role' => 'tool', 'tool_call_id' => 'c1', 'content' => 'ok'],
        ]);
        $assistant = array_values(array_filter($messages, fn($m) => ($m['role'] ?? '') === 'assistant'))[0];
        $this->assertArrayHasKey('reasoning_content', $assistant);
        $this->assertSame('', $assistant['reasoning_content']);
    }

    public function testToolCallTurnKeepsItsReasoning(): void
    {
        $messages = $this->build([
            ['role' => 'assistant', 'content' => '', 'reasoning_content' => 'think', 'tool_calls' => [['id' => 'c1', 'type' => 'function', 'function' => ['name' => 'run', 'arguments' => '{}']]]],
            ['role' => 'tool', 'tool_call_id' => 'c1', 'content' => 'ok'],
        ]);
        $assistant = array_values(array_filter($messages, fn($m) => ($m['role'] ?? '') === 'assistant'))[0];
        $this->assertSame('think', $assistant['reasoning_content']);
    }
}
