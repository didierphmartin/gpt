<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class MAFPackageTest extends TestCase
{
    /**
     * Brief's Step 1 constructs `new MAFGenerator()` with no arguments, but the
     * real constructor takes (PDO $db, WorkflowRepository, WorkflowGraphRepository,
     * AgentRepository) -- there is no zero-arg form. generatePackage(44) needs a
     * real workflow row (the "Dispatcher demo" fixture, spec §8 / plan Finding 2),
     * so this connects to the CONTEXTS db the same way ADKPackageTest (Task 3)
     * does, rather than a zero-arg construction that cannot compile.
     */
    private function files(): array
    {
        $config = require dirname(__DIR__, 2) . '/config/ai_config.php';
        $dbConfig = $config['contexts_database'] ?? $config['database'];
        $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
        $db = new \PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        ]);

        $workflowRepo = new \AgentTeam\Services\WorkflowRepository($db);
        $graphRepo = new \AgentTeam\Services\WorkflowGraphRepository($db);
        $agentRepo = new \AgentTeam\Services\AgentRepository($db);

        $wf = $workflowRepo->findById(44);
        if (!$wf) {
            $this->markTestSkipped('Workflow 44 (the "Dispatcher demo" fixture) was not found in the DB.');
        }

        $gen = new \AgentTeam\Services\MAFGenerator($db, $workflowRepo, $graphRepo, $agentRepo);
        return array_column($gen->generatePackage(44)['files'], 'code', 'path');
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
