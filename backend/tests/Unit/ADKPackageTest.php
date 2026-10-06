<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

final class ADKPackageTest extends TestCase
{
    /**
     * generatePackage() of the "Dispatcher demo" workflow, built in an
     * in-memory SQLite database by DispatcherDemoFixture and read through the
     * real repositories -- never the database configured in backend/.env.
     */
    private function pkg(): array
    {
        $gen = DispatcherDemoFixture::generator(\AgentTeam\Services\ADKGenerator::class, DispatcherDemoFixture::pdo());
        return $gen->generatePackage(DispatcherDemoFixture::WORKFLOW_ID);
    }

    public function testEmitsTheFourPackageFiles(): void
    {
        $paths = array_column($this->pkg()['files'], 'path');
        sort($paths);
        $this->assertSame(['__init__.py', 'api.py', 'common.py', 'workflow.py'], $paths);
    }

    public function testWorkflowExposesTheContract(): void
    {
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $this->assertStringContainsString(
            'async def run_workflow(prompt: str, session: str | None = None) -> str:',
            $files['workflow.py']
        );
    }

    public function testTheCliEntryStillExists(): void
    {
        // The single-file download is the only way to run this outside the
        // editor; packaging must not remove it.
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $this->assertStringContainsString('if __name__ == "__main__":', $files['workflow.py']);
    }

    public function testApiPyImportsTheContract(): void
    {
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $this->assertStringContainsString('from workflow import run_workflow', $files['api.py']);
    }

    public function testSavingStaysInTheCliEntry(): void
    {
        // A conversational turn must not write a file per prompt. The save
        // block belongs to __main__, after the call, not inside run_workflow.
        // Same rule (and same needle) as MAFPackageTest: OUTPUT_STORAGE_ENABLED
        // is also a module-level global baked ahead of __main__, so the needle
        // is the `if OUTPUT_STORAGE_ENABLED:` usage that guards the save block,
        // not the bare name. Both needles occur exactly once in ADK's output.
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $wf = $files['workflow.py'];
        $this->assertSame(1, substr_count($wf, 'if __name__ == "__main__":'));
        $this->assertSame(1, substr_count($wf, 'if OUTPUT_STORAGE_ENABLED:'));
        $mainAt = strpos($wf, 'if __name__ == "__main__":');
        $saveAt = strpos($wf, 'if OUTPUT_STORAGE_ENABLED:');
        $this->assertGreaterThan($mainAt, $saveAt, 'saving leaked into run_workflow');
    }

    public function testRunWorkflowDoesNotPreStripTheDocument(): void
    {
        // The editor extracts the document from the answer itself; stripping
        // here would lose any narration around it, and with two documents in
        // one answer the non-greedy regex would keep only the first.
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $wf = $files['workflow.py'];
        $this->assertSame(1, substr_count($wf, '<!doctype html'));
        $mainAt = strpos($wf, 'if __name__ == "__main__":');
        $reAt = strpos($wf, '<!doctype html');
        $this->assertGreaterThan($mainAt, $reAt, 'document extraction leaked into run_workflow');
    }
}
