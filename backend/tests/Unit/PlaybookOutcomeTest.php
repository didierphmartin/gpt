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
}
