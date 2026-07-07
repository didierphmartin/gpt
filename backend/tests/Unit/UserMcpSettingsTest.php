<?php
declare(strict_types=1);
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPServerController;

final class UserMcpSettingsTest extends TestCase
{
    private function call(array $server, ?array $allow): bool
    {
        $m = new ReflectionMethod(MCPServerController::class, 'serverAllowedForUser');
        $m->setAccessible(true);
        // Construct without running the DB constructor.
        $obj = (new ReflectionClass(MCPServerController::class))->newInstanceWithoutConstructor();
        return $m->invoke($obj, $server, $allow);
    }

    public function testPrivateServerAlwaysAllowed(): void
    {
        $this->assertTrue($this->call(['name'=>'x','user_id'=>7], ['only-this']));
    }
    public function testGlobalAllowedWhenNoAllowlist(): void
    {
        $this->assertTrue($this->call(['name'=>'g','user_id'=>null], null));
    }
    public function testGlobalGatedByAllowlist(): void
    {
        $this->assertTrue($this->call(['name'=>'g','user_id'=>null], ['g']));
        $this->assertFalse($this->call(['name'=>'g','user_id'=>null], ['other']));
    }
    public function testGlobalDeniedWhenEmptyAllowlist(): void
    {
        $this->assertFalse($this->call(['name'=>'g','user_id'=>null], []));
    }
}
