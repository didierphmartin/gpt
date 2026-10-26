<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\LangGraphPackage;
use AgentTeam\Services\PythonRequirements;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

/**
 * What an exported folder tells a newcomer: one requirement list per target (requirements.txt = the TO RUN
 * install line), and a README whose commands are the ones the emitted programs really accept.
 */
final class ExportReadmeTest extends TestCase
{
    public function testRequirementsCarryTheRunnersFloorsSortedByName(): void
    {
        self::assertSame(['a2a-sdk[http-server]>=1.1,<2', 'beautifulsoup4', 'httpx>=0.27.0', 'langchain>=0.3.0',
            'langchain-anthropic>=0.3.0', 'mcp<2', 'nooa[mcp]'],
            PythonRequirements::lines(['nooa[mcp]', 'langchain-anthropic', 'httpx', 'mcp', 'beautifulsoup4', 'langchain', 'httpx', 'a2a-sdk[http-server]']));
        self::assertSame('pip install "google-adk>=2.3,<3" litellm "python-dotenv>=1.0.0"',
            PythonRequirements::pipInstall(['python-dotenv', 'litellm', 'google-adk']));
        self::assertSame(['pypdf', 'mammoth'], PythonRequirements::documentNames([['path' => 'a/r.PDF'], ['name' => 'x.docx'], ['path' => 'n.txt']]));
    }

    /** A Gemini node needs langchain-google-genai in every layout, the single file's TO RUN line included. */
    public function testProviderPackagesReachEveryLayout(): void
    {
        $facts = ['agentData' => ['2' => ['provider' => 'gemini']], 'playbookData' => []];
        foreach (['single', 'modular', 'a2a'] as $layout) {
            self::assertContains('langchain-google-genai', LangGraphPackage::requirementNames($facts, $layout), $layout);
        }
        self::assertStringContainsString('"langchain-google-genai>=2.0.0"', LangGraphPackage::pipInstall($facts, 'single'));
        self::assertNotContains('fastapi', LangGraphPackage::requirementNames($facts, 'single'), 'the single file has no run server');
        self::assertContains('a2a-sdk[http-server]', LangGraphPackage::requirementNames($facts, 'a2a'));
    }

    public function testLangGraphSingleFileTOrunInstallsItsRequirementsTxt(): void
    {
        $r = LangGraphA2AGeneratorTest::generator()->generate(44, '3');
        $files = array_column($r['package_files'], 'code', 'path');
        preg_match('/^  (pip install "[^\n]*)$/m', $r['code'], $m);
        $pins = array_map(fn($a) => trim($a, '"'), explode(' ', substr($m[1], strlen('pip install '))));
        self::assertSame(explode("\n", rtrim($files['requirements.txt'], "\n")), $pins);
        self::assertStringContainsString('| `python dispatcher_demo_langgraph.py --watch [TRIGGER]` |', $files['README.md']);
        self::assertStringNotContainsString('api.py', $files['README.md'], 'the single file has no run server');
    }

    /** LangGraph's A2A package: orchestrator.py (prompt, --cron, --keep-serving, --no-spawn), agents/, api.py without --listen. */
    public function testLangGraphA2aReadmeNamesTheOrchestratorAndItsAgentServers(): void
    {
        $r = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['a2a' => true]);
        $files = array_column($r['files'], 'code', 'path');
        $readme = $files['README.md'];
        foreach (['cd dispatcher_demo_a2a', 'python orchestrator.py "your prompt"', 'python orchestrator.py --cron [EXPR]',
                  '`--keep-serving`', '`--no-spawn`', '| techBuddy (2) | `agents/2_techbuddy.py` | http://127.0.0.1:8701/ |',
                  'python agents/2_techbuddy.py --port 8701', 'python api.py --port 8800',
                  '<string>/path/to/dispatcher_demo_a2a/orchestrator.py</string>'] as $needle) {
            self::assertStringContainsString($needle, $readme, $needle);
        }
        foreach (['--listen', '--watch', '--once', 'workflow.py'] as $absent) {
            self::assertStringNotContainsString($absent, $readme, $absent);
        }
        self::assertStringContainsString("a2a-sdk[http-server]>=1.1,<2\n", $files['requirements.txt']);
        self::assertStringContainsString('# A2A_BASE_PORT=8701', $files['.env.example']);
        // the orchestrator reads the folder's own .env (as its agents do), then the runner's
        self::assertStringContainsString("load_dotenv(os.path.join(_HERE, \".env\"))", $files['orchestrator.py']);
    }

    /** ADK / MAF / NOOA A2A: the orchestrator has no --cron; servers/ run the nodes; workflow.py keeps every mode. */
    public function testCompiledA2aReadmeKeepsEachProgramsOwnFlags(): void
    {
        foreach (['ADKGenerator' => 'adk', 'MAFGenerator' => 'maf', 'NOOAGenerator' => 'nooa'] as $class => $t) {
            $gen = DispatcherDemoFixture::generator("AgentTeam\\Services\\{$class}", DispatcherDemoFixture::pdo());
            $files = array_column($gen->generateA2A(DispatcherDemoFixture::WORKFLOW_ID)['files'], 'code', 'path');
            $readme = $files['README.md'];
            foreach (["cd dispatcher_demo_{$t}_a2a", 'python orchestrator.py "your prompt"', '`--keep-serving`', 'servers/',
                      '| `python workflow.py --watch [TRIGGER]` |', 'python api.py --port 8800'] as $needle) {
                self::assertStringContainsString($needle, $readme, "{$t}: {$needle}");
            }
            self::assertStringNotContainsString('orchestrator.py --cron', $readme, $t);
            self::assertStringNotContainsString('--listen', $readme, "{$t}: the A2A api.py has no --listen");
            self::assertStringContainsString("a2a-sdk[http-server]>=1.1,<2\n", $files['requirements.txt'], $t);
        }
    }

    /** ADK / MAF / NOOA agents in separate files: workflow.py's modes, api.py --listen, the framework pins. */
    public function testCompiledModularReadme(): void
    {
        $pins = ['adk' => "google-adk>=2.3,<3\n", 'maf' => "agent-framework>=1.10,<2\n", 'nooa' => "mcp<2\nnooa[mcp]\n"];
        foreach (['ADKGenerator' => 'adk', 'MAFGenerator' => 'maf', 'NOOAGenerator' => 'nooa'] as $class => $t) {
            $gen = DispatcherDemoFixture::generator("AgentTeam\\Services\\{$class}", DispatcherDemoFixture::pdo());
            $files = array_column($gen->generatePackage(DispatcherDemoFixture::WORKFLOW_ID)['files'], 'code', 'path');
            foreach (["cd dispatcher_demo_{$t}\n", '| `python workflow.py --cron [EXPR]` |', '| `python workflow.py --once ["text"]` |',
                      '`--quiet`', 'python api.py --listen', '`runs/` in this folder', 'Task Scheduler'] as $needle) {
                self::assertStringContainsString($needle, $files['README.md'], "{$t}: {$needle}");
            }
            self::assertStringContainsString($pins[$t], $files['requirements.txt'], $t);
            self::assertStringContainsString('pip install -r requirements.txt', $files['common.py'], "{$t}: a package installs its requirements.txt");
        }
    }
}
