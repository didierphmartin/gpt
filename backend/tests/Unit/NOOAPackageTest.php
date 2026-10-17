<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

final class NOOAPackageTest extends TestCase
{
    private function generator(\PDO $db): \AgentTeam\Services\NOOAGenerator
    {
        return DispatcherDemoFixture::generator(\AgentTeam\Services\NOOAGenerator::class, $db);
    }

    /**
     * The package files of the "Dispatcher demo" workflow, built in an
     * in-memory SQLite database by DispatcherDemoFixture and read through the
     * real repositories -- never the database configured in backend/.env.
     */
    private function files(): array
    {
        return DispatcherDemoFixture::packageFiles(\AgentTeam\Services\NOOAGenerator::class);
    }

    public function testExposesTheContract(): void
    {
        $this->assertStringContainsString(
            'async def run_workflow(prompt: str, session: str | None = None) -> str:',
            $this->files()['workflow.py']
        );
    }

    public function testEmitsThePackageFiles(): void
    {
        $paths = array_keys($this->files());
        sort($paths);
        // the run server and script, plus the folder's own files (CompiledPackage)
        $this->assertSame(['.env.example', 'README.md', '__init__.py', 'agents/__init__.py', 'agents/human_resources.py', 'agents/it_claims.py',
            'agents/techbuddy.py', 'api.py', 'common.py', 'requirements.txt', 'workflow.py'], $paths);   // agents in separate files
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
     * A real swarm-orchestration row isn't part of the Dispatcher-demo fixture
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
