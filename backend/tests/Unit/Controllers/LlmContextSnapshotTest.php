<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\ChatController;

/**
 * The "Context" tab shows exactly what a workflow node sent to the LLM:
 * provider/model, the final system prompt, the messages, the tool
 * definitions actually offered (server + client), and a token estimate.
 */
class LlmContextSnapshotTest extends TestCase
{
    public function testSnapshotListsWhatWasSent(): void
    {
        $options = [
            'system_prompt' => 'You are a dispatcher.',
            'client_tools' => [['name' => 'route_to', 'description' => 'Route it', 'input_schema' => ['type' => 'object']]],
            'max_tokens' => 4096,
            'temperature' => 0.7,
        ];
        $serverTools = [['name' => 'mcp_lookup_users', 'description' => 'Look up', 'input_schema' => []]];
        $history = [['role' => 'user', 'content' => 'earlier'], ['role' => 'assistant', 'content' => 'ok']];

        $snap = ChatController::buildLlmContextSnapshot('claude', 'claude-sonnet-4-5', $options, $serverTools, $history, 'refund please');

        $this->assertSame('claude', $snap['provider']);
        $this->assertSame('claude-sonnet-4-5', $snap['model']);
        $this->assertSame('You are a dispatcher.', $snap['system_prompt']);
        $this->assertSame(4096, $snap['max_tokens']);
        $this->assertSame(0.7, $snap['temperature']);
        $this->assertSame(['user', 'assistant', 'user'], array_column($snap['messages'], 'role'));
        $this->assertSame('refund please', end($snap['messages'])['content']);
        $this->assertSame([['name' => 'mcp_lookup_users', 'description' => 'Look up', 'source' => 'server'],
                           ['name' => 'route_to', 'description' => 'Route it', 'source' => 'client']], $snap['tools']);
        $this->assertGreaterThan(0, $snap['estimated_tokens']);
        $this->assertFalse($snap['memory_included']);
    }

    public function testMemoryAndSkillFlagsAreReported(): void
    {
        $snap = ChatController::buildLlmContextSnapshot('openai', null, ['memory_context' => 'likes tea', 'skill_content' => '# Skill'], [], [], 'hi');
        $this->assertTrue($snap['memory_included']);
        $this->assertSame('likes tea', $snap['memory_context']);
        $this->assertTrue($snap['skill_included']);
        $this->assertSame('# Skill', $snap['skill_content']);
        $this->assertSame([], $snap['tools']);
        $this->assertNull($snap['model']);
    }
}
