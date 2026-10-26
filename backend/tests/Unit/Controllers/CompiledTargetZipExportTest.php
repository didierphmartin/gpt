<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\WorkflowController;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

/** ADK, MAF and NOOA exported as a zip in the chosen code structure (generate-adk|maf|nooa?format=zip). */
final class CompiledTargetZipExportTest extends TestCase
{
    private static function entries(string $bytes): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ctzip');
        file_put_contents($tmp, $bytes);
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($tmp) === true);
        $out = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $out[] = $zip->getNameIndex($i);
        }
        $zip->close();
        unlink($tmp);
        return $out;
    }

    public static function targets(): array
    {
        return [['ADKGenerator', 'adk'], ['MAFGenerator', 'maf'], ['NOOAGenerator', 'nooa']];
    }

    /** @dataProvider targets */
    public function testSingleFileZip(string $class, string $target): void
    {
        $gen = DispatcherDemoFixture::generator("AgentTeam\\Services\\{$class}", DispatcherDemoFixture::pdo());
        $r = WorkflowController::langGraphZipResponse($gen->generate(DispatcherDemoFixture::WORKFLOW_ID), "{$target}_single");
        $this->assertSame("attachment; filename=\"dispatcher_demo_{$target}_single.zip\"", $r['headers']['Content-Disposition']);
        // the script, its ARCHITECTURE.md and what installs and configures it, as LangGraph's single-file zip
        $this->assertSame(array_map(fn($p) => "dispatcher_demo_{$target}/{$p}",
            ["dispatcher_demo_{$target}.py", 'ARCHITECTURE.md', 'requirements.txt', '.env.example', 'README.md']),
            self::entries($r['raw_body']));
    }

    /**
     * The single-file README is the script's own: its file name, its one-run CLI, the .env variables to set,
     * and the requirements.txt beside it holds the pins the script's TO RUN line installs.
     *
     * @dataProvider targets
     */
    public function testSingleFileReadmeAndRequirementsMatchTheScript(string $class, string $target): void
    {
        $gen = DispatcherDemoFixture::generator("AgentTeam\\Services\\{$class}", DispatcherDemoFixture::pdo());
        $result = $gen->generate(DispatcherDemoFixture::WORKFLOW_ID);
        $files = array_column($result['package_files'], 'code', 'path');
        $readme = $files['README.md'];
        foreach (["cd dispatcher_demo_{$target}", "python dispatcher_demo_{$target}.py \"your prompt\"", 'py -m venv .venv',
                  '.venv\Scripts\activate', 'copy .env.example .env', 'Python 3.10', '`DEEPSEEK_API_KEY` -- required'] as $needle) {
            $this->assertStringContainsString($needle, $readme, $needle);
        }
        foreach (['--cron', '--watch', '--listen', 'api.py'] as $absent) {
            $this->assertStringNotContainsString($absent, $readme, "{$target}: the single file has no {$absent}");
        }
        preg_match('/^  (pip install .*)$/m', $result['code'], $m);
        $pins = array_map(fn($a) => trim($a, '"'), explode(' ', substr($m[1], strlen('pip install '))));
        $this->assertSame(explode("\n", rtrim($files['requirements.txt'], "\n")), $pins, 'TO RUN installs requirements.txt');
    }

    /** @dataProvider targets */
    public function testModularZipHoldsThePackage(string $class, string $target): void
    {
        $gen = DispatcherDemoFixture::generator("AgentTeam\\Services\\{$class}", DispatcherDemoFixture::pdo());
        $pkg = $gen->generatePackage(DispatcherDemoFixture::WORKFLOW_ID);
        $r = WorkflowController::langGraphZipResponse($pkg, "{$target}_modular");
        $this->assertSame("attachment; filename=\"dispatcher_demo_{$target}_modular.zip\"", $r['headers']['Content-Disposition']);
        $this->assertSame(array_map(fn($f) => "dispatcher_demo_{$target}/{$f['path']}", $pkg['files']), self::entries($r['raw_body']));
    }
}
