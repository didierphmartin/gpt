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

    public function testSavingStaysInTheCliEntry(): void
    {
        // A conversational turn must not write a file per prompt. The save
        // block belongs to __main__, after the call, not inside run_workflow.
        // (OUTPUT_STORAGE_ENABLED itself is also a module-level global baked by
        // globalsBlock() ahead of __main__ -- its *definition* naturally comes
        // first, so the needle here is the `if OUTPUT_STORAGE_ENABLED:` usage
        // that guards the save block, not the bare name.)
        $wf = $this->files()['workflow.py'];
        $mainAt = strpos($wf, 'if __name__ == "__main__":');
        $saveAt = strpos($wf, 'if OUTPUT_STORAGE_ENABLED:');
        $this->assertNotFalse($mainAt);
        $this->assertNotFalse($saveAt);
        $this->assertGreaterThan($mainAt, $saveAt, 'saving leaked into run_workflow');
    }

    public function testRunWorkflowDoesNotPreStripTheDocument(): void
    {
        // The editor extracts the document from the answer itself; stripping
        // here would lose any narration around it and make the two disagree.
        $wf = $this->files()['workflow.py'];
        $mainAt = strpos($wf, 'if __name__ == "__main__":');
        $reAt = strpos($wf, '<!doctype html');
        $this->assertGreaterThan($mainAt, $reAt, 'document extraction leaked into run_workflow');
    }
}
