<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\CronExpression;
use PHPUnit\Framework\TestCase;

final class CronExpressionTest extends TestCase
{
    private static function at(string $s): \DateTimeImmutable
    {
        return new \DateTimeImmutable($s);
    }

    public function testSimpleCreation(): void
    {
        $c = new CronExpression('*/2 * * * *');
        $this->assertIsObject($c);
    }

    public function testEveryTwoMinutes(): void
    {
        $c = new CronExpression('*/2 * * * *');
        self::assertSame('2026-10-07 10:44', $c->nextAfter(self::at('2026-10-07 10:42:30'))->format('Y-m-d H:i'));
        self::assertSame('2026-10-07 10:44', $c->nextAfter(self::at('2026-10-07 10:43:00'))->format('Y-m-d H:i'));
    }

    public function testWeekdaysOfficeHours(): void
    {
        $c = new CronExpression('*/5 8-18 * * 1-5');
        // Friday 18:57 -> Monday 08:00 (2026-10-09 is a Friday)
        self::assertSame('2026-10-12 08:00', $c->nextAfter(self::at('2026-10-09 18:57'))->format('Y-m-d H:i'));
        self::assertSame('2026-10-09 18:55', $c->nextAfter(self::at('2026-10-09 18:50'))->format('Y-m-d H:i'));
    }

    public function testSundayAsSeven(): void
    {
        $c = new CronExpression('0 9 * * 7');
        self::assertSame('2026-10-11 09:00', $c->nextAfter(self::at('2026-10-07 00:00'))->format('Y-m-d H:i'));
    }

    public function testDayOfMonthOrDayOfWeekWhenBothRestricted(): void
    {
        // Standard cron: both restricted -> either matches. 1st of month OR Monday.
        $c = new CronExpression('0 0 1 * 1');
        self::assertSame('2026-10-12 00:00', $c->nextAfter(self::at('2026-10-07 00:00'))->format('Y-m-d H:i'));
    }

    public function testListsRangesAndSteps(): void
    {
        $c = new CronExpression('5,35 9-17/4 * * *');
        self::assertTrue($c->matches(self::at('2026-10-07 13:35')));
        self::assertFalse($c->matches(self::at('2026-10-07 11:35')));
        self::assertTrue($c->matches(self::at('2026-10-07 17:05')));
    }

    public function testInvalidExpressions(): void
    {
        foreach (['', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '* * * * * *'] as $bad) {
            self::assertFalse(CronExpression::isValid($bad), $bad);
        }
        self::assertTrue(CronExpression::isValid('*/2 * * * *'));
    }

    public function testNeverFiringExpressionIsInvalid(): void
    {
        self::assertFalse(CronExpression::isValid('0 0 31 2 *'));
        self::assertTrue(CronExpression::isValid('0 0 29 2 *'));   // leap day fires within 4 years
    }
}
