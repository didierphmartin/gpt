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

    /** @return list<array{path:string,name:string,description:string,visibility:string,owner_id:int,mine:bool,dependencies:list<string>,requires?:list<string>}> */
    public function list(int $userId, bool $asRobot = false, bool $withRequires = false): array
    {
        $rows = [];
        $index = $this->index();
        // Only when asked (reads each skill's scripts/): the names a row's requirements resolve against, built once.
        $mine = $public = null;
        if ($withRequires) {
            $public = array_map('strval', array_keys($this->viewOf($index, -1)));   // no user -1: public skills only
            $mine = $asRobot && $this->edition !== 'individual' ? $public : array_map('strval', array_keys($this->viewOf($index, $userId)));
        }
        foreach ($index as $key => $e) {
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
            if ($withRequires) {
                // Direct required skills (same rule as delete protection). My own: from my view (own, then public); another
                // user's public skill: against public skills only, as it resolves for its owner at run time.
                $names = (int) $e['owner'] === $userId ? $mine : $public;
                $rows[count($rows) - 1]['requires'] = LangGraphPackage::requiredSkills($path, $this->requiresFiles($area, $path, $md), $names)['requires'];
            }
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
     * @param list<string>|null $expectPublic (public) the required skills the user confirmed go public along; 409 when it differs
     * @return array{status:string, made_public?: list<string>}
     * A public import takes along the skills it requires that are still my own private ones (as setVisibility does),
     * all or nothing. $batch: the other skills of the same import (one zip), installed public with it: a requirement
     * naming one of them resolves to it (after my own and the public skills) instead of being missing.
     */
    public function import(int $userId, string $path, array $files, string $visibility = 'private', bool $dryRun = false,
        ?array $expectPublic = null, array $batch = []): array
    {
        $this->checkPath($path);
        $this->checkVisibility($visibility);
        foreach (array_keys($files) as $rel) {
            $this->checkRel((string) $rel);
        }
        return $this->locked(function () use ($userId, $path, $files, $visibility, $dryRun, $expectPublic, $batch) {
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
            $along = [];
            if ($visibility === 'public') {
                $along = $this->privateRequired($index, $userId, $path, $this->requiresOnly($this->withoutWheels($files)), null,
                    array_values(array_filter(array_map('strval', $batch), fn($x) => $x !== $path)));
                foreach ($along as $q) {
                    $this->assertLeafFree($index, $userId, $q, false);
                }
                $this->assertExpected($path, $along, $expectPublic);
            }
            if ($dryRun) {
                return ['status' => 'new'] + ($visibility === 'public' ? ['made_public' => $along] : []);
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
            try {
                $this->publishAll($index, $userId, $along);
            } catch (\Throwable $e) {
                $this->rmtree($dir);   // all or nothing: the skill goes with the skills it needs, or not at all
                $this->pruneGroup($area, $path);
                throw $e;
            }
            $this->saveIndex($index);
            return ['status' => 'installed'] + ($visibility === 'public' ? ['made_public' => $along] : []);
        });
    }

    /**
     * Make one of my skills public or private. Public takes along every skill it requires (closure) that is still my
     * own private skill, all or nothing (a leaf clash in public for any of them changes nothing); a required skill I
     * cannot make public refuses it. Private is refused while a public skill requires it.
     * $dryRun: only say what would be made public.
     *
     * @return array{made_public: list<string>}
     */
    public function setVisibility(int $userId, string $path, string $visibility, bool $dryRun = false, ?array $expectPublic = null): array
    {
        $this->checkPath($path);
        $this->checkVisibility($visibility);
        return $this->locked(function () use ($userId, $path, $visibility, $dryRun, $expectPublic) {
            [$area, $entry] = $this->owned($userId, $path);
            $to = $this->areaFor($userId, $visibility);
            $index = $this->index();
            if ($visibility === 'public') {
                $along = $this->privateRequired($index, $userId, $path, null, $area);
                $moves = $to === $area ? $along : array_merge([$path], $along);
                foreach ($moves as $p) {
                    $this->assertLeafFree($index, $userId, $p, false);
                }
                $this->assertExpected($path, $along, $expectPublic);
                if (!$dryRun && $moves !== []) {
                    $this->publishAll($index, $userId, $moves);
                    $this->saveIndex($index);
                }
                return ['made_public' => $along];
            }
            if ($to === $area || $dryRun) {
                return ['made_public' => []];
            }
            if ($area === 'public') {
                $this->assertNotBoundByRobot($path);
                $publicDeps = $this->dependents($index, $userId, $area, $path, true);
                if ($publicDeps !== []) {
                    $list = implode(', ', $publicDeps);
                    throw new SkillRequiredBy("\"{$this->leaf($path)}\" can't be made private: the public skill(s) $list need it to run.",
                        'private', $path, $publicDeps);
                }
            }
            $this->relocate($area, $path, $to, $path);
            unset($index["$area/$path"]);
            $index["$to/$path"] = ['owner' => $userId, 'visibility' => $visibility];
            $this->saveIndex($index);
            return ['made_public' => []];
        });
    }

    /**
     * $dryRun: only check (a group delete checks every skill first). $with: skills deleted together with this one
     * (the rest of the group): they do not count as skills that need it.
     */
    public function delete(int $userId, string $path, bool $dryRun = false, array $with = []): void
    {
        $this->checkPath($path);
        $this->locked(function () use ($userId, $path, $dryRun, $with) {
            [$area] = $this->owned($userId, $path);
            if ($area === 'public') {
                $this->assertNotBoundByRobot($path);
            }
            // The rest of the group, as the skills of mine at those paths (area + path, never someone else's same path).
            $except = [];
            foreach ($with as $w) {
                $r = $this->resolve($userId, (string) $w, false);
                if ($r !== null && (int) $r[1]['owner'] === $userId) {
                    $except[] = $r[0] . '/' . $w;
                }
            }
            $this->assertNotRequired($userId, $area, $path, 'delete', $except);
            if ($dryRun) {
                return;
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
            if ($this->leaf($from) !== $this->leaf($to)) {   // regrouping keeps the leaf: the skills that need it still find it
                $this->assertNotRequired($userId, $area, $from, 'rename');
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

    /**
     * What a compile reads skills through (LangGraphPackage::skillFiles): (string $dir, ?string $from): ?string, the folder
     * of the skill the owner sees at $dir, else (a required skill named by its leaf) one with that leaf: in the group of
     * $from (the skill that needs it), then the owner's own, then public; null otherwise.
     */
    public function compileResolver(int $ownerId, bool $asRobot): \Closure
    {
        return function (string $dir, ?string $from = null) use ($ownerId, $asRobot): ?string {
            try {
                $path = $this->absolutePath($ownerId, $dir, $asRobot);
                if ($path === null && !str_contains($dir, '/')) {
                    // By leaf: in the group of the skill that needs it, then the owner's own skill, then a public one.
                    $hits = array_values(array_filter($this->list($ownerId, $asRobot), fn($r) => $this->leaf($r['path']) === $dir));
                    $group = $from !== null && str_contains($from, '/') ? explode('/', $from)[0] : null;
                    usort($hits, fn($a, $b) => [$group !== null && str_starts_with($a['path'], "$group/") ? 0 : 1, $a['mine'] ? 0 : 1, $a['path']]
                        <=> [$group !== null && str_starts_with($b['path'], "$group/") ? 0 : 1, $b['mine'] ? 0 : 1, $b['path']]);
                    return $hits === [] ? null : $this->absolutePath($ownerId, $hits[0]['path'], $asRobot);
                }
                return $path;
            } catch (SkillPathInvalid) {
                return null;   // reported as any skill the owner cannot see
            }
        };
    }

    public function absolutePath(int $ownerId, string $path, bool $asRobot = false): ?string
    {
        $this->checkPath($path);
        $r = $this->resolve($ownerId, $path, $asRobot);
        return $r === null ? null : $this->dir($r[0], $path);
    }

    // ---- required skills (LangGraphPackage::requiredSkills) ----------------------------------------------

    /** @return list<array{0:string,1:string}> [area, path] of every skill $userId sees (own + public), existing folders */
    private function visibleEntries(array $index, int $userId): array
    {
        $out = [];
        foreach ($index as $key => $e) {
            [$area, $p] = $this->splitKey($key);
            if ($this->visible($e, $userId, false) && is_dir($this->dir($area, $p))) {
                $out[] = [$area, $p];
            }
        }
        return $out;
    }

    /** path => area a user resolves a skill path to: their own skill first, then a public one (never another's private). */
    private function viewOf(array $index, int $userId, array $incoming = []): array
    {
        $own = $pub = [];
        foreach ($index as $key => $e) {
            [$area, $p] = $this->splitKey($key);
            if (!is_dir($this->dir($area, $p))) {
                continue;
            }
            if ($area === "users/$userId") {
                $own[$p] = $area;
            } elseif ($area === 'public') {
                $pub[$p] = $area;
            }
        }
        // The rest of the same import (to be installed public with it): only where nothing of mine or public is.
        return $own + $pub + array_fill_keys($incoming, 'incoming');
    }

    /** Only what the requires rule reads: SKILL.md and scripts/**. */
    private function requiresOnly(array $files): array
    {
        return array_filter($files, fn($rel) => $rel === 'SKILL.md' || str_starts_with((string) $rel, 'scripts/'), ARRAY_FILTER_USE_KEY);
    }

    /** SKILL.md and scripts/** of a skill, read from disk (nothing else of the tree). */
    private function requiresFiles(string $area, string $path, ?string $md = null): array
    {
        $dir = $this->dir($area, $path);
        $out = $md !== null ? ['SKILL.md' => $md] : (is_file("$dir/SKILL.md") ? ['SKILL.md' => (string) file_get_contents("$dir/SKILL.md")] : []);
        foreach ($this->readTree("$dir/scripts", false) as $rel => $b) {
            $out["scripts/$rel"] = $b;
        }
        return $out;
    }

    /**
     * What skill $p (in $area, owned by $owner) requires, resolved from its owner's viewpoint: [[area, path]], plus the
     * declared names that resolve to nothing.
     */
    private function requirementsOf(array $index, int $owner, string $area, string $p, ?array $files = null, array $incoming = []): array
    {
        $view = $this->viewOf($index, $owner, $incoming);
        $req = LangGraphPackage::requiredSkills($p, $files ?? $this->requiresFiles($area, $p), array_map('strval', array_keys($view)));
        return ['resolved' => array_map(fn(string $q) => [$view[$q], $q], $req['requires']), 'missing' => $req['missing']];
    }

    /**
     * The skills $userId sees (only public ones when $publicOnly; $except: "area/path" keys left out) whose requirement, resolved from
     * their owner's viewpoint, is the skill at $area/$path. Sorted paths.
     */
    private function dependents(array $index, int $userId, string $area, string $path, bool $publicOnly = false, array $except = []): array
    {
        $out = [];
        foreach ($this->visibleEntries($index, $userId) as [$a, $p]) {
            if (($a === $area && $p === $path) || ($publicOnly && $a !== 'public') || in_array("$a/$p", $except, true)) {
                continue;
            }
            $owner = (int) ($index["$a/$p"]['owner'] ?? 0);
            foreach ($this->requirementsOf($index, $owner, $a, $p)['resolved'] as [$qa, $q]) {
                if ($qa === $area && $q === $path) {
                    $out[] = $p;
                    break;
                }
            }
        }
        sort($out, SORT_STRING);
        return $out;
    }

    private function assertNotRequired(int $userId, string $area, string $path, string $reason, array $except = []): void
    {
        $deps = $this->dependents($this->index(), $userId, $area, $path, false, $except);
        if ($deps === []) {
            return;
        }
        $name = $this->leaf($path);
        $list = implode(', ', $deps);
        throw new SkillRequiredBy($reason === 'delete'
            ? "\"$name\" can't be deleted: $list need(s) it to run (listed in its required skills). Delete $list first, or remove \"$name\" from its required skills."
            : "\"$name\" can't be renamed: $list need(s) it to run (listed in its required skills).", $reason, $path, $deps);
    }

    /**
     * The skills $path requires, transitively, that are still $userId's own private skills (what making it public takes
     * along), in discovery order. A required skill that is neither mine nor public refuses it. $files: the skill's
     * files when it is not stored yet (an import).
     */
    private function privateRequired(array $index, int $userId, string $path, ?array $files = null, ?string $startArea = null,
        array $incoming = []): array
    {
        $own = $this->areaFor($userId, 'private');
        $along = [];
        $seen = [$path => true];
        $queue = [[$startArea ?? $own, $path, $files]];
        while ($queue !== []) {
            [$a, $p, $f] = array_shift($queue);
            $req = $this->requirementsOf($index, $userId, $a, $p, $f, $incoming);
            foreach ($req['missing'] as $m) {
                throw new SkillRequiredBy("\"{$this->leaf($p)}\" needs \"$m\", which you can't make public.", 'public', $p, [], $m);
            }
            foreach ($req['resolved'] as [$qa, $q]) {
                if (isset($seen[$q])) {
                    continue;
                }
                $seen[$q] = true;
                if ($qa === $own) {
                    $along[] = $q;
                    $queue[] = [$qa, $q, null];
                }
            }
        }
        return $along;
    }

    /** The user confirmed which skills go public along: refuse when the closure is no longer that. */
    private function assertExpected(string $path, array $along, ?array $expect): void
    {
        if ($expect === null) {
            return;
        }
        $a = $along;
        $b = array_map('strval', $expect);
        sort($a, SORT_STRING);
        sort($b, SORT_STRING);
        if ($a !== $b) {
            throw new SkillRequiredBy("The skills that go public with \"{$this->leaf($path)}\" changed: " . (implode(', ', $along) ?: '-') . '. Try again.',
                'changed', $path, $along);
        }
    }

    /** Move my private skills $paths to public, all or nothing (moves already done are undone on a failure). */
    private function publishAll(array &$index, int $userId, array $paths): void
    {
        $own = $this->areaFor($userId, 'private');
        $done = [];
        try {
            foreach ($paths as $p) {
                $this->relocate($own, $p, 'public', $p);
                $done[] = $p;
            }
        } catch (\Throwable $e) {
            foreach (array_reverse($done) as $p) {
                try {
                    $this->relocate('public', $p, $own, $p);
                } catch (\Throwable) {
                    // best effort: the index below is left unchanged either way
                }
            }
            throw $e;
        }
        foreach ($paths as $p) {
            unset($index["$own/$p"]);
            $index["public/$p"] = ['owner' => $userId, 'visibility' => 'public'];
        }
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
