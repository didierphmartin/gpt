<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\NodeLogFormat;

class NodeLogFormatTest extends TestCase
{
    public function testCallingProviderWithModel(): void
    {
        $this->assertSame('calling grok (grok-4-fast)', NodeLogFormat::callingProvider('grok', 'grok-4-fast'));
    }

    public function testCallingProviderWithoutModel(): void
    {
        $this->assertSame('calling grok', NodeLogFormat::callingProvider('grok', null));
        $this->assertSame('calling grok', NodeLogFormat::callingProvider('grok', ''));
    }

    public function testModelRequestedTool(): void
    {
        $this->assertSame('model requested run_skill_script', NodeLogFormat::modelRequestedTool('run_skill_script'));
    }

    public function testModelRespondedText(): void
    {
        $this->assertSame('model responded with text', NodeLogFormat::modelRespondedText());
    }

    public function testRunningSkill(): void
    {
        $this->assertSame('running skill GEO/geo-content', NodeLogFormat::runningSkill('GEO/geo-content'));
    }

    public function testSkillFinished(): void
    {
        $this->assertSame('skill finished (exit 0, 1240 bytes)', NodeLogFormat::skillFinished(0, 1240));
        $this->assertSame('skill finished (exit unknown, 0 bytes)', NodeLogFormat::skillFinished(null, null));
    }

    public function testSkillTimedOut(): void
    {
        $this->assertSame('skill timed out after 300s', NodeLogFormat::skillTimedOut(300));
    }

    public function testCompletedWithCost(): void
    {
        $this->assertSame('completed (1840 tok, $0.0041)', NodeLogFormat::completed(1840, 0.0041));
    }

    public function testCompletedWithoutCost(): void
    {
        $this->assertSame('completed (1840 tok)', NodeLogFormat::completed(1840, null));
    }

    public function testHttpError(): void
    {
        $this->assertSame(
            'HTTP 400 — Thinking mode does not support this tool_choice',
            NodeLogFormat::httpError(400, 'Thinking mode does not support this tool_choice')
        );
    }
}
