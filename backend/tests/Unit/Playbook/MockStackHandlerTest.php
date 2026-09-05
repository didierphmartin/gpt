<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;

/**
 * Tests the mock stack MCP server (htdocs/mockstack/index.php, outside this
 * repo) through its pure handler `mockstack_handle(service, rpc, logDir)`.
 */
class MockStackHandlerTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        $path = realpath(__DIR__ . '/../../../../../mockstack/index.php');
        if ($path === false) self::fail('mockstack/index.php not found next to the gpt folder');
        require_once $path;
    }

    private function call(string $service, string $tool, array $args): array
    {
        $rpc = ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => ['name' => $tool, 'arguments' => $args]];
        return mockstack_handle($service, $rpc, sys_get_temp_dir() . '/mockstack_test_' . uniqid());
    }

    public function testGithubListsRemoveUserFromTeam(): void
    {
        $r = mockstack_handle('github', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'], sys_get_temp_dir());
        $names = array_map(fn($t) => $t['name'], $r['result']['tools']);
        $this->assertContains('remove_user_from_team', $names);
    }

    public function testGithubRemoveUserFromTeamSucceeds(): void
    {
        $r = $this->call('github', 'remove_user_from_team', ['team' => 'engineering', 'email' => 'low@test']);
        $this->assertArrayNotHasKey('error', $r);
        $decoded = json_decode($r['result']['content'][0]['text'], true);
        $this->assertSame('success', $decoded['status']);
        $this->assertSame('engineering', $decoded['team']);
        $this->assertSame('low@test', $decoded['removed']);
    }
}
