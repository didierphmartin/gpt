<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Controllers\WorkflowController;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\EVIWebhookController;

/**
 * index.php sends `$result['status_code'] ?? 200`: an error return has to carry
 * its status there, http_response_code() alone is overwritten with 200.
 */
final class ControllerStatusCodeTest extends TestCase
{
    private string $runsDir;

    protected function setUp(): void
    {
        $this->runsDir = sys_get_temp_dir() . '/wf-runs-' . bin2hex(random_bytes(4));
        mkdir($this->runsDir);
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->runsDir . '/*') ?: []);
        rmdir($this->runsDir);
    }

    private function workflows(): WorkflowController
    {
        return new WorkflowController(new PDO('sqlite::memory:'), ['workflow_runs_dir' => $this->runsDir]);
    }

    public function testRunEventsAnswersItsErrorStatuses(): void
    {
        $c = $this->workflows();
        $runId = str_repeat('a', 32);

        $this->assertSame(['error' => 'Authentication required', 'status_code' => 401],
            $c->runEvents(['user_id' => 0, 'params' => ['runId' => $runId]]));
        $this->assertSame(['error' => 'Invalid runId', 'status_code' => 400],
            $c->runEvents(['user_id' => 3, 'params' => ['runId' => 'nope']]));
        $this->assertSame(['error' => 'Run not found', 'status_code' => 404],
            $c->runEvents(['user_id' => 3, 'params' => ['runId' => $runId]]));
    }

    public function testToolResultAnswersItsErrorStatuses(): void
    {
        $c = $this->workflows();

        $this->assertSame(['error' => 'Authentication required', 'status_code' => 401],
            $c->toolResult(['user_id' => 0, 'body' => []]));
        $this->assertSame(['error' => 'Invalid tool_call_id', 'status_code' => 400],
            $c->toolResult(['user_id' => 3, 'body' => ['tool_call_id' => 'not-32-hex']]));
    }

    public function testEviWebhookAnswers404ForAToolItDoesNotRegister(): void
    {
        $c = new EVIWebhookController(new PDO('sqlite::memory:'), []);

        $this->assertSame(
            ['success' => false, 'error' => 'Tool not found: get_portfolios', 'status_code' => 404],
            $c->handleWebhook(['body' => ['tool_name' => 'get_portfolios', 'parameters' => []]])
        );
    }
}
