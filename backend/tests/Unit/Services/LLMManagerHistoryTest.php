<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Services\LLMManager;

/**
 * DeepSeek thinking mode rejects a tool-round replay unless the
 * assistant turn that made the tool calls still carries its
 * reasoning_content. The history normalizer must not drop it.
 */
class LLMManagerHistoryTest extends TestCase
{
    public function testAssistantToolCallTurnKeepsReasoningContent(): void
    {
        $manager = new LLMManager(new Configuration([]));
        $history = [
            ['role' => 'user', 'content' => 'Create a playbook'],
            [
                'role' => 'assistant',
                'content' => '',
                'reasoning_content' => 'I should discover the skill first.',
                'tool_calls' => [['id' => 'c1', 'type' => 'function', 'function' => ['name' => 'discover_skill', 'arguments' => '{}']]],
            ],
            ['role' => 'tool', 'tool_call_id' => 'c1', 'content' => '{"ok":true}'],
        ];

        $out = $manager->normalizeConversationHistory($history);

        $this->assertSame('assistant', $out[1]['role']);
        $this->assertSame('I should discover the skill first.', $out[1]['reasoning_content'] ?? null);
        $this->assertSame('c1', $out[1]['tool_calls'][0]['id']);
    }

    public function testAssistantToolCallTurnWithoutReasoningHasNoKey(): void
    {
        $manager = new LLMManager(new Configuration([]));
        $out = $manager->normalizeConversationHistory([
            ['role' => 'assistant', 'content' => '', 'tool_calls' => [['id' => 'c1', 'type' => 'function', 'function' => ['name' => 'x', 'arguments' => '{}']]]],
        ]);
        $this->assertArrayNotHasKey('reasoning_content', $out[0]);
    }
}
