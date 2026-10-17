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
        $this->assertSame(["dispatcher_demo_{$target}/dispatcher_demo_{$target}.py"], self::entries($r['raw_body']));
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
