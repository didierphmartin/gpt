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
        $this->assertSame(4959, strlen($block), 'mcpClientBlock byte length changed');
        $this->assertSame(
            '834b131509dd600011ad0a1002a1fc1e4246076b61f5af4200b16e66f148f0e6',
            hash('sha256', $block),
            'mcpClientBlock content changed — this alters generated Python for both generators'
        );
    }

    public function testSkillDepsBlockUnchanged(): void
    {
        $block = PythonEmitHelpers::skillDepsBlock();
        $this->assertSame(4380, strlen($block), 'skillDepsBlock byte length changed');
        $this->assertSame(
            '3904a498a7210c65e9d783bd60670af8a45e3aac3c2ca77c6434802d42049a15',
            hash('sha256', $block),
            'skillDepsBlock content changed — this alters generated Python for both generators'
        );
    }

    /** Skill-store Task 13: a skill with .wheels/native/ installs its dependencies in one pip call, from that folder only. */
    public function testSkillDepsBlockInstallsFromTheSkillsOwnWheels(): void
    {
        exec('command -v python3', $o, $rc);
        if ($rc !== 0) {
            $this->markTestSkipped('python3 missing');
        }
        $dir = sys_get_temp_dir() . '/skilldeps_' . bin2hex(random_bytes(4));
        mkdir("$dir/wheels/.wheels/native", 0777, true);
        mkdir("$dir/plain", 0777, true);
        mkdir("$dir/have", 0777, true);
        // Already installed (a distribution, a module): no pip process at all, as in LangGraph's _importable.
        file_put_contents("$dir/have/SKILL.md", "---\nname: have\ndependencies: [pip>=1, json]\n---\n");
        file_put_contents("$dir/wheels/.wheels/native/zz_a-1.0-py3-none-any.whl", 'PK');
        foreach (['wheels', 'plain'] as $s) {
            file_put_contents("$dir/$s/SKILL.md", "---\nname: $s\ndependencies: [zz-a, zz-b>=1.0]\n---\n");
        }
        $py = "import os, sys, subprocess, threading, json\n" . PythonEmitHelpers::skillDepsBlock() . "\n" . <<<'PY'
calls = []
class R:
    returncode, stderr = 0, ""
subprocess.run = lambda argv, **kw: calls.append(argv[3:]) or R()
root = sys.argv[1]
_ensure_skill_deps(os.path.join(root, "wheels"))
_ensure_skill_deps(os.path.join(root, "wheels"))   # once per process
print(json.dumps(calls).replace(root, "<root>"))
_INSTALLED_DEPS.clear()
calls.clear()
_ensure_skill_deps(os.path.join(root, "plain"))     # no wheels: one online install per dependency, as before
print(json.dumps(calls))
calls.clear()
_ensure_skill_deps(os.path.join(root, "have"))
print("have", json.dumps(calls))
PY;
        file_put_contents("$dir/probe.py", $py);
        exec('python3 ' . escapeshellarg("$dir/probe.py") . ' ' . escapeshellarg($dir) . ' 2>&1', $out, $rc);
        exec('rm -rf ' . escapeshellarg($dir));
        $this->assertSame(0, $rc, implode("\n", $out));
        $calls = array_values(array_filter($out, fn(string $l) => str_starts_with($l, '[[')));
        $this->assertSame(['[["install", "-q", "--no-index", "--find-links", "<root>/wheels/.wheels/native", "zz-a", "zz-b>=1.0"]]',
            '[["install", "-q", "zz-a"], ["install", "-q", "zz-b>=1.0"]]'], $calls, implode("\n", $out));
        $this->assertContains('have []', $out, implode("\n", $out));
    }

    public function testDocumentConverterBlockUnchanged(): void
    {
        $block = PythonEmitHelpers::documentConverterBlock();
        $this->assertSame(5500, strlen($block), 'documentConverterBlock byte length changed');
        $this->assertSame(
            'a1bdc4bfe79b93a46c2ae6ca526fd4bac3ca1281576caa4f3643f344e60fc7bf',
            hash('sha256', $block),
            'documentConverterBlock content changed — this alters generated Python for both generators'
        );
    }

    public function testSkillFsSyncBlockUnchanged(): void
    {
        $block = PythonEmitHelpers::skillFsSyncBlock();
        $this->assertSame(6167, strlen($block), 'skillFsSyncBlock byte length changed');
        $this->assertSame(
            '3694c25fccfff1a432c965b48b8ad66889e2c84d0a85f3fd90d2796d9ef78769',
            hash('sha256', $block),
            'skillFsSyncBlock content changed — this alters generated Python for both generators'
        );
    }
}
