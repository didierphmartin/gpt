<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

final class MAFPackageTest extends TestCase
{
    /**
     * The package files of the "Dispatcher demo" workflow, built in an
     * in-memory SQLite database by DispatcherDemoFixture and read through the
     * real repositories -- never the database configured in backend/.env.
     */
    private function files(): array
    {
        return DispatcherDemoFixture::packageFiles(\AgentTeam\Services\MAFGenerator::class);
    }

    public function testExposesTheContract(): void
    {
        $this->assertStringContainsString(
            'async def run_workflow(prompt: str, session: str | None = None) -> str:',
            $this->files()['workflow.py']
        );
    }

    public function testRunWorkflowReturnsTheTerminalOutput(): void
    {
        $wf = $this->files()['workflow.py'];
        $this->assertStringContainsString('_outputs = _result.get_outputs()', $wf);
        $this->assertStringContainsString('return _text', $wf);
    }

    /** run_workflow()'s own body: from its def to the next top-level statement. */
    private static function runWorkflowBody(string $wf): string
    {
        $at = strpos($wf, 'async def run_workflow(');
        preg_match('/\n(?=\S)/', $wf, $m, PREG_OFFSET_CAPTURE, $at + 1);
        return substr($wf, $at, $m[0][1] - $at);
    }

    public function testSavingStaysOutOfRunWorkflow(): void
    {
        // A conversational turn (POST /runs -> run_workflow) must not write a file per prompt: saving belongs
        // to the CLI and the listener's runs (run_once), never to run_workflow itself.
        $wf = DispatcherDemoFixture::packageFiles(\AgentTeam\Services\MAFGenerator::class)['workflow.py'];
        $this->assertStringNotContainsString('OUTPUT_STORAGE_ENABLED', self::runWorkflowBody($wf), 'saving leaked into run_workflow');
        $this->assertStringContainsString('saved = _save_output(output)', $wf);
    }

    public function testRunWorkflowDoesNotPreStripTheDocument(): void
    {
        $wf = DispatcherDemoFixture::packageFiles(\AgentTeam\Services\MAFGenerator::class)['workflow.py'];
        $this->assertStringNotContainsString('<!doctype html', self::runWorkflowBody($wf), 'document extraction leaked into run_workflow');
    }
}
