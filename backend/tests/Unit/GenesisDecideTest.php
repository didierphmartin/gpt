<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\GenesisController;

class GenesisDecideTest extends TestCase
{
    private function gate(): GenesisController
    {
        // decide() is pure — no DB needed. Constructor accepts null PDO for tests.
        return new GenesisController(null);
    }

    public function testOffModeNeverAllows(): void
    {
        $d = $this->gate()->decide('off', 0.10, 3.0, 1.5, 0, 2, true);
        $this->assertFalse($d['allowed']);
        $this->assertSame('mode_off', $d['reason']);
    }

    public function testSuggestModeNeverBuilds(): void
    {
        $d = $this->gate()->decide('suggest', 0.10, 3.0, 1.5, 0, 2, true);
        $this->assertFalse($d['allowed']);
        $this->assertSame('suggest_only', $d['reason']);
    }

    public function testOverBudgetBlocks(): void
    {
        $d = $this->gate()->decide('auto', 2.0, 1.0, 5.0, 0, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertSame('over_budget', $d['reason']);
    }

    public function testWeeklyThrottleBlocks(): void
    {
        $d = $this->gate()->decide('auto', 0.10, 3.0, 1.5, 2, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertSame('weekly_throttle', $d['reason']);
    }

    public function testAskRequiresApproval(): void
    {
        $d = $this->gate()->decide('ask', 0.10, 3.0, 1.5, 0, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertTrue($d['requires_approval']);
        $this->assertSame('ask', $d['reason']);
    }

    public function testAskWithApprovalAllows(): void
    {
        $d = $this->gate()->decide('ask', 0.10, 3.0, 1.5, 0, 2, true);
        $this->assertTrue($d['allowed']);
        $this->assertSame('ask_approved', $d['reason']);
    }

    public function testAutoOverCeilingRequiresApproval(): void
    {
        $d = $this->gate()->decide('auto', 2.0, 3.0, 1.5, 0, 2, false);
        $this->assertFalse($d['allowed']);
        $this->assertTrue($d['requires_approval']);
        $this->assertSame('over_ceiling', $d['reason']);
    }

    public function testAutoUnderCeilingAllows(): void
    {
        $d = $this->gate()->decide('auto', 0.50, 3.0, 1.5, 1, 2, false);
        $this->assertTrue($d['allowed']);
        $this->assertFalse($d['requires_approval']);
        $this->assertSame('auto', $d['reason']);
    }
}
