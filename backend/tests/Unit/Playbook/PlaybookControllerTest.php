<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use Mockery;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\PlaybookController;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/**
 * Registration-time validate endpoint (spec T4). Tests the controller
 * method's return value directly (no HTTP layer) — the codebase has no
 * existing controller test to pattern-match on, so this follows the same
 * "assert the returned array" convention the rest of the Playbook unit
 * suite uses for its collaborators.
 *
 * The controller's MCPToolsLoader is swapped for a Mockery stub via the
 * optional third constructor argument (a loader factory) added for this
 * task — production code (backend/index.php) still instantiates the
 * controller with just ($pdo, $config), so this is additive only.
 */
class PlaybookControllerTest extends TestCase
{
    use MockeryPHPUnitIntegration;

    /** The mock Okta server's 7 real tools (see backend/scripts/register_mock_okta.php run log). */
    private const MOCK_OKTA_TOOLS = [
        'search_users', 'search_system_log', 'list_user_factors',
        'verify_security_answers', 'reset_password', 'reset_factor', 'unlock_user',
    ];

    private function mfaDoc(): array
    {
        return [
            'title' => 'MFA Reset',
            'trigger' => ['kind' => 'request', 'description' => 'user locked out'],
            'instructions' => '#Search Okta User by Email first, then #Reset Password (Okta), ' .
                'then #Reset User Factors (Okta), then #Leave Internal Note, then #Resolve Request.',
            'tools_used' => ['Okta'],
            'actions_used' => [
                '#Search Okta User by Email', '#Reset Password (Okta)',
                '#Reset User Factors (Okta)', '#Leave Internal Note', '#Resolve Request',
            ],
            'bindings' => [
                '#Search Okta User by Email' => 'okta.search_users',
                '#Reset Password (Okta)' => 'okta.reset_password',
                '#Reset User Factors (Okta)' => 'okta.reset_factor',
            ],
        ];
    }

    /** Builds an MCPToolsLoader stub whose getTools() exposes the given Okta tool names. */
    private function loaderWithOktaTools(array $toolNames): MCPToolsLoader
    {
        $tools = [];
        foreach ($toolNames as $name) {
            $tools['mcp_' . $name] = [
                'original_name' => $name,
                'server_id' => 1,
                'server_url' => 'http://localhost/mockokta/',
                'server_name' => 'Okta',
                'server_headers' => [],
                'description' => "Mock Okta tool {$name}",
                'input_schema_json' => json_encode(['type' => 'object', 'properties' => []]),
                'has_ui' => false,
                'ui_resource_uri' => null,
            ];
        }
        $loader = Mockery::mock(MCPToolsLoader::class);
        $loader->shouldReceive('loadToolsForUser')->andReturn($tools);
        $loader->shouldReceive('getTools')->andReturn($tools);
        return $loader;
    }

    /** In-memory SQLite standing in for the contexts DB's `agents` table (empty — no agent bindings tested). */
    private function pdoWithNoAgents(): PDO
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE agents (id INTEGER PRIMARY KEY, user_id INT, name TEXT)');
        return $pdo;
    }

    private function controller(MCPToolsLoader $loader, ?PDO $pdo = null): PlaybookController
    {
        $pdo = $pdo ?? $this->pdoWithNoAgents();
        return new PlaybookController($pdo, [], fn (?string $userId) => $loader);
    }

    public function testDanglingBindingReturns422(): void
    {
        // All 7 mock Okta tools present EXCEPT reset_factor — the binding
        // for "#Reset User Factors (Okta)" dangles.
        $present = array_values(array_diff(self::MOCK_OKTA_TOOLS, ['reset_factor']));
        $loader = $this->loaderWithOktaTools($present);
        $controller = $this->controller($loader);

        $result = $controller->validate([
            'user_id' => 7,
            'body' => ['playbook' => $this->mfaDoc()],
        ]);

        $this->assertSame(422, $result['status_code']);
        $this->assertFalse($result['valid']);
        $this->assertNotEmpty($result['errors']);
        $this->assertStringContainsString('#Reset User Factors (Okta)', $result['errors'][0]);
        $this->assertStringContainsString('okta.reset_factor', $result['errors'][0]);
    }

    public function testFullyBoundMfaDocumentReturns200(): void
    {
        // All 7 mock Okta tools present — every binding resolves.
        $loader = $this->loaderWithOktaTools(self::MOCK_OKTA_TOOLS);
        $controller = $this->controller($loader);

        $result = $controller->validate([
            'user_id' => 7,
            'body' => ['playbook' => $this->mfaDoc()],
        ]);

        $this->assertSame(200, $result['status_code']);
        $this->assertTrue($result['valid']);
        $this->assertSame([], $result['errors']);
        $this->assertNotEmpty($result['actions']);
        $this->assertSame($this->mfaDoc()['actions_used'], $result['checklist']);
        $byName = array_column($result['actions'], null, 'name');
        $this->assertSame('bound', $byName['#Search Okta User by Email']['kind']);
        $this->assertSame('okta.search_users', $byName['#Search Okta User by Email']['target']);
        $this->assertSame('native', $byName['#Resolve Request']['kind']);
    }

    public function testMissingPlaybookFieldReturns422WithoutTouchingLoader(): void
    {
        $loader = Mockery::mock(MCPToolsLoader::class);
        $loader->shouldNotReceive('getTools');
        $controller = $this->controller($loader);

        $result = $controller->validate(['user_id' => 7, 'body' => []]);

        $this->assertSame(422, $result['status_code']);
        $this->assertFalse($result['valid']);
        $this->assertNotEmpty($result['errors']);
    }

    public function testConsoleTextStringPlaybookIsParsed(): void
    {
        $loader = $this->loaderWithOktaTools(self::MOCK_OKTA_TOOLS);
        $controller = $this->controller($loader);

        $text = "Title: MFA Reset\n" .
            "Trigger: user locked out\n" .
            "Instructions: #Search Okta User by Email first, then #Resolve Request.\n" .
            "Tools used: Okta\n" .
            "Actions used: #Search Okta User by Email; #Resolve Request\n";

        $result = $controller->validate(['user_id' => 7, 'body' => ['playbook' => $text]]);

        // No bindings supplied in the console text form here, so the Okta
        // search action is unbound (warning, not error) while #Resolve
        // Request is a native verb; the document itself parses successfully.
        $this->assertContains($result['status_code'], [200, 422]);
        $this->assertIsArray($result['checklist']);
        $this->assertSame(['#Search Okta User by Email', '#Resolve Request'], $result['checklist']);
    }

    public function testUnauthenticatedRequestReturns401(): void
    {
        $loader = Mockery::mock(MCPToolsLoader::class);
        $loader->shouldNotReceive('getTools');
        $controller = $this->controller($loader);

        $result = $controller->validate(['body' => ['playbook' => $this->mfaDoc()]]);

        $this->assertSame(401, $result['status_code']);
    }
}
