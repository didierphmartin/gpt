<?php
declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\AdminController;

/** The admin tool fetch reaches a Docker-hosted server at the address the web container can reach. */
final class AdminMcpInternalUrlTest extends TestCase
{
    private array $savedEnv = [];

    protected function setUp(): void
    {
        foreach (['MCPS_GATEWAY', 'MCPS_PUBLIC_GATEWAY'] as $k) {
            $this->savedEnv[$k] = $_ENV[$k] ?? null;
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->savedEnv as $k => $v) {
            if ($v === null) {
                unset($_ENV[$k]);
            } else {
                $_ENV[$k] = $v;
            }
        }
    }

    public function testMcpHttpCallUsesTheInternalGateway(): void
    {
        $_ENV['MCPS_GATEWAY'] = 'http://mcps-internal.invalid:8790';
        $_ENV['MCPS_PUBLIC_GATEWAY'] = 'http://localhost:8790';
        $m = new \ReflectionMethod(AdminController::class, 'mcpHttpCall');
        $m->setAccessible(true);
        $session = null;
        $args = ['http://localhost:8790/outlook_mcp/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'], [], &$session];
        $out = $m->invokeArgs(new AdminController(new \PDO('sqlite::memory:'), []), $args);
        self::assertFalse($out['ok']);
        self::assertStringContainsString('mcps-internal.invalid', (string) $out['error']);
    }
}
