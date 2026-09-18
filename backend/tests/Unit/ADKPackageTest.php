<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ADKPackageTest extends TestCase
{
    /**
     * Brief's Step 1 constructs `new ADKGenerator()` with no arguments, but the
     * real constructor takes (PDO $db, WorkflowRepository, WorkflowGraphRepository,
     * AgentRepository) -- there is no zero-arg form. generatePackage(44) needs a
     * real workflow row (the "Dispatcher demo" fixture, spec §8 / plan Finding 2),
     * so this connects to the CONTEXTS db the same way the repo's own
     * tests/CheckExistingWorkflows.php does, rather than a zero-arg construction
     * that cannot compile.
     */
    private function pkg(): array
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

        $gen = new \AgentTeam\Services\ADKGenerator($db, $workflowRepo, $graphRepo, $agentRepo);
        return $gen->generatePackage(44);   // the dispatcher demo fixture workflow
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
