<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\StartTriggerFacts;

class AdkListenTest extends TestCase
{
    private static function triggerNodes(string $server = 'Outlook'): array
    {
        return [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']],
            ['id' => '1000000001', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'T',
                'start_trigger' => ['label' => 'T', 'work_exit' => 'new_mail',
                    'watch' => ['server' => $server, 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']]]]],
        ];
    }

    public function testTriggerNodeMakesTheStartWatch(): void
    {
        $f = StartTriggerFacts::of(null, 64, self::triggerNodes(), ['http://x' => 'outlook']);
        self::assertSame('watch', $f['startMode']);
        self::assertSame(['server' => 'outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']], $f['defaultWatch']);
        self::assertSame('1000000001', $f['triggerNodeId']);
    }

    public function testWatchOnAnUnusedServerIsRefused(): void
    {
        $this->expectExceptionMessage('which no node of this workflow uses');
        StartTriggerFacts::of(null, 64, self::triggerNodes('Gmail'), ['http://x' => 'outlook']);
    }

    public function testNoTriggerNoScheduleIsAPromptStart(): void
    {
        $pdo = new \PDO('sqlite::memory:');   // no scheduled_workflows table
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $f = StartTriggerFacts::of($pdo, 64, [['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']]], []);
        self::assertSame(['startMode' => 'prompt', 'defaultCron' => null, 'defaultWatch' => null, 'triggerNodeId' => null], $f);
    }

    public function testScriptBakesTheStartMode(): void
    {
        $a = AdkCodeNodeTest::codeAnalyzed();
        $a['startMode'] = 'watch';
        $a['defaultWatch'] = ['server' => 'outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']];
        $code = ADKGenerator::emitAdk($a);
        self::assertStringContainsString('START_MODE = "watch"', $code);
        self::assertStringContainsString('DEFAULT_CRON = None', $code);
        self::assertMatchesRegularExpression('/DEFAULT_WATCH = \{\s*"server": "outlook",\s*"tool": "wait_for_new",\s*"args": \{\s*"folder": "Inbox"\s*\}\s*\}/', $code);
        self::assertStringContainsString('START_MODE = "prompt"', ADKGenerator::emitAdk(AdkCodeNodeTest::codeAnalyzed()));
    }
}
