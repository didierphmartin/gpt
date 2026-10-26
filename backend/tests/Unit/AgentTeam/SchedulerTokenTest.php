<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Controllers\SchedulerController;
use PDO;
use PHPUnit\Framework\TestCase;

/** Without a signed-in user, /scheduler/run needs the configured token; a blank SCHEDULER_TOKEN never matches. */
class SchedulerTokenTest extends TestCase
{
    private function run401(string $configured, array $request): void
    {
        $c = new SchedulerController(new PDO('sqlite::memory:'), ['scheduler' => ['token' => $configured]]);
        $r = $c->run($request);
        $this->assertSame(401, $r['status_code']);
    }

    public function test_blank_configured_token_refuses_every_token(): void
    {
        $this->run401('', ['body' => ['token' => '']]);
        $this->run401('', ['body' => []]);
        $this->run401('', ['body' => [], 'headers' => ['X-Scheduler-Token' => '']]);
    }

    public function test_wrong_or_non_string_token_is_refused(): void
    {
        $this->run401('s3cret', ['body' => ['token' => 'nope']]);
        $this->run401('s3cret', ['body' => ['token' => ['s3cret']]]);
    }
}
