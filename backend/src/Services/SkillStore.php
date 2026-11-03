<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use AgentTeam\Services\LangGraphPackage;

/**
 * The skills volume of the Docker app: <root>/public/<path>/ and <root>/users/<uid>/<path>/, with
 * <root>/index.json recording owner and visibility of every skill. A skill path is "leaf" or "group/leaf";
 * the leaf name is unique across public skills and the caller's own area. The individual edition has no
 * public area. No database: the volume is the only state.
 */
final class SkillStore
{
    /** @param ?\Closure(string): list<array{id:int,name:string}> $robotWorkflowsUsing the robot's workflows binding a leaf name */
    public function __construct(private readonly string $root, private readonly string $edition, private readonly ?\Closure $robotWorkflowsUsing = null)
    {
    }

    public static function fromEnv(array $config, ?\Closure $robotWorkflowsUsing = null): ?self
    {
        $dir = trim((string) ($_ENV['SKILLS_DIR'] ?? ''));
        return $dir === '' ? null : new self(rtrim($dir, '/'), Edition::current($config), $robotWorkflowsUsing);
    }

    /** @return array{path:string,owner_id:int}|null the first skill named $leaf in some user's private area */
    public function findPrivate(string $leaf): ?array
    {
        foreach ($this->index() as $key => $e) {
            [$area, $path] = $this->splitKey($key);
            if ($area !== 'public' && $this->leaf($path) === $leaf && is_dir($this->dir($area, $path))) {
                return ['path' => $path, 'owner_id' => (int) $e['owner']];
            }
        }
        return null;
    }

    /** @return list<array{path:string,name:string,description:string,visibility:string,owner_id:int,mine:bool,dependencies:list<string>}> */
    public function list(int $userId, bool $asRobot = false): array
    {
        $rows = [];
        foreach ($this->index() as $key => $e) {
            [$area, $path] = $this->splitKey($key);
            if (!$this->visible($e, $userId, $asRobot) || !is_dir($this->dir($area, $path))) {
                continue;
            }
            $md = (string) @file_get_contents($this->dir($area, $path) . '/SKILL.md');
            $fm = $this->frontmatter($md);
            $rows[] = [
                'path' => $path,
                'name' => $fm['name'] ?? $this->leaf($path),
                'description' => $fm['description'] ?? '',
                'visibility' => $e['visibility'],
                'owner_id' => (int) $e['owner'],
                'mine' => (int) $e['owner'] === $userId,
                'dependencies' => LangGraphPackage::skillDependencies($md),
            ];
        }
        usort($rows, fn($a, $b) => strcmp($a['path'], $b['path']));
        return $rows;
    }

    /** @return array<string,string> rel => bytes; .wheels/native/ is never included */
    public function files(int $userId, string $path, bool $asRobot = false, bool $withWheels = true): array
    {
        $this->checkPath($path);
        [$area] = $this->resolve($userId, $path, $asRobot) ?? throw new SkillNotFound('No such skill.');
        return $this->readTree($this->dir($area, $path), $withWheels);
    }

    public function readFile(int $userId, string $path, string $rel, bool $asRobot = false): string
    {
        $this->checkPath($path);
        $this->checkRel($rel);
        [$area] = $this->resolve($userId, $path, $asRobot) ?? throw new SkillNotFound('No such skill.');
        $file = $this->dir($area, $path) . '/' . $rel;
        if (!is_file($file)) {
            throw new SkillNotFound('No such file.');
        }
        return (string) file_get_contents($file);
    }

    public function writeFile(int $userId, string $path, string $rel, string $bytes): void
    {
        $this->checkPath($path);
        $this->checkRel($rel);
        $this->locked(function () use ($userId, $path, $rel, $bytes) {
            [$area] = $this->owned($userId, $path);
            $file = $this->dir($area, $path) . '/' . $rel;
            $this->mkdir(dirname($file));
            $this->put($file, $bytes);
        });
    }

    /**
     * @param array<string,string> $files rel => bytes
     * @param bool $dryRun only say what the import would do: 'new' | 'identical', or the clash; nothing is written
     * @return array{status:string}
     */
    public function import(int $userId, string $path, array $files, string $visibility = 'private', bool $dryRun = false): array
    {
        $this->checkPath($path);
        $this->checkVisibility($visibility);
        foreach (array_keys($files) as $rel) {
            $this->checkRel((string) $rel);
        }
        return $this->locked(function () use ($userId, $path, $files, $visibility, $dryRun) {
            $index = $this->index();
            foreach ([$this->areaFor($userId, 'private'), 'public'] as $area) {
                $e = $index["$area/$path"] ?? null;
                if ($e !== null && (int) $e['owner'] === $userId) {
                    $same = $this->fingerprint($this->readTree($this->dir($area, $path), false))
                        === $this->fingerprint($this->withoutWheels($files));
                    if ($same) {
                        return ['status' => 'identical'];
                    }
                    throw new SkillClashException("A different skill is already installed at '$path'.");
                }
            }
            $incoming = $this->fingerprint($this->withoutWheels($files));
            foreach ($index as $key => $e) {
                [$a, $p] = $this->splitKey($key);
                if (($a === 'public' || $a === "users/$userId") && $this->leaf($p) === $this->leaf($path)
                    && $this->fingerprint($this->readTree($this->dir($a, $p), false)) === $incoming) {
                    return ['status' => 'identical'];
                }
            }
            $this->assertLeafFree($index, $userId, $path, true);
            $area = $this->areaFor($userId, $visibility);
            if ($dryRun) {
                return ['status' => 'new'];
            }
            $dir = $this->dir($area, $path);
            $this->rmtree($dir); // a folder with no index entry has no owner: never merge into it
            $this->mkdir($dir);
            foreach ($files as $rel => $bytes) {
                $file = $dir . '/' . $rel;
                $this->mkdir(dirname($file));
                $this->put($file, $bytes);
            }
            $index["$area/$path"] = ['owner' => $userId, 'visibility' => $visibility];
            $this->saveIndex($index);
            return ['status' => 'installed'];
        });
    }

    public function setVisibility(int $userId, string $path, string $visibility): void
    {
        $this->checkPath($path);
        $this->checkVisibility($visibility);
        $this->locked(function () use ($userId, $path, $visibility) {
            [$area, $entry] = $this->owned($userId, $path);
            $to = $this->areaFor($userId, $visibility);
            if ($to === $area) {
                return;
            }
            $index = $this->index();
            if ($visibility === 'public') {
                $this->assertLeafFree($index, $userId, $path, false);
            } elseif ($area === 'public') {
                $this->assertNotBoundByRobot($path);
            }
            $this->relocate($area, $path, $to, $path);
            unset($index["$area/$path"]);
            $index["$to/$path"] = ['owner' => $userId, 'visibility' => $visibility];
            $this->saveIndex($index);
        });
    }

    public function delete(int $userId, string $path): void
    {
        $this->checkPath($path);
        $this->locked(function () use ($userId, $path) {
            [$area] = $this->owned($userId, $path);
            if ($area === 'public') {
                $this->assertNotBoundByRobot($path);
            }
            $this->rmtree($this->dir($area, $path));
            $this->pruneGroup($area, $path);
            $index = $this->index();
            unset($index["$area/$path"]);
            $this->saveIndex($index);
        });
    }

    public function move(int $userId, string $from, string $to): void
    {
        $this->checkPath($from);
        $this->checkPath($to);
        $this->locked(function () use ($userId, $from, $to) {
            [$area, $entry] = $this->owned($userId, $from);
            if ($from === $to) {
                return;
            }
            if ($area === 'public' && $this->leaf($from) !== $this->leaf($to)) {
                $this->assertNotBoundByRobot($from);
            }
            $index = $this->index();
            if (isset($index["$area/$to"])) {
                throw new SkillClashException("A skill already exists at '$to'.");
            }
            unset($index["$area/$from"]);
            $this->assertLeafFree($index, $userId, $to, true);
            $this->relocate($area, $from, $area, $to);
            $index["$area/$to"] = $entry;
            $this->saveIndex($index);
        });
    }

    public function absolutePath(int $ownerId, string $path, bool $asRobot = false): ?string
    {
        $this->checkPath($path);
        $r = $this->resolve($ownerId, $path, $asRobot);
        return $r === null ? null : $this->dir($r[0], $path);
    }

    // ---- internals -------------------------------------------------------------------------------

    private function areaFor(int $userId, string $visibility): string
    {
        if ($visibility === 'public') {
            if ($this->edition === 'individual') {
                throw new SkillForbidden('Skills cannot be made public in this edition.');
            }
            return 'public';
        }
        return "users/$userId";
    }

    private function checkVisibility(string $v): void
    {
        if ($v !== 'public' && $v !== 'private') {
            throw new SkillPathInvalid('Visibility must be public or private.');
        }
    }

    private function visible(array $e, int $userId, bool $asRobot): bool
    {
        if ($asRobot) {
            return $e['visibility'] === 'public' || $this->edition === 'individual';
        }
        return (int) $e['owner'] === $userId || $e['visibility'] === 'public';
    }

    /** @return array{0:string,1:array}|null [area, entry] of the skill $userId sees at $path: own, then public, then (robot) any */
    private function resolve(int $userId, string $path, bool $asRobot): ?array
    {
        $index = $this->index();
        $candidates = ["users/$userId/$path", "public/$path"];
        if ($asRobot && $this->edition !== 'individual') {
            $candidates = ["public/$path"]; // a corporate robot sees public skills only
        }
        if ($asRobot && $this->edition === 'individual') {
            foreach (array_keys($index) as $key) {
                if (str_starts_with($key, 'users/') && $this->splitKey($key)[1] === $path) {
                    $candidates[] = $key;
                }
            }
        }
        foreach ($candidates as $key) {
            if (isset($index[$key]) && is_dir($this->dir(...$this->splitKey($key)))) {
                return [$this->splitKey($key)[0], $index[$key]];
            }
        }
        return null;
    }

    /** The caller's own skill at $path, else NotFound (invisible) or Forbidden (visible, not theirs). */
    private function owned(int $userId, string $path): array
    {
        $r = $this->resolve($userId, $path, false) ?? throw new SkillNotFound('No such skill.');
        if ((int) $r[1]['owner'] !== $userId) {
            throw new SkillForbidden('Only the owner can change this skill.');
        }
        return $r;
    }

    /** A public skill a robot workflow binds keeps its public name: the robot could no longer find it otherwise. */
    private function assertNotBoundByRobot(string $path): void
    {
        if ($this->edition === 'corporate' && $this->robotWorkflowsUsing !== null
            && ($workflows = ($this->robotWorkflowsUsing)($this->leaf($path))) !== []) {
            throw new SkillInUse($workflows);
        }
    }

    /** Leaf unique across public + the caller's area (or public only when $withOwn is false), ignoring the skill's own path. */
    private function assertLeafFree(array $index, int $userId, string $path, bool $withOwn): void
    {
        $leaf = $this->leaf($path);
        foreach ($index as $key => $e) {
            [$area, $p] = $this->splitKey($key);
            $relevant = $area === 'public' || ($withOwn && $area === "users/$userId");
            if (!$relevant || $this->leaf($p) !== $leaf || ($p === $path && (int) $e['owner'] === $userId)) {
                continue;
            }
            throw new SkillClashException(
                $area === 'public'
                    ? "A public skill named '$leaf' already exists."
                    : "You already have a skill named '$leaf'."
            );
        }
    }

    private function checkPath(string $path): void
    {
        if ($path === '' || str_contains($path, '\\') || str_starts_with($path, '/') || str_contains($path, '//')) {
            throw new SkillPathInvalid('Invalid skill path.');
        }
        $segs = explode('/', $path);
        if (count($segs) > 2) {
            throw new SkillPathInvalid('A skill path has at most one group level.');
        }
        foreach ($segs as $s) {
            if ($s === '' || $s[0] === '.' || preg_match('/[\x00-\x1f]/', $s)) {
                throw new SkillPathInvalid('Invalid skill path.');
            }
        }
    }

    /** A file path inside a skill: dot-prefixed segments are allowed (.wheels), traversal is not. */
    private function checkRel(string $rel): void
    {
        if ($rel === '' || str_contains($rel, '\\') || str_starts_with($rel, '/') || str_contains($rel, '//')
            || preg_match('/[\x00-\x1f]/', $rel)) {
            throw new SkillPathInvalid('Invalid file path.');
        }
        foreach (explode('/', $rel) as $s) {
            if ($s === '' || $s === '.' || $s === '..') {
                throw new SkillPathInvalid('Invalid file path.');
            }
        }
    }

    private function leaf(string $path): string
    {
        return basename($path);
    }

    private function dir(string $area, string $path): string
    {
        return "{$this->root}/$area/$path";
    }

    /** @return array{0:string,1:string} */
    private function splitKey(string $key): array
    {
        if (str_starts_with($key, 'public/')) {
            return ['public', substr($key, 7)];
        }
        $parts = explode('/', $key, 3);
        return ["$parts[0]/$parts[1]", $parts[2]];
    }

    private function mkdir(string $dir): void
    {
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create $dir");
        }
    }

    private function relocate(string $fromArea, string $from, string $toArea, string $to): void
    {
        $dest = $this->dir($toArea, $to);
        $this->mkdir(dirname($dest));
        if (!@rename($this->dir($fromArea, $from), $dest)) {
            throw new \RuntimeException('Cannot move the skill folder.');
        }
        $this->pruneGroup($fromArea, $from);
    }

    private function pruneGroup(string $area, string $path): void
    {
        if (str_contains($path, '/')) {
            @rmdir($this->root . '/' . $area . '/' . dirname($path));
        }
    }

    private function rmtree(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        ) as $f) {
            $f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        }
        @rmdir($dir);
    }

    /** @return array<string,string> */
    private function readTree(string $dir, bool $withWheels): array
    {
        $out = [];
        if (!is_dir($dir)) {
            return $out;
        }
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            if (!$f->isFile()) {
                continue;
            }
            $rel = substr($f->getPathname(), strlen($dir) + 1);
            if (str_starts_with($rel, '.wheels/native/') || (!$withWheels && str_starts_with($rel, '.wheels/'))
                || $this->isPyCache($rel)) {
                continue;
            }
            $out[$rel] = (string) file_get_contents($f->getPathname());
        }
        return $out;
    }

    /** @param array<string,string> $files */
    private function withoutWheels(array $files): array
    {
        return array_filter($files, fn($k) => !str_starts_with((string) $k, '.wheels/'), ARRAY_FILTER_USE_KEY);
    }

    /** Python's bytecode cache (`__pycache__/`, `*.pyc`): never part of a skill's content. */
    private function isPyCache(string $rel): bool
    {
        return in_array('__pycache__', explode('/', $rel), true) || str_ends_with($rel, '.pyc');
    }

    /** @param array<string,string> $files */
    private function fingerprint(array $files): array
    {
        $out = [];
        foreach ($files as $rel => $bytes) {
            if ($this->isPyCache((string) $rel)) {
                continue;
            }
            $out[(string) $rel] = hash('sha256', $bytes);
        }
        ksort($out);
        return $out;
    }

    /** @return array<string,string> */
    private function frontmatter(string $md): array
    {
        $lines = preg_split('/\r\n|\r|\n/', $md) ?: [];
        $out = [];
        if (trim($lines[0] ?? '') !== '---') {
            return $out;
        }
        foreach (array_slice($lines, 1) as $line) {
            if (trim($line) === '---') {
                break;
            }
            if (preg_match('/^(name|description):\s*(.*)$/', $line, $m)) {
                $out[$m[1]] = trim(trim($m[2]), '"\'');
            }
        }
        return $out;
    }

    private function index(): array
    {
        $raw = @file_get_contents($this->root . '/index.json');
        $data = $raw === false ? null : json_decode($raw, true);
        return is_array($data) ? $data : [];
    }

    private function saveIndex(array $index): void
    {
        $tmp = $this->root . '/index.json.' . bin2hex(random_bytes(4)) . '.tmp';
        $this->put($tmp, (string) json_encode($index, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        if (!@rename($tmp, $this->root . '/index.json')) {
            @unlink($tmp);
            throw new \RuntimeException('Cannot update the skills index.');
        }
    }

    private function put(string $file, string $bytes): void
    {
        if (@file_put_contents($file, $bytes) === false) {
            throw new \RuntimeException("Cannot write $file");
        }
    }

    private function locked(callable $fn): mixed
    {
        $this->mkdir($this->root);
        $h = @fopen($this->root . '/.lock', 'c');
        if ($h === false || !flock($h, LOCK_EX)) {
            throw new \RuntimeException('Cannot lock the skills folder.');
        }
        try {
            return $fn();
        } finally {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }
}
