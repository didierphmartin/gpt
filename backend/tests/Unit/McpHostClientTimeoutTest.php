<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\McpHostClient;

/** Install downloads dependencies; restart/enabled/delete/settings stop a server (10 s grace); the rest is quick. */
class McpHostClientTimeoutTest extends TestCase
{
    public function testTimeoutPerRoute(): void
    {
        $base = 'http://mcps:9000/servers';
        self::assertSame(900, McpHostClient::timeoutFor('POST', "$base/a/install"));
        self::assertSame(30, McpHostClient::timeoutFor('POST', "$base/a/restart"));
        self::assertSame(30, McpHostClient::timeoutFor('POST', "$base/a/enabled"));
        self::assertSame(30, McpHostClient::timeoutFor('DELETE', "$base/a"));
        self::assertSame(30, McpHostClient::timeoutFor('PUT', "$base/a/settings"));
        self::assertSame(15, McpHostClient::timeoutFor('GET', "$base/a/settings"));
        self::assertSame(15, McpHostClient::timeoutFor('GET', "$base/a/source"));
        self::assertSame(15, McpHostClient::timeoutFor('GET', $base));
    }
}
