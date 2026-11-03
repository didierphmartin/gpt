<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Services;

/** A wheel-gathering failure with the HTTP status and extra fields the route should answer with. */
final class SkillWheelError extends \RuntimeException
{
    public function __construct(string $message, private readonly int $status, private readonly array $data = [])
    {
        parent::__construct($message);
    }

    public function statusCode(): int
    {
        return $this->status;
    }

    public function data(): array
    {
        return $this->data;
    }
}

/**
 * Gathers native (CPython 3.12) wheels for a skill's declared libraries with `pip download`, one run per platform
 * group, so the exported package can install offline. Libraries with no binary wheel are built from source only when
 * the result is pure Python.
 */
final class SkillWheelFetcher
{
    public const PLATFORMS = [
        ['manylinux_2_17_x86_64', 'manylinux2014_x86_64'],
        ['manylinux_2_17_aarch64', 'manylinux2014_aarch64'],
        ['macosx_11_0_arm64'],
    ];

    /** @var \Closure(list<string>): array{code:int,out:string} */
    private \Closure $runner;

    private string $tmp = '';

    /** @var array<string,?string> dep => folder with its built pure wheel (null = not pure) */
    private array $built = [];

    /** @param ?\Closure(list<string>): array{code:int,out:string} $runner */
    public function __construct(?\Closure $runner = null, private readonly string $python = 'python3')
    {
        $this->runner = $runner ?? self::procOpenRunner(...);
    }

    /**
     * @param list<string> $deps pip requirement strings
     * @return array<string,string> wheel filename => bytes
     */
    public function fetch(array $deps): array
    {
        $deps = array_values(array_filter(array_map(fn($d) => trim((string) $d), $deps), fn($d) => $d !== ''));
        foreach ($deps as $d) {
            if (str_starts_with($d, '-')) {
                throw new SkillWheelError('Invalid library name: ' . $d, 400);
            }
        }
        if ($deps === []) {
            return [];
        }
        if (($this->run([$this->python, '-m', 'pip', '--version', '--no-cache-dir']))['code'] !== 0) {
            throw new SkillWheelError('Exporting a skill with libraries needs Python 3 on the server.', 503);
        }

        $tmp = sys_get_temp_dir() . '/skillwheels_' . bin2hex(random_bytes(8));
        mkdir($tmp, 0700);
        $this->tmp = $tmp;
        $this->built = [];
        try {
            $wheels = [];
            foreach (self::PLATFORMS as $i => $group) {
                $dest = "$tmp/p$i";
                mkdir($dest);
                $this->gather($deps, $group, $dest);
                foreach (glob("$dest/*.whl") ?: [] as $file) {
                    $wheels[basename($file)] ??= (string) file_get_contents($file);
                }
            }
            return $wheels;
        } finally {
            self::removeDir($tmp);
        }
    }

    private function gather(array $deps, array $group, string $dest): void
    {
        $r = $this->download($deps, $group, $dest);
        if ($r['code'] === 0) {
            return;
        }
        self::assertNoWheel($r);
        // Find which dependency has no binary wheel on this platform, and try it as pure Python.
        foreach ($deps as $dep) {
            $r = $this->download([$dep], $group, $dest);
            if ($r['code'] === 0) {
                continue;
            }
            self::assertNoWheel($r);
            $built = $this->buildPure($dep);
            if ($built === null) {
                throw new SkillWheelError("No compatible wheel for $dep on {$group[0]}.", 422, ['library' => $dep, 'platform' => $group[0]]);
            }
            // pip resolves the built wheel plus its own requirements from the index.
            $r = $this->download([$dep], $group, $dest, $built);
            if ($r['code'] !== 0) {
                self::assertNoWheel($r);
                throw new SkillWheelError("No compatible wheel for a requirement of $dep on {$group[0]}.", 422, ['library' => $dep, 'platform' => $group[0]]);
            }
        }
    }

    /** Builds $dep from source once per fetch; returns the folder holding its pure-Python wheel, or null. */
    private function buildPure(string $dep): ?string
    {
        if (array_key_exists($dep, $this->built)) {
            return $this->built[$dep];
        }
        $dir = $this->tmp . '/built' . count($this->built);
        mkdir($dir);
        $r = $this->run([$this->python, '-m', 'pip', 'wheel', '--no-cache-dir', '--no-deps', '--wheel-dir', $dir, $dep]);
        $files = $r['code'] === 0 ? (glob("$dir/*.whl") ?: []) : [];
        $pure = $files !== [];
        foreach ($files as $file) {
            $pure = $pure && preg_match('/-(py3|py2\.py3)-none-any\.whl$/', $file) === 1;
        }
        return $this->built[$dep] = $pure ? $dir : null;
    }

    /** Only "no wheel" answers may fall back or become a 422; anything else (network, index, bad requirement) is a 502. */
    private static function assertNoWheel(array $r): void
    {
        if (!preg_match('/No matching distribution|Could not find a version/i', $r['out'])) {
            throw new SkillWheelError('Could not download the libraries: ' . substr(trim($r['out']), -300), 502);
        }
    }

    private function download(array $deps, array $group, string $dest, ?string $findLinks = null): array
    {
        $argv = [$this->python, '-m', 'pip', 'download', '--no-cache-dir', '--only-binary=:all:', '--python-version', '3.12',
            '--implementation', 'cp', '--abi', 'cp312', '--abi', 'abi3', '--abi', 'none'];
        foreach ($group as $platform) {
            array_push($argv, '--platform', $platform);
        }
        if ($findLinks !== null) {
            array_push($argv, '--find-links', $findLinks);
        }
        array_push($argv, '--dest', $dest);
        return $this->run(array_merge($argv, $deps));
    }

    private function run(array $argv): array
    {
        try {
            return ($this->runner)($argv);
        } catch (\Throwable) {
            return ['code' => 127, 'out' => ''];
        }
    }

    /** @return array{code:int,out:string} */
    private static function procOpenRunner(array $argv): array
    {
        $p = @proc_open($argv, [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes);
        if (!is_resource($p)) {
            return ['code' => 127, 'out' => ''];
        }
        stream_set_blocking($pipes[1], false);
        $out = '';
        $deadline = time() + 600;
        $exit = -1;
        while (true) {
            $out .= (string) stream_get_contents($pipes[1]);
            $st = proc_get_status($p);
            if (!$st['running']) {
                $exit = $st['exitcode'];
                break;
            }
            if (time() > $deadline) {
                proc_terminate($p, 9);
                fclose($pipes[1]);
                proc_close($p);
                return ['code' => 124, 'out' => $out . "\ntimed out"];
            }
            usleep(100000);
        }
        $out .= (string) stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        proc_close($p);
        return ['code' => $exit, 'out' => $out];
    }

    private static function removeDir(string $dir): void
    {
        foreach (scandir($dir) ?: [] as $e) {
            if ($e === '.' || $e === '..') {
                continue;
            }
            is_dir("$dir/$e") && !is_link("$dir/$e") ? self::removeDir("$dir/$e") : @unlink("$dir/$e");
        }
        @rmdir($dir);
    }
}
