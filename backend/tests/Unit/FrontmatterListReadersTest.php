<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\LangGraphPackage;
use AgentTeam\Services\LangGraphRuntime;
use AgentTeam\Services\PythonEmitHelpers;
use PHPUnit\Framework\TestCase;

/**
 * Frontmatter list readers split on commas OUTSIDE quotes, so a pip range or extras written by the frontmatter form
 * (`dependencies: [pandas>=2, 'numpy>=1.20,<2', 'requests[socks,security]']`) reads back as written. Same table as
 * frontend/tests/frontmatter-list.test.mjs: the PHP reader (compile + the store's dependencies) and the emitted
 * Python of compiled programs (ADK/MAF/NOOA skillDepsBlock, LangGraph skillRuntimeBlock).
 */
class FrontmatterListReadersTest extends TestCase
{
    /** @return array{cases: list<array{name:string,value:string,items:list<string>}>, form: array{value:string,items:list<string>}} */
    private static function table(): array
    {
        return json_decode((string) file_get_contents(__DIR__ . '/../../../frontend/tests/fixtures/frontmatter-list-cases.json'), true);
    }

    /** @return list<array{name:string,value:string,items:list<string>}> every case plus the form's line */
    private static function all(): array
    {
        $t = self::table();
        return [...$t['cases'], ['name' => 'form output', 'value' => $t['form']['value'], 'items' => $t['form']['items']]];
    }

    public function testPhpReaders(): void
    {
        foreach (self::all() as $c) {
            self::assertSame($c['items'], LangGraphPackage::listItems($c['value']), $c['name']);
            self::assertSame($c['items'], LangGraphPackage::skillDependencies("---\nname: a\ndependencies: {$c['value']}\n---\nbody\n"), $c['name']);
            self::assertSame($c['items'], LangGraphPackage::declaredSkills("---\nname: a\nrequires-skills: {$c['value']}\n---\n"), $c['name']);
        }
    }

    /** The emitted readers, run with python3: each case's dependencies, in order, as the pip calls see them. */
    public function testEmittedPythonReaders(): void
    {
        exec('command -v python3', $o, $rc);
        if ($rc !== 0) {
            self::markTestSkipped('python3 missing');
        }
        $dir = sys_get_temp_dir() . '/fmlist_' . bin2hex(random_bytes(4));
        $cases = self::all();
        foreach ($cases as $i => $c) {
            mkdir("$dir/skills/c$i", 0777, true);
            file_put_contents("$dir/skills/c$i/SKILL.md", "---\nname: c$i\ndependencies: {$c['value']}\n---\n");
        }
        $probe = <<<'PY'
calls = []
class R:
    returncode, stderr = 0, ""
subprocess.run = lambda argv, **kw: calls.append(argv[-1]) or R()
out = []
for i in range(int(sys.argv[1])):
    calls.clear()
    ENSURE(os.path.join(sys.argv[2], "skills", f"c{i}"))
    out.append(list(calls))
print("RESULT " + json.dumps(out))
PY;
        $head = "from __future__ import annotations\nimport os, sys, subprocess, threading, json, re, time, asyncio, shutil\n"
            . "from functools import cached_property\ndef node_print(line):\n    pass\n";
        $progs = [
            'skillDepsBlock' => $head . PythonEmitHelpers::skillDepsBlock() . "\n_importable = lambda d: False\n"
                . "def ENSURE(p):\n    _INSTALLED_DEPS.clear()\n    _ensure_skill_deps(p)\n" . $probe,
            'skillRuntimeBlock' => $head . 'PACKAGE_DIR = ' . var_export($dir, true) . "\n" . LangGraphRuntime::skillRuntimeBlock(true)
                . "\nSKILLS._importable = lambda d: False\n"
                . "def ENSURE(p):\n    SKILLS._installed_deps.clear()\n    SKILLS.ensure_deps(p)\n" . $probe,
        ];
        $expect = array_map(fn(array $c) => $c['items'], $cases);
        foreach ($progs as $label => $py) {
            file_put_contents("$dir/probe.py", $py);
            $out = [];
            exec('python3 ' . escapeshellarg("$dir/probe.py") . ' ' . count($cases) . ' ' . escapeshellarg($dir) . ' 2>&1', $out, $rc);
            self::assertSame(0, $rc, $label . "\n" . implode("\n", $out));
            $line = array_values(array_filter($out, fn(string $l) => str_starts_with($l, 'RESULT ')));
            self::assertCount(1, $line, $label . "\n" . implode("\n", $out));
            $got = json_decode(substr($line[0], 7), true);
            foreach ($cases as $i => $c) {
                self::assertSame($c['items'], $got[$i], "$label: {$c['name']}");
            }
            self::assertSame($expect, $got, $label);
        }
        exec('rm -rf ' . escapeshellarg($dir));
    }
}
