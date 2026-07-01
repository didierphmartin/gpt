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
}
