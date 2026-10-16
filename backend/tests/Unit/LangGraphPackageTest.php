<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\LangGraphPackage;
use AgentTeam\Services\StartDocumentStore;
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
        file_put_contents("$root/pdf-report/.env", "OPENAI_API_KEY=sk-skill-secret\n");
        file_put_contents("$root/pdf-report/.env.local", "OPENAI_API_KEY=sk-skill-secret\n");
        return $root;
    }

    /** A header value saved on the Outlook MCP server row: it must reach no generated file. */
    private const HEADER_SECRET = 'hdr-secret-5521';

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1, '{\"Authorization\": \"Bearer " . self::HEADER_SECRET . "\"}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    private function generator(array $graph, string $skillsRoot, bool $storage = false, ?StartDocumentStore $docs = null,
                               ?string $outputFolder = null): LangGraphGenerator
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Email prototype', 'user_id' => '3',
            'output_storage_enabled' => $storage || $outputFolder !== null, 'output_folder' => $outputFolder]));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return new LangGraphGenerator($this->pdo(), $wfRepo, $graphRepo, $agentRepo, $skillsRoot, $docs);
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
    private function files(string $skillDir = 'pdf-report', array $documents = [], ?StartDocumentStore $docs = null): array
    {
        $result = $this->generator($this->graph($skillDir, $documents), $this->skillsRoot(), false, $docs)->generate(44, '3', ['modular' => true]);
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
                  '<string>ai.synergy.email-prototype</string>', 'Restart=always', 'python api.py',
                  'outputs/', 'runs/', 'code/'] as $needle) {
            self::assertStringContainsString($needle, $readme);
        }
        self::assertMatchesRegularExpression('~\| `python workflow\.py --watch[^\n]*\(default\)~', $readme, 'this workflow\'s START_MODE is marked default');
        self::assertSame(1, substr_count($readme, '(default)'));
    }

    /**
     * Final review M-d: `cp .env.example .env` sets no variable to an empty value (an empty key or header line
     * would mask the runner's python/.env); the placeholders are comments, MCP_HEADERS_<SLUG>= still named.
     */
    public function testEnvExampleSetsNothingEmpty(): void
    {
        $env = $this->files()['.env.example']['code'];
        foreach (explode("\n", $env) as $line) {
            if (trim($line) === '' || str_starts_with(ltrim($line), '#')) {
                continue;
            }
            self::assertMatchesRegularExpression('/^[A-Z0-9_]+=\S/', $line, ".env.example sets an empty value: $line");
        }
        self::assertStringContainsString('# MCP_HEADERS_OUTLOOK=', $env);
        self::assertStringContainsString('# ANTHROPIC_API_KEY=', $env);
    }

    /** Final review M-h: launchd writes its log in the package folder (a fresh unzip has no runs/; launchd makes no folder). */
    public function testTheLaunchdLogIsInThePackageFolder(): void
    {
        $readme = $this->files()['README.md']['code'];
        self::assertSame(2, substr_count($readme, '<string>/path/to/email_prototype_modular/service.log</string>'), $readme);
        self::assertStringNotContainsString('runs/service.log', $readme);
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

    /**
     * Fix round 1 (Critical): a Start document is copied only from the requesting user's own document
     * storage (<root>/synergyaichatroot/<user folder>/<path>), never from an arbitrary server path.
     */
    public function testStartDocumentsAreCopiedOnlyFromTheUsersStorage(): void
    {
        $root = self::tempDir('lgpkg_storage_');
        $mine = "$root/synergyaichatroot/user_3/workflow_docs/44";
        mkdir($mine, 0777, true);
        mkdir("$root/synergyaichatroot/user_4", 0777, true);
        file_put_contents("$mine/doc_1_brief.txt", "the brief\n");
        file_put_contents("$mine/doc_2_scan.pdf", "%PDF-1.4\n\x00\xff\xfe");
        file_put_contents("$root/synergyaichatroot/user_4/secret.txt", "user 4's file\n");
        $outside = self::tempDir('lgpkg_outside_') . '/server.env';
        file_put_contents($outside, "DB_PASS=hunter2\n");
        symlink($outside, "$mine/doc_3_link.txt");
        $store = new StartDocumentStore('user_3', null, $root);

        $files = $this->files('pdf-report', [
            ['name' => 'brief.txt', 'path' => 'workflow_docs/44/doc_1_brief.txt', 'fullPath' => 'synergyaichatroot/user_3/workflow_docs/44/doc_1_brief.txt'],
            ['name' => 'scan.pdf', 'path' => 'workflow_docs/44/doc_2_scan.pdf'],
            ['name' => 'server.env', 'path' => $outside],                                    // absolute, outside storage
            ['name' => 'escape.txt', 'path' => 'workflow_docs/../../user_4/secret.txt'],     // ../ escape
            ['name' => 'link.txt', 'path' => 'workflow_docs/44/doc_3_link.txt'],             // symlink out of storage
            ['name' => 'mine.txt', 'path' => 'workflow_docs/44/doc_1_brief.txt', 'storage' => 'local'],   // on the user's machine
            ['name' => 'gone.txt', 'path' => 'workflow_docs/44/gone.txt'],
        ], $store);

        self::assertSame("the brief\n", $files['start_documents/doc_1_brief.txt']['code']);
        self::assertSame('base64', $files['start_documents/doc_2_scan.pdf']['encoding']);
        $docFiles = array_values(array_filter(array_keys($files), fn($p) => str_starts_with($p, 'start_documents/')));
        self::assertSame(['start_documents/doc_1_brief.txt', 'start_documents/doc_2_scan.pdf'], $docFiles);
        foreach ($files as $path => $f) {
            $bytes = ($f['encoding'] ?? '') === 'base64' ? base64_decode($f['code']) : $f['code'];
            self::assertStringNotContainsString('hunter2', $bytes, $path);
            self::assertStringNotContainsString("user 4's file", $bytes, $path);
        }
        $wf = $files['workflow.py']['code'];
        self::assertStringContainsString('"path": "start_documents/doc_1_brief.txt"', $wf);
        self::assertStringNotContainsString('synergyaichatroot/user_3', $wf, 'the copy drops fullPath');
        self::assertStringContainsString('"path": "' . $outside . '"', $wf, 'a path outside storage is left as is');
        self::assertStringContainsString('"path": "workflow_docs/../../user_4/secret.txt"', $wf);
        self::assertStringContainsString("pypdf\n", $files['requirements.txt']['code']);
    }

    public function testWithoutAStoreNoDocumentIsCopied(): void
    {
        $outside = self::tempDir('lgpkg_outside_') . '/brief.txt';
        file_put_contents($outside, "x\n");
        $files = $this->files('pdf-report', [['name' => 'brief.txt', 'path' => $outside]]);
        self::assertSame([], array_values(array_filter(array_keys($files), fn($p) => str_starts_with($p, 'start_documents/'))));
    }

    public function testStoreRefusesUnsafePaths(): void
    {
        foreach (['', '/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a//b', 'a\\b', "a\0b"] as $bad) {
            self::assertNull(StartDocumentStore::safeSegments($bad), json_encode($bad));
        }
        self::assertSame(['workflow_docs', '44', 'doc_1_a.txt'], StartDocumentStore::safeSegments('workflow_docs/44/doc_1_a.txt'));
        self::assertNull((new StartDocumentStore('../user_4', null, sys_get_temp_dir()))->read(['path' => 'secret.txt']));
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

    /**
     * The self-containment needles, over every file a generation returns: no synergyAI/ path (in
     * .env.example and README only on comment lines), no API base URL, no DB name, no header value.
     */
    private static function assertSelfContained(array $files, string $label): void
    {
        foreach ($files as $path => $f) {
            $code = is_array($f) ? $f['code'] : $f;
            if (is_array($f) && ($f['encoding'] ?? '') === 'base64') {
                continue;
            }
            self::assertStringNotContainsString(self::HEADER_SECRET, $code, "$label $path: header value");
            self::assertStringNotContainsString('sekret-conn-key', $code, "$label $path: header value");
            self::assertStringNotContainsString('/api/v1/', $code, "$label $path");
            self::assertStringNotContainsString('netfo587', $code, "$label $path");
            self::assertStringNotContainsString('localhost/gpt', $code, "$label $path");
            if (in_array($path, ['.env.example', 'README.md'], true)) {
                foreach (explode("\n", $code) as $line) {
                    if (!str_starts_with(ltrim($line), '#') || $path === 'README.md') {
                        self::assertStringNotContainsString('synergyAI/', $line, "$label $path: $line");
                    }
                }
            } elseif (str_ends_with($label, 'single')) {
                // Final review I2 (ruling): the single file reads its skills from SYNERGYAI_SKILLS_DIR, and its
                // header says where by default; that one line is the only synergyAI/ path it may name.
                foreach (explode("\n", $code) as $line) {
                    if (!str_contains($line, '# Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills)')) {
                        self::assertStringNotContainsString('synergyAI/', $line, "$label $path: $line");
                    }
                }
            } elseif ($path !== 'ARCHITECTURE.md' && !str_ends_with($label, 'a2a')) {
                self::assertStringNotContainsString('synergyAI/', $code, "$label $path");
            }
        }
    }

    /** @return array<string, string|array> path => entry (or code) of one generation */
    private static function byPath(array $result): array
    {
        if (!isset($result['files'])) {
            return [$result['filename'] => $result['code']];
        }
        $out = [];
        foreach ($result['files'] as $f) {
            $out[$f['path']] = $f;
        }
        return $out;
    }

    /** Fix round 1: the needles over more fixtures -- the dispatcher demo, a custom output folder, a header value. */
    public function testNothingPointsBackAtSynergyAIAcrossFixtures(): void
    {
        foreach (['single' => [], 'modular' => ['modular' => true], 'a2a' => ['a2a' => true]] as $mode => $opts) {
            self::assertSelfContained(self::byPath(LangGraphA2AGeneratorTest::generator()->generate(44, '3', $opts)), "dispatcher_demo $mode");
        }
        $custom = $this->generator($this->graph(), $this->skillsRoot(), false, null, 'reports/weekly')->generate(44, '3', ['modular' => true]);
        $files = self::byPath($custom);
        self::assertSelfContained($files, 'custom folder modular');
        self::assertStringContainsString('OUTPUT_FOLDER = "reports/weekly"', $files['workflow.py']['code']);
        // The header value on the server row of this fixture's PDO reaches no file of any mode.
        foreach (['single' => [], 'modular' => ['modular' => true]] as $mode => $opts) {
            self::assertSelfContained(self::byPath($this->generator($this->graph(), $this->skillsRoot())->generate(44, '3', $opts)), "header $mode");
        }
    }

    /**
     * Final review I2/I3: output storage ON. The single file saves next to itself (outputs/, SYNERGYAI_OUTPUT_ROOT
     * overrides) and the modular workflow.py says where the package saves; neither names a synergyAI/ path.
     */
    public function testOutputStorageOnStaysSelfContained(): void
    {
        foreach (['single' => [], 'modular' => ['modular' => true]] as $mode => $opts) {
            $files = self::byPath($this->generator($this->graph(), $this->skillsRoot(), true)->generate(44, '3', $opts));
            self::assertSelfContained($files, "storage on $mode");
            $entry = $mode === 'single' ? (string) reset($files) : $files['workflow.py']['code'];
            self::assertStringContainsString('OUTPUT_STORAGE_ENABLED = True', $entry, $mode);
            self::assertStringContainsString('# Output storage (Output node setting): ON -> outputs/workflow/ '
                . ($mode === 'single' ? 'next to this script' : 'in this folder') . ' (SYNERGYAI_OUTPUT_ROOT overrides)', $entry, $mode);
        }
        $single = $this->generator($this->graph(), $this->skillsRoot(), true)->generate(44, '3')['code'];
        self::assertStringContainsString('root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")', $single);
        self::assertStringContainsString("SKILLS_DIR = os.environ.get(\n    \"SYNERGYAI_SKILLS_DIR\",", $single, 'the single file keeps the skills default (spec §5)');
        // A custom folder is named as it is.
        $custom = self::byPath($this->generator($this->graph(), $this->skillsRoot(), true, null, 'reports/weekly')->generate(44, '3', ['modular' => true]));
        self::assertStringContainsString('# Output storage (Output node setting): ON -> reports/weekly', $custom['workflow.py']['code']);
    }

    public function testMissingSkillFolderIsAnError(): void
    {
        $this->expectExceptionMessage('Skill folder "nope" is not available on this server, so it can\'t be packaged.');
        $this->files('nope');
    }

    /** Fix rounds 1-2: dir_name is plain path segments (a grouped skill has two) inside the skills root. */
    public function testUnsafeSkillDirNamesAreRefused(): void
    {
        foreach (['.', '..', '../pdf-report', 'pdf-report/..', 'GEO/../x', './x', 'GEO//x', 'a\\b', '/tmp'] as $bad) {
            try {
                $this->files($bad);
                self::fail("accepted skill dir " . json_encode($bad));
            } catch (\RuntimeException $e) {
                self::assertSame('Skill folder "' . $bad . '" is not available on this server, so it can\'t be packaged.', $e->getMessage());
                self::assertStringNotContainsString(sys_get_temp_dir(), $e->getMessage());
            }
        }
    }

    public function testAGroupedSkillIsPackagedUnderItsGroup(): void
    {
        $root = $this->skillsRoot();
        mkdir("$root/GEO/geo-report/scripts", 0777, true);
        file_put_contents("$root/GEO/geo-report/SKILL.md", "---\nname: geo-report\ndependencies: [beautifulsoup4]\n---\nReport.\n");
        file_put_contents("$root/GEO/geo-report/scripts/make.py", "print('geo')\n");
        $result = $this->generator($this->graph('GEO/geo-report'), $root)->generate(44, '3', ['modular' => true]);
        $files = array_column($result['files'], null, 'path');
        self::assertSame("print('geo')\n", $files['skills/GEO/geo-report/scripts/make.py']['code']);
        self::assertArrayHasKey('skills/GEO/geo-report/SKILL.md', $files);
        self::assertStringContainsString("beautifulsoup4\n", $files['requirements.txt']['code']);
        self::assertStringContainsString('| `skills/GEO/geo-report/` |', $result['architecture']);
    }

    /** Fix round 2: the universalFS adapter path -- the read goes to the user's own folder, never through fullPath. */
    public function testStoreReadsThroughTheUsersAdapter(): void
    {
        $adapter = new class {
            public array $reads = [];
            public function readStream(string $path)
            {
                $this->reads[] = $path;
                if ($path !== '/synergyaichatroot/user_3/workflow_docs/44/doc_1_a.txt') {
                    throw new \RuntimeException('not found');
                }
                $s = fopen('php://memory', 'r+');
                fwrite($s, "from the adapter\n");
                rewind($s);
                return $s;
            }
        };
        $connects = 0;
        $store = new StartDocumentStore('user_3', function () use ($adapter, &$connects) { $connects++; return $adapter; }, null);
        self::assertSame("from the adapter\n", $store->read(['path' => 'workflow_docs/44/doc_1_a.txt',
            'fullPath' => 'synergyaichatroot/user_4/secret.txt']));
        self::assertNull($store->read(['path' => 'workflow_docs/44/gone.txt']));
        self::assertNull($store->read(['path' => '../user_4/secret.txt']));
        self::assertNull($store->read(['path' => 'workflow_docs/44/doc_1_a.txt', 'storage' => 'local']));
        self::assertSame(['/synergyaichatroot/user_3/workflow_docs/44/doc_1_a.txt', '/synergyaichatroot/user_3/workflow_docs/44/gone.txt'],
            $adapter->reads, 'unsafe and local documents never reach the adapter; fullPath is ignored');
        self::assertSame(1, $connects, 'the adapter is connected once');
    }

    public function testEnvFilesOfASkillAreNotCopied(): void
    {
        $files = $this->files();
        self::assertArrayNotHasKey('skills/pdf-report/.env', $files);
        self::assertArrayNotHasKey('skills/pdf-report/.env.local', $files);
        foreach ($files as $path => $f) {
            self::assertStringNotContainsString('sk-skill-secret', $f['code'], $path);
        }
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
