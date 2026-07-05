<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PythonEmitHelpers;

/**
 * Pins the byte-exact content of the shared Python emit blocks.
 *
 * These blocks are emitted VERBATIM by BOTH LangGraphGenerator and (from Task 5/6)
 * ADKGenerator. A change here silently alters the generated Python of every
 * compiled workflow across both backends. If a future task intentionally changes
 * a block, update the hash below in the same commit — the diff is the review gate.
 */
class PythonEmitHelpersPinTest extends TestCase
{
    public function testMcpClientBlockUnchanged(): void
    {
        $block = PythonEmitHelpers::mcpClientBlock();
        $this->assertSame(4091, strlen($block), 'mcpClientBlock byte length changed');
        $this->assertSame(
            'dea9689a2fe6887f70ec4a4671d974317bbef325ebba577b2764e844406f8557',
            hash('sha256', $block),
            'mcpClientBlock content changed — this alters generated Python for both generators'
        );
    }

    public function testSkillDepsBlockUnchanged(): void
    {
        $block = PythonEmitHelpers::skillDepsBlock();
        $this->assertSame(2423, strlen($block), 'skillDepsBlock byte length changed');
        $this->assertSame(
            '79f69500a85e9aa03f75f4336d93f8913bb954608a18e59885f90207af20948d',
            hash('sha256', $block),
            'skillDepsBlock content changed — this alters generated Python for both generators'
        );
    }

    public function testDocumentConverterBlockUnchanged(): void
    {
        $block = PythonEmitHelpers::documentConverterBlock();
        $this->assertSame(5127, strlen($block), 'documentConverterBlock byte length changed');
        $this->assertSame(
            '0d4241548ff1d929cc88d083501cb8e1d9df126b719bc258d2f1cca7400c8dd1',
            hash('sha256', $block),
            'documentConverterBlock content changed — this alters generated Python for both generators'
        );
    }

    public function testSkillFsSyncBlockUnchanged(): void
    {
        $block = PythonEmitHelpers::skillFsSyncBlock();
        $this->assertSame(6104, strlen($block), 'skillFsSyncBlock byte length changed');
        $this->assertSame(
            '87bfaf53a4e706e1ca9936fd814a86b4c52d14c7aabb16eb37b5ef2265890af4',
            hash('sha256', $block),
            'skillFsSyncBlock content changed — this alters generated Python for both generators'
        );
    }
}
