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
}
