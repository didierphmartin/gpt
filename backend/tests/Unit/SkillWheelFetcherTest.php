<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\SkillWheelError;
use Quantis\AIPortfolioAssistant\Services\SkillWheelFetcher;

final class SkillWheelFetcherTest extends TestCase
{
    /** @var list<list<string>> */
    private array $calls = [];

    private static function opt(array $argv, string $flag): ?string
    {
        $i = array_search($flag, $argv, true);
        return $i === false ? null : ($argv[$i + 1] ?? null);
    }

    /** $handler(argv, destDir): ?array{code,out} — null = default success writing nothing. */
    private function fetcher(\Closure $handler): SkillWheelFetcher
    {
        return new SkillWheelFetcher(function (array $argv) use ($handler): array {
            $this->calls[] = $argv;
            if (in_array('--version', $argv, true)) {
                return ['code' => 0, 'out' => 'pip 24'];
            }
            $dest = self::opt($argv, '--dest') ?? self::opt($argv, '--wheel-dir');
            return $handler($argv, $dest);
        }, 'python3');
    }

    private function pipCalls(string $verb): array
    {
        return array_values(array_filter($this->calls, fn($a) => ($a[3] ?? '') === $verb));
    }

    public function test_runs_one_pip_download_per_platform(): void
    {
        $f = $this->fetcher(function (array $argv, string $dest): array {
            $plat = self::opt($argv, '--platform');
            file_put_contents("$dest/foo-1.0-cp312-cp312-$plat.whl", 'w' . $plat);
            return ['code' => 0, 'out' => ''];
        });
        $wheels = $f->fetch(['foo', 'bar>=2']);

        $dl = $this->pipCalls('download');
        $this->assertCount(3, $dl);
        foreach ($dl as $argv) {
            $this->assertContains('--only-binary=:all:', $argv);
            $this->assertSame('3.12', self::opt($argv, '--python-version'));
            $this->assertSame('cp', self::opt($argv, '--implementation'));
            foreach (['cp312', 'abi3', 'none'] as $abi) {
                $this->assertContains($abi, $argv);
            }
            $this->assertContains('foo', $argv);
            $this->assertContains('bar>=2', $argv);
            $this->assertNotContains('foo bar>=2', $argv);
        }
        $this->assertContains('manylinux_2_17_x86_64', $dl[0]);
        $this->assertContains('manylinux2014_x86_64', $dl[0]);
        $this->assertContains('manylinux2014_aarch64', $dl[1]);
        $this->assertContains('macosx_11_0_arm64', $dl[2]);
        $this->assertCount(3, $wheels);
        $this->assertDirectoryDoesNotExist(self::opt($dl[0], '--dest'));
    }

    public function test_identical_filenames_are_deduped(): void
    {
        $f = $this->fetcher(function (array $argv, string $dest): array {
            file_put_contents("$dest/foo-1.0-py3-none-any.whl", 'same');
            return ['code' => 0, 'out' => ''];
        });
        $this->assertSame(['foo-1.0-py3-none-any.whl' => 'same'], $f->fetch(['foo']));
    }

    public function test_pure_python_sdist_fallback_builds_wheel(): void
    {
        $f = $this->fetcher(function (array $argv, string $dest): array {
            if ($argv[3] === 'wheel') {
                file_put_contents("$dest/foo-1.0-py3-none-any.whl", 'built');
                return ['code' => 0, 'out' => ''];
            }
            if (in_array('--find-links', $argv, true)) {
                file_put_contents("$dest/foo-1.0-py3-none-any.whl", 'built');
                file_put_contents("$dest/dep-2.0-py3-none-any.whl", 'dep');
                return ['code' => 0, 'out' => ''];
            }
            return in_array('foo', $argv, true) ? ['code' => 1, 'out' => 'ERROR: No matching distribution found for foo'] : ['code' => 0, 'out' => ''];
        });
        $wheels = $f->fetch(['foo']);
        $this->assertEquals(['dep-2.0-py3-none-any.whl' => 'dep', 'foo-1.0-py3-none-any.whl' => 'built'], $wheels);
        $this->assertCount(1, $this->pipCalls('wheel'), 'sdist built once across the three platform groups');
        foreach ($this->calls as $argv) {
            $this->assertContains('--no-cache-dir', $argv);
        }
        $wheel = $this->pipCalls('wheel')[0];
        $this->assertContains('--no-deps', $wheel);
        $this->assertContains('foo', $wheel);
    }

    public function test_non_pure_fallback_reports_library_and_platform(): void
    {
        $f = $this->fetcher(function (array $argv, string $dest): array {
            if ($argv[3] === 'wheel') {
                file_put_contents("$dest/foo-1.0-cp312-cp312-linux_x86_64.whl", 'native');
                return ['code' => 0, 'out' => ''];
            }
            return ['code' => 1, 'out' => 'ERROR: No matching distribution found for foo'];
        });
        try {
            $f->fetch(['foo']);
            $this->fail('expected SkillWheelError');
        } catch (SkillWheelError $e) {
            $this->assertSame(422, $e->statusCode());
            $this->assertSame(['library' => 'foo', 'platform' => 'manylinux_2_17_x86_64'], $e->data());
        }
    }

    public function test_other_pip_failure_is_502_with_output_tail(): void
    {
        $f = $this->fetcher(fn() => ['code' => 1, 'out' => 'WARNING: connection refused to pypi.org']);
        try {
            $f->fetch(['foo']);
            $this->fail('expected SkillWheelError');
        } catch (SkillWheelError $e) {
            $this->assertSame(502, $e->statusCode());
            $this->assertStringContainsString('Could not download the libraries: ', $e->getMessage());
            $this->assertStringContainsString('connection refused', $e->getMessage());
        }
        $this->assertSame([], $this->pipCalls('wheel'));
    }

    public function test_empty_deps_runs_nothing(): void
    {
        $f = $this->fetcher(fn() => $this->fail('no command expected'));
        $this->assertSame([], $f->fetch([]));
        $this->assertSame([], $this->calls);
    }

    public function test_option_looking_dependency_is_rejected(): void
    {
        $f = $this->fetcher(fn() => ['code' => 0, 'out' => '']);
        try {
            $f->fetch(['--index-url=http://evil']);
            $this->fail('expected SkillWheelError');
        } catch (SkillWheelError $e) {
            $this->assertSame(400, $e->statusCode());
        }
        $this->assertSame([], $this->pipCalls('download'));
    }

    public function test_missing_python_is_503(): void
    {
        $f = new SkillWheelFetcher(fn() => ['code' => 127, 'out' => 'not found'], 'python3');
        try {
            $f->fetch(['foo']);
            $this->fail('expected SkillWheelError');
        } catch (SkillWheelError $e) {
            $this->assertSame(503, $e->statusCode());
            $this->assertSame('Exporting a skill with libraries needs Python 3 on the server.', $e->getMessage());
        }
    }
}
