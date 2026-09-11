<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Spec §8: the run protocol has three implementations (the PHP interpreter,
 * the browser-side node runner, the compiled run server). This pins the
 * contract so a change to one side fails the others' suite.
 */
class RunProtocolConformanceTest extends TestCase
{
    private static function contract(): array
    {
        return json_decode(file_get_contents(__DIR__ . '/../../../docs/run-protocol-v1.json'), true);
    }

    public function testTheCompiledServerEmitsOnlyContractEvents(): void
    {
        $root = CompiledRunServerTest::writePackage();
        $probe = __DIR__ . '/../fixtures/compiled/conformance_probe.py';
        exec('python3 ' . escapeshellarg($probe) . ' ' . escapeshellarg($root)
            . ' ' . escapeshellarg(__DIR__ . '/../../../docs/run-protocol-v1.json') . ' 2>&1', $out, $rc);
        $this->assertSame(0, $rc, implode("\n", $out));
    }

    /**
     * JSON-Schema property types share the `'type' => '...'` shape with run
     * events, so the scan skips the schema vocabulary. Anything else the
     * interpreter emits must be described by the contract.
     */
    private const SCHEMA_WORDS = ['array', 'boolean', 'function', 'integer', 'number', 'object', 'string', 'prompt'];

    public function testThePhpInterpreterEmitsOnlyContractEvents(): void
    {
        $contract = self::contract();
        $dir = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(__DIR__ . '/../../src/Playbook'));
        $emitted = [];
        foreach ($dir as $file) {
            if ($file->isFile() && $file->getExtension() === 'php') {
                preg_match_all("/'type'\s*=>\s*'([a-z_]+)'/", file_get_contents($file->getPathname()), $m);
                foreach ($m[1] as $t) {
                    $emitted[$t] = true;
                }
            }
        }
        $emitted = array_diff(array_keys($emitted), self::SCHEMA_WORDS);
        $this->assertNotEmpty($emitted, 'found no emitted event types — the scan path is wrong');
        $known = array_merge(array_keys($contract['events']), ['error', 'done']);
        foreach ($emitted as $type) {
            $this->assertContains($type, $known, "the PHP interpreter emits '{$type}', which run-protocol-v1.json does not describe");
        }
    }
}
