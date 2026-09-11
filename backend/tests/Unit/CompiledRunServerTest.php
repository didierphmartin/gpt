<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * The compiled package's run server: event sink, server gate mode, api.py.
 * Each test writes the generated package to a temp dir and runs a Python
 * probe against it, so these assert BEHAVIOUR of the emitted code, not text.
 */
class CompiledRunServerTest extends TestCase
{
    /** Write the modular manifest for workflow 44 to a fresh temp dir; returns the package root. */
    public static function writePackage(): string
    {
        $m = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['modular' => true]);
        $root = sys_get_temp_dir() . '/compiled_' . bin2hex(random_bytes(6));
        foreach ($m['files'] as $f) {
            $path = $root . '/' . $f['path'];
            @mkdir(dirname($path), 0777, true);
            file_put_contents($path, $f['code']);
        }
        return $root;
    }

    /** Run a probe script from tests/fixtures/compiled/ with the package root as argv[1]. */
    protected function probe(string $name, string $root): array
    {
        $probe = __DIR__ . '/../fixtures/compiled/' . $name;
        exec('python3 ' . escapeshellarg($probe) . ' ' . escapeshellarg($root) . ' 2>&1', $out, $rc);
        return [$rc, implode("\n", $out)];
    }

    public function testEventSinkIsInertUntilInstalledThenReceivesPlaybookEvents(): void
    {
        [$rc, $out] = $this->probe('sink_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }
}
