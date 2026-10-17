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

    public function testEmitsThePackageFiles(): void
    {
        $paths = array_column($this->pkg()['files'], 'path');
        sort($paths);
        // the run server and script, plus the folder's own files (ADKPackage)
        $this->assertSame(['.env.example', 'README.md', '__init__.py', 'api.py', 'common.py', 'requirements.txt', 'workflow.py'], $paths);
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
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $wf = $files['workflow.py'];
        $this->assertStringNotContainsString('OUTPUT_STORAGE_ENABLED', self::runWorkflowBody($wf), 'saving leaked into run_workflow');
        $this->assertStringContainsString('saved = _save_output(output)', $wf);
    }

    public function testRunWorkflowDoesNotPreStripTheDocument(): void
    {
        // The editor extracts the document from the answer itself; stripping in run_workflow would lose any
        // narration around it, and with two documents the non-greedy regex would keep only the first.
        $files = array_column($this->pkg()['files'], 'code', 'path');
        $wf = $files['workflow.py'];
        $this->assertSame(1, substr_count($wf, '<!doctype html'));
        $this->assertStringNotContainsString('<!doctype html', self::runWorkflowBody($wf), 'document extraction leaked into run_workflow');
    }

    /** A workflow with a code node on an MCP server, as the package emits it. */
    private function codePackage(): array
    {
        $a = \Quantis\AIPortfolioAssistant\Tests\Unit\AdkCodeNodeTest::codeAnalyzed();
        $a['package'] = true;
        $files = array_column(\AgentTeam\Services\ADKPackage::files($a, sys_get_temp_dir()), 'code', 'path');
        $files['workflow.py'] = \AgentTeam\Services\ADKGenerator::emitAdk($a);
        return $files;
    }

    public function testCodeNodePackageCarriesItsOwnFiles(): void
    {
        $f = $this->codePackage();
        $this->assertSame("def run(input, call_tool):\n    return {'output': {'got': input}}\n", $f['code/2_c.py']);
        $this->assertSame(file_get_contents(dirname(__DIR__, 3) . '/frontend/assets/py/code_node_harness.py'), $f['code_harness.py']);
        $this->assertStringContainsString("fastapi\ngoogle-adk\nhttpx\nlitellm\npython-dotenv\nuvicorn\n", $f['requirements.txt']);
        $this->assertStringContainsString('MCP_URL_OUTLOOK=http://localhost:8770', $f['.env.example']);
        $this->assertStringContainsString('# MCP_HEADERS_OUTLOOK=', $f['.env.example']);
        $this->assertStringContainsString('reads .env from its own folder first, then from the folder two levels up', $f['.env.example']);
    }

    public function testPackageWorkflowReadsItsCodeFromTheFolder(): void
    {
        $wf = $this->codePackage()['workflow.py'];
        $this->assertStringContainsString('source_file="code/2_c.py"', $wf);
        $this->assertStringContainsString('import code_harness as CODE_HARNESS', $wf);
        $this->assertStringNotContainsString('CODE_HARNESS_SOURCE', $wf);
        $this->assertStringContainsString('os.path.join(PACKAGE_DIR, "outputs")', $wf);
        $single = \AgentTeam\Services\ADKGenerator::emitAdk(\Quantis\AIPortfolioAssistant\Tests\Unit\AdkCodeNodeTest::codeAnalyzed());
        $this->assertStringNotContainsString('source_file="', $single);
    }

    public function testPackageRunsFromItsOwnFolder(): void
    {
        $dir = sys_get_temp_dir() . '/adkpkg_' . bin2hex(random_bytes(4));
        foreach ($this->codePackage() as $path => $code) {
            @mkdir(dirname("$dir/$path"), 0777, true);
            file_put_contents("$dir/$path", $code);
        }
        // the folder's own modules import, and its code file is the one read (no ADK needed for this check)
        exec('cd ' . escapeshellarg($dir) . ' && python3 -c "import code_harness, ast; ast.parse(open(\'workflow.py\').read()); print(code_harness.check_code(open(\'code/2_c.py\').read()))" 2>&1', $out, $rc);
        $this->assertSame(0, $rc, implode("\n", $out));
    }

    /** Review I4: a playbook node runs the shared interpreter (langchain + langgraph): the package installs it. */
    public function testPlaybookPackageRequiresTheInterpreter(): void
    {
        $a = \Quantis\AIPortfolioAssistant\Tests\Unit\AdkCodeNodeTest::codeAnalyzed();
        $a['playbooks'] = ['7' => ['provider' => 'claude', 'display' => 'P', 'actions' => []]];
        $req = array_column(\AgentTeam\Services\ADKPackage::files($a, sys_get_temp_dir()), 'code', 'path')['requirements.txt'];
        foreach (['langchain-core', 'langgraph', 'langchain-anthropic'] as $pkg) {
            $this->assertContains($pkg, explode("\n", trim($req)));
        }
    }
}
