<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;
use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PythonEmitHelpers;
class PythonEmitHelpersTest extends TestCase
{
    public function testPyStrEscapes(): void
    {
        $out = PythonEmitHelpers::pyStr("line1\nquote\"x");
        $this->assertStringContainsString('\\n', $out);
        $this->assertStringContainsString('\\"', $out);
    }
    public function testJsonToPythonNullTrueFalse(): void
    {
        $out = PythonEmitHelpers::jsonToPython(['a' => null, 'b' => true, 'c' => false]);
        $this->assertStringContainsString('None', $out);
        $this->assertStringContainsString('True', $out);
        $this->assertStringContainsString('False', $out);
    }

    /** A very long string value compiles (no PCRE JIT stack exhaustion) and evaluates back to the original. */
    public function testPyLiteralHandlesLongAndEscapedStrings(): void
    {
        $values = [
            ['k' => str_repeat('x', 200000), 'b' => true, 'n' => null],
            ['k' => str_repeat('a"b\\c true null ', 20000), 'f' => false],
        ];
        foreach ($values as $v) {
            $lit = PythonEmitHelpers::pyLiteral($v);
            $f = tempnam(sys_get_temp_dir(), 'pylit');
            file_put_contents($f, $lit);
            exec('python3 -c ' . escapeshellarg('import sys,json; print(json.dumps(eval(open(sys.argv[1]).read())))') . ' ' . escapeshellarg($f) . ' 2>&1', $out, $rc);
            @unlink($f);
            $this->assertSame(0, $rc, implode("\n", $out));
            $this->assertEquals($v, json_decode(implode("\n", $out), true));
            $out = [];
        }
        $this->assertSame('{"a":True,"b":"true","c":None}', PythonEmitHelpers::pyLiteral(['a' => true, 'b' => 'true', 'c' => null]));
    }
}
