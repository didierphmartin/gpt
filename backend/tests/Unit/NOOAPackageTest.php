<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class NOOAPackageTest extends TestCase
{
    /**
     * Brief's Step 1 constructs `new NOOAGenerator()` with no arguments, but the
     * real constructor takes (PDO $db, WorkflowRepository, WorkflowGraphRepository,
     * AgentRepository) -- there is no zero-arg form. generatePackage(44) needs a
     * real workflow row (the "Dispatcher demo" fixture, spec §8 / plan Finding 2),
     * so this connects to the CONTEXTS db the same way ADKPackageTest/MAFPackageTest
     * (Tasks 3/4) do, rather than a zero-arg construction that cannot compile.
     */
    private function pdo(): \PDO
    {
        $config = require dirname(__DIR__, 2) . '/config/ai_config.php';
        $dbConfig = $config['contexts_database'] ?? $config['database'];
        $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
        return new \PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        ]);
    }

    private function generator(\PDO $db): \AgentTeam\Services\NOOAGenerator
    {
        $workflowRepo = new \AgentTeam\Services\WorkflowRepository($db);
        $graphRepo = new \AgentTeam\Services\WorkflowGraphRepository($db);
        $agentRepo = new \AgentTeam\Services\AgentRepository($db);
        return new \AgentTeam\Services\NOOAGenerator($db, $workflowRepo, $graphRepo, $agentRepo);
    }

    private function files(): array
    {
        $db = $this->pdo();
        $workflowRepo = new \AgentTeam\Services\WorkflowRepository($db);
        $wf = $workflowRepo->findById(44);
        if (!$wf) {
            $this->markTestSkipped('Workflow 44 (the "Dispatcher demo" fixture) was not found in the DB.');
        }

        $gen = $this->generator($db);
        return array_column($gen->generatePackage(44)['files'], 'code', 'path');
    }

    public function testExposesTheContract(): void
    {
        $this->assertStringContainsString(
            'async def run_workflow(prompt: str, session: str | None = None) -> str:',
            $this->files()['workflow.py']
        );
    }

    public function testEmitsTheFourPackageFiles(): void
    {
        $paths = array_keys($this->files());
        sort($paths);
        $this->assertSame(['__init__.py', 'api.py', 'common.py', 'workflow.py'], $paths);
    }

    /**
     * Spec §9: NOOA is batch-only, permanently -- not a temporary state. The
     * brief's original version of this test only asserted that the string
     * "swarm" appears somewhere in NOOAGenerator's source, which a bare
     * comment satisfies and which would keep passing even with the refusal
     * branch deleted. Pinned here as behaviour instead: a workflow whose
     * orchestration is "swarm" must make generate() throw, exactly as
     * ADKGenerator/MAFGenerator do (a RuntimeException from generate()).
     *
     * A real swarm-orchestration row isn't part of the workflow-44 fixture
     * this suite otherwise relies on, and standing up a full swarm graph
     * (LangGraphSwarmGeneratorTest's twoAgentSwarm() harness) is more
     * machinery than this refusal check needs -- the check in
     * NOOAGenerator::generate() fires from workflowRepo->findById() alone,
     * before the graph is ever read. So this builds the smallest real thing
     * that exercises it: an in-memory sqlite `agent_workflows` table holding
     * one row with orchestration='swarm', read back through a real
     * WorkflowRepository/Workflow model (not a mock of the refusal itself).
     */
    public function testSwarmIsStillRefused(): void
    {
        $db = new \PDO('sqlite::memory:');
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, orchestration TEXT)');
        $db->exec("INSERT INTO agent_workflows (id, user_id, name, orchestration) VALUES (1, '1', 'Swarm Fixture', 'swarm')");

        $gen = $this->generator($db);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('NOOA cannot compile');
        $gen->generate(1);
    }
}
