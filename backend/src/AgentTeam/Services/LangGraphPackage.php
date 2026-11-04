<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use RuntimeException;

/**
 * The files that make a modular LangGraph package run on its own (spec 2026-10-15 §5):
 * requirements.txt, .env.example, README.md, the code-node harness, each used skill's
 * folder and the Start's documents. The code of every code node is a file of its own
 * (codeFile()), read by the package at each run.
 *
 * A file entry is {path, code}; a file that is not valid UTF-8 is {path, code (base64),
 * encoding: "base64"} so it travels in the JSON manifest and is written back as bytes.
 */
final class LangGraphPackage
{
    /** What every LangGraph program imports (the single file; a package's workflow, common and agents). */
    private const BASE_REQUIREMENTS = ['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx',
        'pydantic', 'python-dotenv'];

    /** A package's run server (api.py; an A2A agent server serves with uvicorn too). */
    private const SERVER_REQUIREMENTS = ['fastapi', 'uvicorn'];

    /** The A2A package: its agents are A2A servers, its orchestrator their client. */
    private const A2A_REQUIREMENTS = ['a2a-sdk[http-server]'];

    /** Providers whose LLM factory branch (llmFactoryLines()) imports a package beyond the base ones. */
    private const PROVIDER_REQUIREMENTS = ['gemini' => 'langchain-google-genai', 'google' => 'langchain-google-genai'];

    private const SKIP_NAMES = ['__pycache__', '.DS_Store'];

    /** The swarm package's workflow.py builds its graph with create_swarm() (langgraph_swarm). */
    private const SWARM_REQUIREMENTS = ['langgraph-swarm'];

    /** The TO RUN install line of a package's files: the package's requirements.txt holds the list. */
    public const PIP_REQUIREMENTS = 'pip install -r requirements.txt';

    /** TO RUN note: the document converter's packages are imported only for an attachment of that format. */
    public const OPTIONAL_FORMATS_NOTE = ['# optional, only for the attachment formats you use:',
        '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)'];

    private const HARNESS = __DIR__ . '/../../../../frontend/assets/py/code_node_harness.py';

    /** Where the editor keeps the skill folders: the default skills root of the generator. */
    public static function defaultSkillsRoot(): string
    {
        $home = getenv('HOME') ?: (function_exists('posix_getpwuid') ? (posix_getpwuid(posix_geteuid())['dir'] ?? '') : '');
        return $home . '/Documents/synergyAI/skills';
    }

    /**
     * The package's own files (the code modules, agents and code/ files are the generator's).
     *
     * @return list<array{path:string,code:string,encoding?:string}>
     */
    public static function files(array $facts, string|\Closure $skillsRoot, ?StartDocumentStore $documents = null): array
    {
        $skills = self::skillFiles($facts, $skillsRoot);
        $out = self::docFiles($facts, 'modular', $skills, (string) $facts['safeName'] . (isset($facts['swarm']) ? '_modular_swarm' : '_modular'), 'workflow.py');
        if (($facts['codeData'] ?? []) !== []) {
            $harness = file_get_contents(self::HARNESS);
            if ($harness === false) {
                throw new RuntimeException('code node harness not found (frontend/assets/py/code_node_harness.py)');
            }
            $out[] = ['path' => 'code_harness.py', 'code' => $harness];
        }
        foreach ($skills as $f) {
            $out[] = $f['entry'];
        }
        foreach (self::startDocuments($facts['startDocuments'] ?? [], $documents)['files'] as $f) {
            $out[] = $f;
        }
        return $out;
    }

    /**
     * One code node's code as a package file: code/start_<slug>.py for the Start option's trigger,
     * else code/<nid>_<slug>.py; the source verbatim.
     *
     * @return array{path:string,code:string}
     */
    public static function codeFile(string $nid, array $cd, bool $isTrigger): array
    {
        $slug = CodeNodeEmit::slug((string) ($cd['display'] ?? 'code'));
        $slug = trim($slug, '_') !== '' ? trim($slug, '_') : 'code';
        return ['path' => 'code/' . ($isTrigger ? 'start' : $nid) . "_{$slug}.py", 'code' => (string) $cd['source']];
    }

    /**
     * The Start's documents as package files, and the START_DOCUMENTS entries pointing at them
     * (start_documents/<basename>, relative to the package). Only a document in the requesting
     * user's own storage is copied ($documents: StartDocumentStore; none without one); any other
     * entry is left as it is (the run then reads it, or reports its conversion failure, as before).
     *
     * @return array{files: list<array{path:string,code:string,encoding?:string}>, docs: list<array>}
     */
    public static function startDocuments(array $docs, ?StartDocumentStore $documents = null): array
    {
        $files = [];
        $out = [];
        $taken = [];
        foreach ($docs as $i => $doc) {
            $bytes = is_array($doc) && $documents !== null ? $documents->read($doc) : null;
            if ($bytes === null) {
                $out[] = $doc;
                continue;
            }
            $name = basename((string) $doc['path']);
            if (isset($taken[$name])) {
                $name = "{$i}_{$name}";
            }
            $taken[$name] = true;
            $files[] = self::entry("start_documents/{$name}", $bytes);
            // The copy is the document now: no field keeps pointing at where it came from.
            unset($doc['fullPath'], $doc['localUri']);
            $doc['path'] = "start_documents/{$name}";
            $out[] = $doc;
        }
        return ['files' => $files, 'docs' => $out];
    }

    /** {path, code} for text (valid UTF-8), {path, code: base64, encoding: base64} otherwise. */
    private static function entry(string $path, string $bytes): array
    {
        return mb_check_encoding($bytes, 'UTF-8')
            ? ['path' => $path, 'code' => $bytes]
            : ['path' => $path, 'code' => base64_encode($bytes), 'encoding' => 'base64'];
    }

    /** The skill folders the agents bind ({'dir': d}), in first-use order. */
    public static function skillDirs(array $facts): array
    {
        $dirs = [];
        foreach ($facts['agentData'] ?? [] as $ad) {
            foreach ($ad['skills'] ?? [] as $s) {
                if (isset($s['dir']) && (string) $s['dir'] !== '') {
                    $dirs[(string) $s['dir']] = true;
                }
            }
        }
        return array_keys($dirs);
    }

    /**
     * Every file of every used skill folder (skipping __pycache__, .DS_Store, *.pyc, .env*, dot-directories), sorted,
     * plus the skill's native wheels (.wheels/native/: the program installs its libraries from there, offline);
     * never the browser's (.wheels/pyodide/). Each used skill brings the skills it requires (requiredSkills(),
     * transitively): they are copied the same way, after the bound ones, at skills/<leaf>/ (a grouped one too).
     *
     * $skillsRoot: the folder holding the skills, or (the Docker app's skill store) a resolver
     * (string $dir): ?string giving each skill's own folder, null when the owner cannot see it.
     *
     * @return list<array{dir:string,rel:string,bytes:string,entry:array}>
     */
    public static function skillFiles(array $facts, string|\Closure $skillsRoot): array
    {
        $out = [];
        $root = is_string($skillsRoot) ? realpath($skillsRoot) : null;
        // [skill, who needs it, where it goes]: a bound skill at its own path; a required one at skills/<leaf>/, where
        // the scripts that need it look (SKILLS_ROOT/<leaf>/...).
        $queue = array_map(fn(string $d) => [$d, null, $d], self::skillDirs($facts));
        $done = [];
        $installed = null;   // the skill paths a folder root holds (read once, when a skill needs it)
        while ($queue !== []) {
            [$d, $by, $as] = array_shift($queue);
            if (isset($done[$as])) {
                if ($done[$as] !== $d) {   // two different skills would land in one folder
                    throw new RuntimeException("Skills \"{$done[$as]}\" and \"{$d}\" both need to be available as '{$as}'; rename one.");
                }
                continue;
            }
            $done[$as] = $d;
            $base = self::skillBase($d, $skillsRoot, $root, $by);
            if ($base === false) {
                throw new RuntimeException($by === null
                    ? "Skill folder \"{$d}\" is not available on this server, so it can't be packaged."
                    : "Skill \"{$by}\" needs skill \"{$d}\", which is not available on this server, so it can't be packaged.");
            }
            $found = self::folderFiles($base, $base);
            $own = [];
            foreach ($found as $rel) {
                if ($rel === 'SKILL.md' || str_starts_with($rel, 'scripts/')) {
                    $own[$rel] = (string) file_get_contents("{$base}/{$rel}");
                }
            }
            if (is_dir("{$base}/.wheels/native")) {
                array_push($found, ...self::folderFiles($base, "{$base}/.wheels/native"));
            }
            sort($found, SORT_STRING);
            foreach ($found as $rel) {
                $bytes = (string) file_get_contents("{$base}/{$rel}");
                $out[] = ['dir' => $as, 'rel' => $rel, 'bytes' => $bytes, 'entry' => self::entry("skills/{$as}/{$rel}", $bytes)];
            }
            $names = $root !== null
                ? ($installed ??= ($root === false ? [] : self::installedSkills($root)))
                : self::probedSkills($d, $own, $skillsRoot);
            $req = self::requiredSkills($d, $own, $names);
            foreach ($req['missing'] as $m) {
                throw new RuntimeException("Skill \"{$d}\" needs skill \"{$m}\", which is not available on this server, so it can't be packaged.");
            }
            foreach ($req['requires'] as $q) {
                $queue[] = [$q, $d, basename($q)];
            }
        }
        return $out;
    }

    /** The real folder of skill $d (inside the root, or from the store resolver), false when unsafe or absent. */
    private static function skillBase(string $d, string|\Closure $skillsRoot, string|false|null $root, ?string $from = null): string|false
    {
        // dir_name comes from the client-saved node config: plain segments ("GEO/geo-report" for a grouped
        // skill; none empty, "." or "..", none starting with "." (.git, .superpowers), no "\"), resolved
        // inside the root.
        $segments = StartDocumentStore::safeSegments($d);
        $safe = $segments !== null && array_filter($segments, fn(string $seg) => str_starts_with($seg, '.')) === [];
        if (!$safe) {
            return false;
        }
        if ($root === null) {
            $dir = $skillsRoot($d, $from);   // $from: the skill that needs it (a store resolver prefers its group)
            $base = $dir === null ? false : realpath($dir);
        } else {
            $base = $root !== false ? realpath($root . DIRECTORY_SEPARATOR . $d) : false;
            $base = $base !== false && str_starts_with($base, $root . DIRECTORY_SEPARATOR) ? $base : false;
        }
        return $base !== false && is_dir($base) ? $base : false;
    }

    /** The skill paths under a skills root: folders (one or two levels, no dot-folder) holding a SKILL.md. */
    private static function installedSkills(string $root): array
    {
        $out = [];
        foreach (scandir($root) ?: [] as $a) {
            if ($a === '.' || $a === '..' || str_starts_with($a, '.') || !is_dir("{$root}/{$a}")) {
                continue;
            }
            if (is_file("{$root}/{$a}/SKILL.md")) {
                $out[] = $a;
                continue;
            }
            foreach (scandir("{$root}/{$a}") ?: [] as $b) {
                if (!str_starts_with($b, '.') && is_file("{$root}/{$a}/{$b}/SKILL.md")) {
                    $out[] = "{$a}/{$b}";
                }
            }
        }
        sort($out, SORT_STRING);
        return $out;
    }

    /**
     * The store has no listing here, only the resolver: every name the skill could mean (its requires-skills, else each
     * exact quoted literal and each /segment/ of its scripts) that resolves to a skill the owner sees (the resolver
     * also finds a grouped skill by its leaf).
     */
    private static function probedSkills(string $self, array $files, \Closure $resolve): array
    {
        $cands = self::declaredSkills($files['SKILL.md'] ?? '');
        if ($cands === []) {
            foreach (self::quotedLiterals($files) as $lit) {
                $cands[] = $lit;                                  // an exact literal
                $segs = explode('/', $lit);
                for ($i = 1; $i < count($segs) - 1; $i++) {       // a /segment/ with a slash on both sides
                    $cands[] = $segs[$i];
                }
            }
        }
        $out = [];
        foreach (array_unique($cands) as $c) {
            if ($c === $self || !preg_match('#^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)?$#', $c)) {
                continue;
            }
            $dir = $resolve($c, $self);
            if ($dir !== null && is_file($dir . '/SKILL.md')) {
                $out[] = $c;
            }
        }
        sort($out, SORT_STRING);
        return $out;
    }

    /** The quoted string literals ('…' / "…", one line) of a skill's scripts/** text files. */
    private static function quotedLiterals(array $files): array
    {
        $lits = [];
        foreach ($files as $rel => $bytes) {
            $rel = (string) $rel;
            if (!str_starts_with($rel, 'scripts/') || in_array('__pycache__', explode('/', $rel), true)
                || str_ends_with($rel, '.pyc') || !mb_check_encoding((string) $bytes, 'UTF-8')) {
                continue;
            }
            preg_match_all('/\'([^\'\n\\\\]*)\'|"([^"\n\\\\]*)"/', (string) $bytes, $m, PREG_SET_ORDER);
            foreach ($m as $x) {
                $lits[] = ($x[2] ?? '') !== '' ? $x[2] : $x[1];
            }
        }
        return $lits;
    }

    /** `requires-skills:` of a SKILL.md frontmatter (list or single form, parsed as `dependencies:`). */
    public static function declaredSkills(string $skillMd): array
    {
        return self::frontmatterList($skillMd, 'requires-skills:');
    }

    /** The installed skill a name means: the exact path, else by leaf (same group as $from, then top level, then the first). */
    public static function resolveSkillName(string $name, array $installed, string $from): ?string
    {
        if (in_array($name, $installed, true)) {
            return $name;
        }
        $leaf = basename($name);
        $hits = array_values(array_filter($installed, fn(string $p) => basename($p) === $leaf));
        if ($hits === []) {
            return null;
        }
        $group = str_contains($from, '/') ? explode('/', $from)[0] : '';
        foreach ($hits as $p) {
            if ((str_contains($p, '/') ? explode('/', $p)[0] : '') === $group) {
                return $p;
            }
        }
        foreach ($hits as $p) {
            if (!str_contains($p, '/')) {
                return $p;
            }
        }
        sort($hits, SORT_STRING);
        return $hits[0];
    }

    /**
     * The skills skill $path requires (one level; twin of SkillRequires.direct in frontend/assets/js/skill-requires.js):
     * its `requires-skills:` when declared (replaces scanning), else every OTHER installed skill whose leaf folder name
     * is an exact quoted string of its scripts/** text files or a /leaf/ segment (slash on both sides) inside one.
     * Unknown declared names are missing.
     *
     * @param array<string,string> $files rel => bytes of that skill
     * @param list<string> $installed skill paths
     * @return array{requires: list<string>, missing: list<string>}
     */
    public static function requiredSkills(string $path, array $files, array $installed): array
    {
        $list = array_values(array_filter($installed, fn(string $p) => $p !== $path));
        $out = [];
        $missing = [];
        $declared = self::declaredSkills((string) ($files['SKILL.md'] ?? ''));
        if ($declared !== []) {   // a declared list replaces scanning
            foreach ($declared as $name) {
                $hit = self::resolveSkillName($name, $list, $path);
                if ($hit === null) {
                    $missing[] = $name;
                } else {
                    $out[$hit] = true;
                }
            }
        } else {
            $lits = self::quotedLiterals($files);
            $exact = array_flip($lits);
            foreach (array_unique(array_map('basename', $list)) as $leaf) {
                $hit = isset($exact[$leaf]);
                foreach ($hit ? [] : $lits as $l) {
                    if (str_contains($l, "/$leaf/")) {
                        $hit = true;
                        break;
                    }
                }
                if ($hit) {
                    $out[self::resolveSkillName($leaf, $list, $path)] = true;
                }
            }
        }
        $req = array_map('strval', array_keys($out));
        sort($req, SORT_STRING);
        return ['requires' => $req, 'missing' => $missing];
    }

    /** The files under $from (paths relative to the skill folder $base), skipping junk, .env* and dot-directories. */
    private static function folderFiles(string $base, string $from): array
    {
        $found = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveCallbackFilterIterator(
            new \RecursiveDirectoryIterator($from, \FilesystemIterator::SKIP_DOTS),
            fn(\SplFileInfo $f) => !in_array($f->getFilename(), self::SKIP_NAMES, true) && !str_ends_with($f->getFilename(), '.pyc')
                && !str_starts_with($f->getFilename(), '.env')
                && !($f->isDir() && str_starts_with($f->getFilename(), '.'))));   // .git/, .pytest_cache/, .wheels/ ...
        foreach ($it as $f) {
            // A file is copied only if it really lives in the skill folder (a symlink may point elsewhere).
            $real = $f->isFile() ? realpath($f->getPathname()) : false;
            if ($real !== false && str_starts_with($real, $base . DIRECTORY_SEPARATOR)) {
                $found[] = substr($f->getPathname(), strlen($base) + 1);
            }
        }
        return $found;
    }

    /**
     * The SKILL.md dependencies a package's requirements.txt lists: those of each skill without bundled wheels.
     * A skill that carries .wheels/native/*.whl installs its libraries from there, offline, at its first use.
     *
     * @param list<array{dir:string,rel:string,bytes:string}> $skillFiles skillFiles()
     * @return list<string>
     */
    public static function skillRequirementNames(array $skillFiles): array
    {
        $bundled = [];
        foreach ($skillFiles as $f) {
            if (str_starts_with($f['rel'], '.wheels/native/') && str_ends_with($f['rel'], '.whl')) {
                $bundled[$f['dir']] = true;
            }
        }
        $req = [];
        foreach ($skillFiles as $f) {
            if ($f['rel'] === 'SKILL.md' && !isset($bundled[$f['dir']])) {
                array_push($req, ...self::skillDependencies($f['bytes']));
            }
        }
        return $req;
    }

    /** `dependencies:` of a SKILL.md's frontmatter, parsed as SkillRuntime.ensure_deps parses it. */
    public static function skillDependencies(string $skillMd): array
    {
        return self::frontmatterList($skillMd, 'dependencies:');
    }

    /** A frontmatter list field ($key with its colon): `key: a, b` or `key: [a, "b"]`; [] when absent. */
    private static function frontmatterList(string $skillMd, string $key): array
    {
        $lines = preg_split('/\r\n|\r|\n/', $skillMd);
        if (!$lines || trim($lines[0]) !== '---') {
            return [];
        }
        foreach (array_slice($lines, 1) as $line) {
            $s = trim($line);
            if ($s === '---') {
                break;
            }
            if (str_starts_with(strtolower($s), $key)) {
                return self::listItems(explode(':', $s, 2)[1]);
            }
        }
        return [];
    }

    /**
     * Items of a frontmatter list value (`a, b` or `[a, 'b,c']`): split on commas outside single/double quotes,
     * then one matching quote pair is stripped ('' -> ' inside single quotes). An unterminated quote falls back
     * to splitting on every comma. Twin of SkillRequires.listItems (JS) and the emitted Python readers.
     * @return list<string>
     */
    public static function listItems(string $raw): array
    {
        $val = trim(trim($raw), '[]');
        $items = [];
        $cur = '';
        $q = null;
        $n = strlen($val);
        for ($i = 0; $i < $n; $i++) {
            $c = $val[$i];
            if ($q !== null) {
                $cur .= $c;
                if ($c === $q) {
                    if ($q === "'" && ($val[$i + 1] ?? '') === "'") {
                        $cur .= $val[++$i];
                    } else {
                        $q = null;
                    }
                }
            } elseif (($c === '"' || $c === "'") && trim($cur) === '') {
                $q = $c;
                $cur .= $c;
            } elseif ($c === ',') {
                $items[] = $cur;
                $cur = '';
            } else {
                $cur .= $c;
            }
        }
        $items[] = $cur;
        $out = [];
        if ($q !== null) {
            foreach (explode(',', $val) as $d) {
                $d = trim(trim(trim($d), "'"), '"');
                if ($d !== '') {
                    $out[] = $d;
                }
            }
            return $out;
        }
        foreach ($items as $d) {
            $d = trim($d);
            $k = $d[0] ?? '';
            if (strlen($d) >= 2 && ($k === "'" || $k === '"') && $d[strlen($d) - 1] === $k) {
                $d = substr($d, 1, -1);
                if ($k === "'") {
                    $d = str_replace("''", "'", $d);
                }
            }
            if ($d !== '') {
                $out[] = $d;
            }
        }
        return $out;
    }

    private static function providers(array $facts): array
    {
        $p = [];
        foreach (array_merge(array_values($facts['agentData'] ?? []), array_values($facts['playbookData'] ?? [])) as $d) {
            if (($d['provider'] ?? '') !== '') {
                $p[strtolower((string) $d['provider'])] = true;
            }
        }
        return array_keys($p);
    }

    /**
     * The packages a LangGraph program of $layout ('single' | 'modular' | 'a2a') imports: the one list its
     * requirements.txt, its TO RUN install line and its README come from. $skillFiles: the skills the package
     * carries (the SKILL.md dependencies of those without bundled wheels); a program that reads its skills from the editor's folder installs
     * their dependencies at the first run instead.
     *
     * @return list<string>
     */
    public static function requirementNames(array $facts, string $layout, array $skillFiles = []): array
    {
        $req = self::BASE_REQUIREMENTS;
        if ($layout !== 'single') {
            array_push($req, ...self::SERVER_REQUIREMENTS);
        }
        if ($layout === 'a2a') {
            array_push($req, ...self::A2A_REQUIREMENTS);
        }
        if (isset($facts['swarm'])) {
            array_push($req, ...self::SWARM_REQUIREMENTS);
        }
        foreach (self::providers($facts) as $p) {
            if (isset(self::PROVIDER_REQUIREMENTS[$p])) {
                $req[] = self::PROVIDER_REQUIREMENTS[$p];
            }
        }
        array_push($req, ...self::skillRequirementNames($skillFiles));
        array_push($req, ...PythonRequirements::documentNames($facts['startDocuments'] ?? []));
        return $req;
    }

    /** The TO RUN install line of a $layout program that has no requirements.txt beside it (the single file). */
    public static function pipInstall(array $facts, string $layout): string
    {
        return PythonRequirements::pipInstall(self::requirementNames($facts, $layout));
    }

    /**
     * The files a single-file export carries beside <name>_langgraph.py: requirements.txt, .env.example and
     * README.md (the script reads the .env next to it first).
     *
     * @return list<array{path:string,code:string}>
     */
    public static function singleFiles(array $facts, string $filename): array
    {
        return self::docFiles($facts, 'single', [], (string) preg_replace('/\.py$/', '', $filename), $filename);
    }

    /**
     * requirements.txt, .env.example and README.md of the A2A package ($layout: a2aLayout()).
     *
     * @return list<array{path:string,code:string}>
     */
    public static function a2aFiles(array $facts, array $layout): array
    {
        return self::docFiles($facts + ['a2aAgents' => $layout['agents']], 'a2a', [], (string) $layout['root'], 'orchestrator.py');
    }

    private static function docFiles(array $facts, string $layout, array $skillFiles, string $folder, string $entry): array
    {
        return [
            ['path' => 'requirements.txt', 'code' => PythonRequirements::txt(self::requirementNames($facts, $layout, $skillFiles))],
            ['path' => '.env.example', 'code' => PackageDocs::envExample((string) $facts['wfName'], self::envVariables($facts),
                self::optionalEnv($facts, $layout))],
            ['path' => 'README.md', 'code' => self::readme($facts, $layout, $folder, $entry)],
        ];
    }

    /** The environment the program reads that .env must provide (PackageDocs' $vars). */
    public static function envVariables(array $facts): array
    {
        $keys = [];
        foreach (self::providers($facts) as $p) {
            $k = PythonEmitHelpers::providerKeyEnv($p);
            if ($k !== null) {
                $keys[$k][] = $p;
            }
        }
        $decision = [];
        foreach ($facts['agentData'] ?? [] as $ad) {
            foreach (!empty($ad['dispatch']) ? ($ad['decision'] ?? []) : [] as $c) {
                $decision[(string) $c['key_env']] = (string) $c['url_env'];
            }
        }
        // Every LangGraph program reads MODEL_NAME: its model factory is in the script, common.py or each agent server.
        return ['keys' => $keys, 'decision' => $decision, 'mcp' => $facts['serverSlugs'] ?? [],
            'model' => 'One model for every node, instead of each node\'s own'];
    }

    /** The optional variables a $layout program reads, as .env.example lists them: [what it does, KEY=example]. */
    private static function optionalEnv(array $facts, string $layout): array
    {
        $o = [];
        $o[] = match ($layout) {
            'single' => ['Where saved outputs go (default: outputs/ next to the script)', 'SYNERGYAI_OUTPUT_ROOT=./outputs'],
            'a2a' => ['Where saved outputs go (default: ~/Documents/synergyAI/outputs)', 'SYNERGYAI_OUTPUT_ROOT=/path/to/outputs'],
            default => ['Where saved outputs go (default: outputs/ in this folder)', 'SYNERGYAI_OUTPUT_ROOT=./outputs'],
        };
        if ($layout !== 'a2a' && !isset($facts['swarm'])) {   // a swarm and the A2A orchestrator write no run logs
            $o[] = [$layout === 'single' ? 'Where run logs go (default: runs/ next to the script)' : 'Where run logs go (default: runs/ in this folder)',
                'RUNS_DIR=./runs'];
        }
        if (self::skillDirs($facts) !== []) {
            $o[] = $layout === 'modular'
                ? ['Where the skills are read from (default: skills/ in this folder)', 'SYNERGYAI_SKILLS_DIR=./skills']
                : ['Where the skills are read from (default: ' . PackageDocs::EDITOR_SKILLS_DIR . ')', 'SYNERGYAI_SKILLS_DIR=/path/to/skills'];
        }
        if ($layout === 'a2a') {
            $o[] = ['First port of the agent servers, one per agent in order (default: 8701)', 'A2A_BASE_PORT=8701'];
        }
        return $o;
    }

    /** README.md: what the folder is, install, configure, the run modes, files written, run server, service, code nodes. */
    private static function readme(array $facts, string $layout, string $folder, string $entry): string
    {
        $name = (string) $facts['wfName'];
        $swarm = isset($facts['swarm']);
        $skills = self::skillDirs($facts);
        $intro = match (true) {
            $layout === 'single' => ['A LangGraph program compiled from the SynergyAI workflow editor, as one Python file: `' . $entry . '`.',
                'It runs on its own: no database, no SynergyAI server.'],
            $layout === 'a2a' => ['A LangGraph program compiled from the SynergyAI workflow editor, as A2A agents: each agent node is an',
                'A2A server of its own (`agents/`), and `orchestrator.py` runs the workflow over them. It runs on its own:',
                'no database, no SynergyAI server.'],
            $swarm => ['A LangGraph swarm compiled from the SynergyAI workflow editor: its agents (`agents/`, one file each) hand',
                'the conversation to one another. It runs on its own: no database, no SynergyAI server. Everything it needs',
                'is in this folder.'],
            default => ['A LangGraph program compiled from the SynergyAI workflow editor, with each node in a file of its own',
                '(`agents/`). It runs on its own: no database, no SynergyAI server. Everything it needs is in this folder.'],
        };
        if ($layout !== 'modular') {
            array_push($intro, ...PackageDocs::editorSkillsNote($skills));
        }
        $L = PackageDocs::head($name, $intro, $folder, self::envVariables($facts));
        $L[] = '## Run';
        $L[] = '';
        $L[] = 'Run these from the folder, with the environment active.';
        $L[] = '';
        if ($layout === 'a2a') {
            $cron = $facts['defaultCron'] ?? null;
            $L[] = '```sh';
            $L[] = 'python orchestrator.py "your prompt"   # one run on the text (no text: the Start node\'s prompt)';
            $L[] = 'python orchestrator.py --cron [EXPR]   # a run on each tick of a 5-field cron schedule, until stopped';
            $L[] = '```';
            $L[] = '';
            $L[] = $cron !== null ? "Without EXPR, `--cron` uses the Start node's schedule (`{$cron}`)."
                : '`--cron` needs EXPR: the Start node has no schedule.';
            $L[] = 'Text goes before `--cron` (after it, it is read as the cron expression). Ctrl-C (or SIGTERM) stops the loop.';
            $L[] = '';
            array_push($L, ...self::a2aAgentLines($facts['a2aAgents'] ?? []));
        } else {
            array_push($L, ...PackageDocs::modes($entry, $swarm ? 'prompt' : (string) ($facts['startMode'] ?? 'prompt'),
                $facts['defaultCron'] ?? null, $swarm ? null : ($facts['defaultWatch'] ?? null), !$swarm));
        }
        $L[] = '## Files written';
        $L[] = '';
        $here = $layout === 'single' ? 'next to the script' : 'in this folder';
        $L[] = $layout === 'a2a'
            ? '- `~/Documents/synergyAI/outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).'
            : "- `outputs/` {$here} -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).";
        if ($layout !== 'a2a' && !$swarm) {
            $L[] = "- `runs/` {$here} -- one `<date>_<run id>.jsonl` event log per run, and `runs/current` (`RUNS_DIR` overrides).";
            $L[] = '  A run with nothing to do leaves no file.';
        }
        $L[] = '';
        if ($layout === 'a2a') {
            array_push($L, ...PackageDocs::runServer(false, ['The agent servers start with its first run and stop when it exits.']));
        } elseif ($layout === 'modular') {
            array_push($L, ...PackageDocs::runServer(!$swarm));
        }
        if ($layout === 'a2a') {
            $cron = ($facts['defaultCron'] ?? null) !== null;
            array_push($L, ...PackageDocs::service($name, 'LangGraph', $folder, $entry, $cron ? '--cron' : '', $cron ? 'cron' : 'prompt'));
        } else {
            array_push($L, ...PackageDocs::service($name, 'LangGraph', $folder, $entry, '', $swarm ? 'prompt' : (string) ($facts['startMode'] ?? 'prompt')));
        }
        if ($layout === 'modular' && ($facts['codeData'] ?? []) !== []) {
            $L[] = '## Editing code nodes';
            $L[] = '';
            $L[] = 'Each code node runs its file in `code/` (`code/start_<name>.py` is the Start option\'s code).';
            $L[] = 'The file is read at each run: an edit takes effect on the next run, with no recompile. The code';
            $L[] = 'runs under the same rules as in the editor (`code_harness.py`): standard library only, network';
            $L[] = 'only through `call_tool`, one of the node\'s exits, its timeout.';
            $L[] = '';
        }
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /** The A2A agent servers: what starts them, their files and default URLs. $agents: a2aLayout()['agents']. */
    private static function a2aAgentLines(array $agents): array
    {
        $L = [];
        $L[] = '### Agent servers';
        $L[] = '';
        $L[] = 'The orchestrator starts every agent server at launch and stops them when it ends. `--keep-serving` leaves';
        $L[] = 'them running; `--no-spawn` starts none and uses servers already running, each at its `A2A_AGENT_<id>_URL`';
        $L[] = '(default below; `A2A_BASE_PORT` moves the whole range).';
        $L[] = '';
        $L[] = '| Node | File | Default URL |';
        $L[] = '|---|---|---|';
        foreach ($agents as $nid => $e) {
            $L[] = "| {$e['display']} ({$nid}) | `{$e['file']}` | http://127.0.0.1:{$e['port']}/ |";
        }
        $L[] = '';
        $first = $agents ? $agents[array_key_first($agents)] : null;
        if ($first !== null) {
            $L[] = "To start one by hand: `python {$first['file']} --port {$first['port']}` (`--host` sets the interface).";
            $L[] = '';
        }
        return $L;
    }
}
