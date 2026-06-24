<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\SkillToolChoice;

class SkillToolChoiceTest extends TestCase
{
    public function testOpenAiFamilyShape(): void
    {
        $expected = ['type' => 'function', 'function' => ['name' => 'run_skill_script']];
        foreach (['openai', 'grok', 'deepseek', 'kimi', 'OpenAI'] as $p) {
            $this->assertSame($expected, SkillToolChoice::forProvider($p), "provider {$p}");
        }
    }

    public function testClaudeShape(): void
    {
        $expected = ['type' => 'tool', 'name' => 'run_skill_script'];
        foreach (['claude', 'anthropic'] as $p) {
            $this->assertSame($expected, SkillToolChoice::forProvider($p), "provider {$p}");
        }
    }

    public function testGeminiAndUnknownReturnNull(): void
    {
        $this->assertNull(SkillToolChoice::forProvider('gemini'));
        $this->assertNull(SkillToolChoice::forProvider('google'));
        $this->assertNull(SkillToolChoice::forProvider('something-else'));
    }
}
