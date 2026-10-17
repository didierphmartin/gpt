<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Support\DispatcherDemoFixture;

/** ARCHITECTURE.md of ADK, MAF and NOOA in each code structure, as LangGraph's (LangGraphArchitectureDocTest). */
class CompiledArchitectureDocTest extends TestCase
{
    public static function cases(): array
    {
        $out = [];
        foreach (['ADKGenerator' => 'adk', 'MAFGenerator' => 'maf', 'NOOAGenerator' => 'nooa'] as $cls => $t) {
            foreach (['single', 'modular', 'a2a'] as $mode) {
                $out["{$t} {$mode}"] = ["AgentTeam\\Services\\{$cls}", $mode];
            }
        }
        return $out;
    }

    private static function compile(string $cls, string $mode): array
    {
        $gen = DispatcherDemoFixture::generator($cls, DispatcherDemoFixture::pdo());
        return match ($mode) {
            'single' => $gen->generate(DispatcherDemoFixture::WORKFLOW_ID),
            'modular' => $gen->generatePackage(DispatcherDemoFixture::WORKFLOW_ID),
            default => $gen->generateA2A(DispatcherDemoFixture::WORKFLOW_ID),
        };
    }

    /** @dataProvider cases */
    public function testEveryStructureCarriesItsArchitecture(string $cls, string $mode): void
    {
        $r = self::compile($cls, $mode);
        $doc = (string) $r['architecture'];
        self::assertStringStartsWith('# Dispatcher demo: architecture', $doc);
        foreach (['## Files', '## Class diagram', "```mermaid\nclassDiagram", '## Workflow diagram', "```mermaid\nflowchart LR",
                  '## Classes and functions', '## How a run flows', '## How to change it'] as $section) {
            self::assertStringContainsString($section, $doc, $mode);
        }
        if ($mode !== 'single') {
            $last = end($r['files']);
            self::assertSame('ARCHITECTURE.md', $last['path'], 'written beside the code, last');
            self::assertSame($doc, $last['code']);
        }
    }

    /** @dataProvider cases */
    public function testItDescribesOnlyWhatTheCodeDefines(string $cls, string $mode): void
    {
        $r = self::compile($cls, $mode);
        $code = isset($r['files']) ? implode("\n", array_column($r['files'], 'code')) : $r['code'];
        preg_match_all('/^### `([A-Za-z_]+)`/m', (string) $r['architecture'], $m);
        self::assertNotEmpty($m[1]);
        foreach ($m[1] as $name) {
            self::assertMatchesRegularExpression('/^\s*(?:async\s+def|def|class)\s+' . preg_quote($name, '/') . '\b|^' . preg_quote($name, '/') . '\s*=/m',
                $code, "{$mode}: {$name} is described but not defined");
        }
        // every file the table names is a file of the compile
        preg_match_all('/^\| `([^`]+)` \|/m', (string) $r['architecture'], $f);
        $paths = isset($r['files']) ? array_column($r['files'], 'path') : [$r['filename']];
        foreach ($f[1] as $p) {
            if (!str_ends_with($p, '/')) {
                self::assertTrue(in_array($p, $paths, true) || ($mode === 'single' && $p === $r['filename']), "{$mode}: {$p}");
            }
        }
    }
}
