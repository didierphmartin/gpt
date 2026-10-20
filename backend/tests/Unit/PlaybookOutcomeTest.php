<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\PlaybookOutcome;
use PHPUnit\Framework\TestCase;

final class PlaybookOutcomeTest extends TestCase
{
    public function testStatuses(): void
    {
        self::assertSame('done', PlaybookOutcome::exit('resolved'));
        self::assertSame('failed', PlaybookOutcome::exit('failed'));
        self::assertSame('failed', PlaybookOutcome::exit('running'));
        self::assertSame('failed', PlaybookOutcome::exit('handed_off'));
        self::assertSame('gate:approval', PlaybookOutcome::reason('handed_off', 'approval'));
        self::assertSame('status:running', PlaybookOutcome::reason('running', null));
        self::assertNull(PlaybookOutcome::reason('resolved', null));
        self::assertStringStartsWith("Playbook failed: bad_input\n\nT", PlaybookOutcome::failureText('bad_input', 'T'));
    }

    public function testNodeResult(): void
    {
        self::assertSame(['exit' => 'done', 'text' => "T\n\nJob: x"], PlaybookOutcome::nodeResult(null, 'T', 'Job: x'));
        self::assertSame(['exit' => 'failed', 'text' => "Playbook failed: bad_input\n\nT\n\nJob: x"], PlaybookOutcome::nodeResult('bad_input', 'T', 'Job: x'));
        self::assertSame(['exit' => 'done', 'text' => 'T'], PlaybookOutcome::nodeResult(null, 'T', null));
        self::assertSame(['exit' => 'failed', 'text' => "Playbook failed: status:running\n\nT"], PlaybookOutcome::nodeResult('status:running', 'T', null));
    }

    public function testErrorReason(): void
    {
        self::assertSame('error:boom and more', PlaybookOutcome::errorReason(new \RuntimeException("  boom\n  and\tmore \n")));
    }
}
