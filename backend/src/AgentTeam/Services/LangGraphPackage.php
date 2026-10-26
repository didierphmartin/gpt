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
    public static function files(array $facts, string $skillsRoot, ?StartDocumentStore $documents = null): array
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
     * Every file of every used skill folder (skipping __pycache__, .DS_Store, *.pyc, .env*, dot-directories), sorted.
     *
     * @return list<array{dir:string,rel:string,bytes:string,entry:array}>
     */
    public static function skillFiles(array $facts, string $skillsRoot): array
    {
        $out = [];
        $root = realpath($skillsRoot);
        foreach (self::skillDirs($facts) as $d) {
            // dir_name comes from the client-saved node config: plain segments ("GEO/geo-report" for a grouped
            // skill; none empty, "." or "..", none starting with "." (.git, .superpowers), no "\"), resolved
            // inside the root.
            $segments = StartDocumentStore::safeSegments($d);
            $safe = $segments !== null && array_filter($segments, fn(string $seg) => str_starts_with($seg, '.')) === [];
            $base = $safe && $root !== false ? realpath($root . DIRECTORY_SEPARATOR . $d) : false;
            if ($base === false || !str_starts_with($base, $root . DIRECTORY_SEPARATOR) || !is_dir($base)) {
                throw new RuntimeException("Skill folder \"{$d}\" is not available on this server, so it can't be packaged.");
            }
            $found = [];
            $it = new \RecursiveIteratorIterator(new \RecursiveCallbackFilterIterator(
                new \RecursiveDirectoryIterator($base, \FilesystemIterator::SKIP_DOTS),
                fn(\SplFileInfo $f) => !in_array($f->getFilename(), self::SKIP_NAMES, true) && !str_ends_with($f->getFilename(), '.pyc')
                    && !str_starts_with($f->getFilename(), '.env')
                    && !($f->isDir() && str_starts_with($f->getFilename(), '.'))));   // .git/, .pytest_cache/, ...
            foreach ($it as $f) {
                // A file is copied only if it really lives in the skill folder (a symlink may point elsewhere).
                $real = $f->isFile() ? realpath($f->getPathname()) : false;
                if ($real !== false && str_starts_with($real, $base . DIRECTORY_SEPARATOR)) {
                    $found[] = substr($f->getPathname(), strlen($base) + 1);
                }
            }
            sort($found, SORT_STRING);
            foreach ($found as $rel) {
                $bytes = (string) file_get_contents("{$base}/{$rel}");
                $out[] = ['dir' => $d, 'rel' => $rel, 'bytes' => $bytes, 'entry' => self::entry("skills/{$d}/{$rel}", $bytes)];
            }
        }
        return $out;
    }

    /** `dependencies:` of a SKILL.md's frontmatter, parsed as SkillRuntime.ensure_deps parses it. */
    public static function skillDependencies(string $skillMd): array
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
            if (str_starts_with(strtolower($s), 'dependencies:')) {
                $val = trim(trim(explode(':', $s, 2)[1]), '[]');
                $deps = [];
                foreach (explode(',', $val) as $d) {
                    $d = trim(trim(trim($d), "'"), '"');
                    if ($d !== '') {
                        $deps[] = $d;
                    }
                }
                return $deps;
            }
        }
        return [];
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
     * carries (their SKILL.md dependencies); a program that reads its skills from the editor's folder installs
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
        foreach ($skillFiles as $f) {
            if ($f['rel'] === 'SKILL.md') {
                array_push($req, ...self::skillDependencies($f['bytes']));
            }
        }
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
        return ['keys' => $keys, 'decision' => $decision, 'mcp' => $facts['serverSlugs'] ?? []];
    }

    /** The optional variables a $layout program reads, as .env.example lists them: [what it does, KEY=example]. */
    private static function optionalEnv(array $facts, string $layout): array
    {
        $o = [['One model for every node, instead of each node\'s own', 'MODEL_NAME=']];
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
