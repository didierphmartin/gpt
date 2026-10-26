<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\WorkflowController;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\LangGraphA2AGeneratorTest;

/**
 * GET /api/v1/workflows/{id}/generate-python?format=zip: the same generation
 * as Display Code for the chosen mode, as one zip under one folder, with
 * ARCHITECTURE.md beside the code.
 */
final class LangGraphZipExportTest extends TestCase
{
    /** Response for one mode, built from the real wf-44-shaped generation. */
    private function export(string $mode): array
    {
        $result = LangGraphA2AGeneratorTest::generator()->generate(44, '3', $mode === 'single' ? [] : [$mode => true]);
        return WorkflowController::langGraphZipResponse($result, $mode);
    }

    /** name => contents of every entry in the zip bytes. */
    private static function entries(string $bytes): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'lgzip');
        file_put_contents($tmp, $bytes);
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($tmp) === true, 'the body is a readable zip');
        $out = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            $out[$name] = $zip->getFromIndex($i);
        }
        $zip->close();
        unlink($tmp);
        return $out;
    }

    public function testSingleModeZipsTheScriptAndItsArchitecture(): void
    {
        $r = $this->export('single');
        $this->assertSame(200, $r['status_code']);
        $this->assertSame('application/zip', $r['headers']['Content-Type']);
        $this->assertSame('attachment; filename="dispatcher_demo_single.zip"', $r['headers']['Content-Disposition']);
        $e = self::entries($r['raw_body']);
        $this->assertSame(array_map(fn($p) => "dispatcher_demo_langgraph/{$p}",
            ['dispatcher_demo_langgraph.py', 'ARCHITECTURE.md', 'requirements.txt', '.env.example', 'README.md']), array_keys($e));
        $this->assertStringContainsString('python dispatcher_demo_langgraph.py --cron [EXPR]', $e['dispatcher_demo_langgraph/README.md']);
        $this->assertStringContainsString('# ANTHROPIC_API_KEY=', $e['dispatcher_demo_langgraph/.env.example']);
        $this->assertStringContainsString('"""Standalone LangGraph workflow: Dispatcher demo', $e['dispatcher_demo_langgraph/dispatcher_demo_langgraph.py']);
        $this->assertStringStartsWith('# Dispatcher demo: architecture', $e['dispatcher_demo_langgraph/ARCHITECTURE.md']);
    }

    public function testMultiFileModesZipEveryFileUnderTheirRoot(): void
    {
        foreach (['modular' => 'dispatcher_demo_modular', 'a2a' => 'dispatcher_demo_a2a'] as $mode => $root) {
            $result = LangGraphA2AGeneratorTest::generator()->generate(44, '3', [$mode => true]);
            $r = WorkflowController::langGraphZipResponse($result, $mode);
            $this->assertSame("attachment; filename=\"dispatcher_demo_{$mode}.zip\"", $r['headers']['Content-Disposition'], $mode);
            $e = self::entries($r['raw_body']);
            $expected = array_map(fn($f) => "{$root}/{$f['path']}", $result['files']);
            $this->assertSame($expected, array_keys($e), $mode);
            $this->assertContains("{$root}/ARCHITECTURE.md", array_keys($e), $mode);
            foreach ($result['files'] as $f) {
                $this->assertSame($f['code'], $e["{$root}/{$f['path']}"], "{$mode}: {$f['path']}");
            }
        }
    }

    public function testAResultWithoutArchitectureStillZipsItsFiles(): void
    {
        // A swarm package carries no ARCHITECTURE.md: its files are zipped as they are.
        $r = WorkflowController::langGraphZipResponse(['root' => 'crew_modular_swarm',
            'files' => [['path' => 'workflow.py', 'code' => 'print(1)']]], 'modular');
        $this->assertSame('attachment; filename="crew_modular.zip"', $r['headers']['Content-Disposition']);
        $this->assertSame(['crew_modular_swarm/workflow.py'], array_keys(self::entries($r['raw_body'])));
    }

    public function testABase64EntryIsZippedAsItsBytes(): void
    {
        // A skill's binary file (or a Start document) travels base64-encoded in the result.
        $r = WorkflowController::langGraphZipResponse(['root' => 'crew_modular',
            'files' => [['path' => 'workflow.py', 'code' => 'print(1)'],
                        ['path' => 'skills/s/a.png', 'code' => base64_encode("\x00\xff"), 'encoding' => 'base64']]], 'modular');
        $e = self::entries($r['raw_body']);
        $this->assertSame("\x00\xff", $e['crew_modular/skills/s/a.png']);
        $this->assertSame('print(1)', $e['crew_modular/workflow.py']);
    }

    public function testASingleFileWithoutArchitectureZipsTheScriptAlone(): void
    {
        // An ingestion pipeline (or a doc that failed to build) has architecture = null.
        $r = WorkflowController::langGraphZipResponse(['filename' => 'feed_langgraph.py', 'code' => 'print(1)',
            'architecture' => null], 'single');
        $this->assertSame(['feed_langgraph/feed_langgraph.py'], array_keys(self::entries($r['raw_body'])));
    }
}
