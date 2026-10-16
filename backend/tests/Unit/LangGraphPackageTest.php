<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\LangGraphPackage;
use AgentTeam\Services\StartOptionGraph;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-15 langgraph standalone §5: the modular package carries everything it runs on. */
final class LangGraphPackageTest extends TestCase
{
    private const VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

    private const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        . "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

    private const PNG = "\x89PNG\r\n\x1a\n\x00\xff";

    private static function tempDir(string $prefix): string
    {
        $dir = sys_get_temp_dir() . '/' . $prefix . bin2hex(random_bytes(4));
        mkdir($dir, 0777, true);
        return $dir;
    }

    /** A skills root holding pdf-report (SKILL.md with a dependency, a script, a binary logo). */
    private function skillsRoot(): string
    {
        $root = self::tempDir('lgpkg_skills_');
        mkdir("$root/pdf-report/__pycache__", 0777, true);
        file_put_contents("$root/pdf-report/SKILL.md", "---\nname: pdf-report\ndependencies: [pypdf]\n---\nRender a PDF.\n");
        file_put_contents("$root/pdf-report/run.py", "print('pdf')\n");
        file_put_contents("$root/pdf-report/logo.png", self::PNG);
        file_put_contents("$root/pdf-report/__pycache__/run.cpython-312.pyc", "\x00junk");
        file_put_contents("$root/pdf-report/.DS_Store", "\x00junk");
        return $root;
    }

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    private function generator(array $graph, string $skillsRoot, bool $storage = false): LangGraphGenerator
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Email prototype', 'user_id' => '3',
            'output_storage_enabled' => $storage]));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return new LangGraphGenerator($this->pdo(), $wfRepo, $graphRepo, $agentRepo, $skillsRoot);
    }

    /** Start (17) on a Start option -> Reporter (19, skill pdf-report) -> Output (18); the Start carries one document. */
    private function graph(string $skillDir = 'pdf-report', array $documents = []): array
    {
        $raw = ['nodes' => [
                ['id' => '17', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 5, 'documents' => $documents]],
                ['id' => '19', 'node_type' => '', 'config' => ['type' => 'agent-template', 'agent_name' => 'Reporter',
                    'agent_type' => 'standard', 'instructions' => 'Summarize the mail.', 'agent_provider' => 'claude',
                    'model' => 'claude-sonnet-4-5', 'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
                    'bound_skill' => ['dir_name' => $skillDir]]],
                ['id' => '18', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [
                ['from_node_id' => '17', 'to_node_id' => '19', 'from_port' => 'output_1'],
                ['from_node_id' => '19', 'to_node_id' => '18', 'from_port' => 'output_1'],
            ]];
        return StartOptionGraph::expand($raw, fn(int $id) => ['name' => 'Outlook: get new email', 'code' => self::POLL,
            'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30,
            'start_trigger' => ['label' => 'Outlook: get new email', 'work_exit' => 'new_mail',
                'watch' => ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']]]]);
    }

    /** @return array<string, array{path:string,code:string,encoding?:string}> path => entry of the modular package */
    private function files(string $skillDir = 'pdf-report', array $documents = []): array
    {
        $result = $this->generator($this->graph($skillDir, $documents), $this->skillsRoot())->generate(44, '3', ['modular' => true]);
        $out = [];
        foreach ($result['files'] as $f) {
            $out[$f['path']] = $f;
        }
        return $out;
    }

    public function testPackageFiles(): void
    {
        $files = $this->files();   // path => entry
        self::assertSame(self::POLL, $files['code/start_outlook_get_new_email.py']['code']);
        self::assertArrayHasKey('code_harness.py', $files);
        self::assertSame(file_get_contents(__DIR__ . '/../../../frontend/assets/py/code_node_harness.py'), $files['code_harness.py']['code']);
        self::assertStringContainsString("pypdf\n", $files['requirements.txt']['code']);
        self::assertStringContainsString("fastapi\n", $files['requirements.txt']['code']);
        self::assertStringContainsString('MCP_URL_OUTLOOK=http://127.0.0.1:8770/mcp', $files['.env.example']['code']);
        self::assertStringContainsString('MCP_HEADERS_OUTLOOK=', $files['.env.example']['code']);
        self::assertStringContainsString('ANTHROPIC_API_KEY', $files['.env.example']['code']);
        self::assertStringContainsString('launchd', $files['README.md']['code']);
        self::assertSame('base64', $files['skills/pdf-report/logo.png']['encoding']);   // Review Focus 4
        self::assertSame(self::PNG, base64_decode($files['skills/pdf-report/logo.png']['code']));
        self::assertArrayNotHasKey('encoding', $files['skills/pdf-report/run.py']);
        self::assertSame("print('pdf')\n", $files['skills/pdf-report/run.py']['code']);
        self::assertArrayHasKey('skills/pdf-report/SKILL.md', $files);
        foreach (array_keys($files) as $p) {
            self::assertStringNotContainsString('__pycache__', $p);
            self::assertStringNotContainsString('.DS_Store', $p);
        }
    }

    public function testRequirementsAreSortedAndUnique(): void
    {
        $lines = explode("\n", rtrim($this->files()['requirements.txt']['code'], "\n"));
        $sorted = $lines;
        sort($sorted, SORT_STRING);
        self::assertSame($sorted, $lines);
        self::assertSame(array_values(array_unique($lines)), $lines);
        foreach (['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx', 'pydantic', 'python-dotenv',
                  'fastapi', 'uvicorn', 'pypdf'] as $pkg) {
            self::assertContains($pkg, $lines);
        }
    }

    public function testEnvExampleAndReadme(): void
    {
        $files = $this->files();
        $env = $files['.env.example']['code'];
        self::assertStringContainsString('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}', $env);
        foreach (['# MODEL_NAME=', '# SYNERGYAI_OUTPUT_ROOT=./outputs', '# RUNS_DIR=./runs'] as $needle) {
            self::assertStringContainsString($needle, $env);
        }
        $readme = $files['README.md']['code'];
        foreach (['python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt', 'cp .env.example .env',
                  '<string>ai.synergy.email-prototype</string>', 'runs/service.log', 'Restart=always', 'python api.py',
                  'outputs/', 'runs/', 'code/'] as $needle) {
            self::assertStringContainsString($needle, $readme);
        }
        self::assertMatchesRegularExpression('~\| `python workflow\.py --watch[^\n]*\(default\)~', $readme, 'this workflow\'s START_MODE is marked default');
        self::assertSame(1, substr_count($readme, '(default)'));
    }

    public function testCodeModuleReadsItsFile(): void
    {
        $files = $this->files();
        $mod = $files['agents/outlook_get_new_email.py']['code'] ?? null;   // modularLayout's name rule
        self::assertNotNull($mod);
        self::assertStringContainsString('"source_file": "code/start_outlook_get_new_email.py"', $mod);
        self::assertStringNotContainsString('poll_new_mail', $mod);
        self::assertStringContainsString('import code_harness as CODE_HARNESS', $files['common.py']['code']);
        self::assertStringNotContainsString('CODE_HARNESS_SOURCE', $files['common.py']['code']);
        self::assertStringContainsString('PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))', $files['common.py']['code']);
    }

    public function testCodeFileNames(): void
    {
        self::assertSame(['path' => 'code/start_outlook_get_new_email.py', 'code' => 'x'],
            LangGraphPackage::codeFile('1000000017', ['display' => 'Outlook: get new email', 'source' => 'x'], true));
        self::assertSame(['path' => 'code/4_check_mail.py', 'code' => 'y'],
            LangGraphPackage::codeFile('4', ['display' => 'Check mail', 'source' => 'y'], false));
    }

    public function testSingleFileKeepsEmbeddingAndSaysWhereSkillsComeFrom(): void
    {
        $code = $this->generator($this->graph(), $this->skillsRoot())->generate(44, '3')['code'];
        self::assertStringContainsString('poll_new_mail', $code);
        self::assertStringContainsString('CODE_HARNESS_SOURCE = ', $code);
        self::assertStringContainsString('Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills); '
            . 'use the modular package for a self-contained copy.', $code);
    }

    public function testPackageDefaultsPointInsideThePackage(): void
    {
        $common = $this->files()['common.py']['code'];
        self::assertStringContainsString('SKILLS_DIR = os.environ.get("SYNERGYAI_SKILLS_DIR") or os.path.join(PACKAGE_DIR, "skills")', $common);
        self::assertStringContainsString('os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")', $common);
        self::assertStringContainsString('os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(PACKAGE_DIR, "scratch")', $common);
    }

    public function testStartDocumentsAreCopiedAndTheirPathRewritten(): void
    {
        $dir = self::tempDir('lgpkg_docs_');
        file_put_contents("$dir/brief.txt", "the brief\n");
        file_put_contents("$dir/scan.pdf", "%PDF-1.4\n\x00\xff\xfe");
        $files = $this->files('pdf-report', [
            ['name' => 'brief.txt', 'path' => "$dir/brief.txt"],
            ['name' => 'scan.pdf', 'path' => "$dir/scan.pdf"],
            ['name' => 'gone.txt', 'path' => "$dir/gone.txt"],
        ]);
        self::assertSame("the brief\n", $files['start_documents/brief.txt']['code']);
        self::assertSame('base64', $files['start_documents/scan.pdf']['encoding']);
        $wf = $files['workflow.py']['code'];
        self::assertStringContainsString('"path": "start_documents/brief.txt"', $wf);
        self::assertStringContainsString('"path": "start_documents/scan.pdf"', $wf);
        self::assertStringContainsString('"path": "' . $dir . '/gone.txt"', $wf, 'an unreadable path is left as is');
        self::assertArrayNotHasKey('start_documents/gone.txt', $files);
        self::assertStringContainsString("pypdf\n", $files['requirements.txt']['code']);
    }

    public function testNothingPointsBackAtSynergyAI(): void
    {
        foreach ($this->files() as $path => $f) {
            if (in_array($path, ['.env.example', 'README.md'], true) || ($f['encoding'] ?? '') === 'base64') {
                continue;
            }
            self::assertStringNotContainsString('synergyAI/', $f['code'], $path);
            self::assertStringNotContainsString('/api/v1/', $f['code'], $path);
            self::assertStringNotContainsString('netfo587', $f['code'], $path);
            self::assertStringNotContainsString('localhost/gpt', $f['code'], $path);
        }
    }

    public function testMissingSkillFolderIsAnError(): void
    {
        $this->expectExceptionMessage('Skill folder "nope" not found under');
        $this->files('nope');
    }

    public function testEveryPythonFileOfThePackageCompiles(): void
    {
        exec('command -v python3', $o, $rc);
        if ($rc !== 0) {
            self::markTestSkipped('python3 missing');
        }
        $dir = self::tempDir('lgpkg_compile_');
        foreach ($this->files() as $path => $f) {
            @mkdir(dirname("$dir/$path"), 0777, true);
            file_put_contents("$dir/$path", ($f['encoding'] ?? '') === 'base64' ? base64_decode($f['code']) : $f['code']);
            if (str_ends_with($path, '.py')) {
                $out = [];
                exec('python3 -m py_compile ' . escapeshellarg("$dir/$path") . ' 2>&1', $out, $rc);
                self::assertSame(0, $rc, "$path: " . implode("\n", $out));
            }
        }
    }

    /** spec §5: a code node runs its code/ file through the harness; an edit takes effect on the next run. */
    public function testEditingACodeFileTakesEffectOnTheNextRun(): void
    {
        if (!is_file(self::VENV)) {
            self::markTestSkipped('venv python missing');
        }
        $graph = ['nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Check',
                    'code' => "def run(input, call_tool):\n    return {'route': 'work', 'output': 'first'}\n",
                    'exits' => ['work'], 'mcp_servers' => [], 'timeout_s' => 30]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']]];
        $files = $this->generator($graph, $this->skillsRoot(), true)->generate(44, '3', ['modular' => true])['files'];
        $dir = self::tempDir('lgpkg_run_');
        foreach ($files as $f) {
            @mkdir(dirname("$dir/{$f['path']}"), 0777, true);
            file_put_contents("$dir/{$f['path']}", ($f['encoding'] ?? '') === 'base64' ? base64_decode($f['code']) : $f['code']);
        }
        self::assertFileExists("$dir/code/2_check.py");
        $driver = "import importlib.util, sys\nspec = importlib.util.spec_from_file_location('prog', 'workflow.py')\n"
            . "m = importlib.util.module_from_spec(spec)\nsys.modules['prog'] = m\nspec.loader.exec_module(m)\n"
            . "view = m.ConsoleView('quiet')\nrec = m.RunRecorder(m.RUNS_DIR, m.WORKFLOW_ID, m.WORKFLOW_NAME, listeners=[view])\n"
            . "run = m.make_run_once('go', m.RunLoop(), view, rec, loop_mode=True)\n"
            . "print('RESULT', run())\n"
            . "open('code/2_check.py', 'w').write(\"def run(input, call_tool):\\n    return {'route': 'work', 'output': 'second'}\\n\")\n"
            . "print('RESULT', run())\n";
        file_put_contents("$dir/drive.py", $driver);
        $proc = proc_open([self::VENV, 'drive.py'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir,
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME')]);
        $text = (string) stream_get_contents($pipes[1]);
        $rc = proc_close($proc);
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString("RESULT first\n", $text);
        self::assertStringContainsString("RESULT second\n", $text);
        self::assertDirectoryExists("$dir/outputs", 'save_output writes inside the package by default');
    }
}
