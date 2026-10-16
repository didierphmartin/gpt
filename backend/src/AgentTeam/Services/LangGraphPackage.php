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
    /** What every package imports (workflow, common, api), before provider, skill and document extras. */
    private const BASE_REQUIREMENTS = ['langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx',
        'pydantic', 'python-dotenv', 'fastapi', 'uvicorn'];

    /** Providers whose LLM factory branch (llmFactoryLines()) imports a package beyond the base ones. */
    private const PROVIDER_REQUIREMENTS = ['gemini' => 'langchain-google-genai', 'google' => 'langchain-google-genai'];

    /** The document converter's lazy imports, by attachment extension (documentConverterBlock()). */
    private const DOCUMENT_REQUIREMENTS = ['pdf' => 'pypdf', 'docx' => 'mammoth', 'pptx' => 'python-pptx', 'xlsx' => 'openpyxl'];

    private const SKIP_NAMES = ['__pycache__', '.DS_Store'];

    /** The swarm package's workflow.py builds its graph with create_swarm() (langgraph_swarm). */
    private const SWARM_REQUIREMENTS = ['langgraph-swarm'];

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
        $out = [
            ['path' => 'requirements.txt', 'code' => self::requirements($facts, $skills)],
            ['path' => '.env.example', 'code' => self::envExample($facts)],
            ['path' => 'README.md', 'code' => self::readme($facts)],
        ];
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
     * Every file of every used skill folder (skipping __pycache__, .DS_Store, *.pyc), sorted.
     *
     * @return list<array{dir:string,rel:string,bytes:string,entry:array}>
     */
    private static function skillFiles(array $facts, string $skillsRoot): array
    {
        $out = [];
        $root = realpath($skillsRoot);
        foreach (self::skillDirs($facts) as $d) {
            // dir_name comes from the client-saved node config: one plain path segment, resolved inside the root.
            $safe = $d !== '' && $d !== '.' && $d !== '..' && !str_contains($d, '/') && !str_contains($d, '\\') && !str_contains($d, "\0");
            $base = $safe && $root !== false ? realpath($root . DIRECTORY_SEPARATOR . $d) : false;
            if ($base === false || !str_starts_with($base, $root . DIRECTORY_SEPARATOR) || !is_dir($base)) {
                throw new RuntimeException("Skill folder \"{$d}\" is not available on this server, so it can't be packaged.");
            }
            $found = [];
            $it = new \RecursiveIteratorIterator(new \RecursiveCallbackFilterIterator(
                new \RecursiveDirectoryIterator($base, \FilesystemIterator::SKIP_DOTS),
                fn(\SplFileInfo $f) => !in_array($f->getFilename(), self::SKIP_NAMES, true) && !str_ends_with($f->getFilename(), '.pyc')
                    && !str_starts_with($f->getFilename(), '.env')));
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
    private static function skillDependencies(string $skillMd): array
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

    /** requirements.txt: one per line, sorted, unique. */
    private static function requirements(array $facts, array $skillFiles): string
    {
        $req = isset($facts['swarm']) ? array_merge(self::BASE_REQUIREMENTS, self::SWARM_REQUIREMENTS) : self::BASE_REQUIREMENTS;
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
        foreach ($facts['startDocuments'] ?? [] as $doc) {
            $ext = strtolower(pathinfo((string) (is_array($doc) ? ($doc['path'] ?? $doc['name'] ?? '') : ''), PATHINFO_EXTENSION));
            if (isset(self::DOCUMENT_REQUIREMENTS[$ext])) {
                $req[] = self::DOCUMENT_REQUIREMENTS[$ext];
            }
        }
        $req = array_values(array_unique($req));
        sort($req, SORT_STRING);
        return implode("\n", $req) . "\n";
    }

    /** .env.example: every variable the program reads, commented. */
    private static function envExample(array $facts): string
    {
        $L = [];
        $L[] = '# Environment of the workflow "' . $facts['wfName'] . '" -- copy this file to .env and fill it in.';
        $L[] = '# The program reads .env from its own folder first, then from the folder two levels up';
        $L[] = '# (a local runner\'s .env). A variable already set in the environment is never overridden.';
        $L[] = '';
        $keys = [];
        foreach (self::providers($facts) as $p) {
            $k = PythonEmitHelpers::providerKeyEnv($p);
            if ($k !== null) {
                $keys[$k][] = $p;
            }
        }
        if ($keys) {
            $L[] = '# API keys of the LLM providers this workflow uses';
            foreach ($keys as $k => $provs) {
                $L[] = '# ' . implode(', ', array_unique($provs));
                $L[] = "{$k}=";
            }
        } else {
            $L[] = '# No LLM provider is used by a node of this workflow.';
        }
        $L[] = '';
        $decision = [];
        foreach ($facts['agentData'] ?? [] as $ad) {
            foreach (!empty($ad['dispatch']) ? ($ad['decision'] ?? []) : [] as $c) {
                $decision[(string) $c['key_env']] = (string) $c['url_env'];
            }
        }
        if ($decision) {
            $L[] = '# Decision models the dispatchers may route with (each URL variable is optional: a gateway)';
            foreach ($decision as $key => $url) {
                $L[] = "{$key}=";
                $L[] = "# {$url}=";
            }
            $L[] = '';
        }
        $slugs = $facts['serverSlugs'] ?? [];
        if ($slugs) {
            $L[] = '# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)';
            foreach ($slugs as $url => $slug) {
                $up = strtoupper((string) $slug);
                $L[] = "MCP_URL_{$up}={$url}";
                $L[] = '# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}';
                $L[] = "MCP_HEADERS_{$up}=";
            }
            $L[] = '';
        }
        $L[] = '# Optional';
        $L[] = '# One model for every node, instead of each node\'s own';
        $L[] = '# MODEL_NAME=';
        $L[] = '# Where saved outputs go (default: outputs/ in this folder)';
        $L[] = '# SYNERGYAI_OUTPUT_ROOT=./outputs';
        $L[] = '# Where run logs go (default: runs/ in this folder)';
        $L[] = '# RUNS_DIR=./runs';
        if (self::skillDirs($facts) !== []) {
            $L[] = '# Where the skills are read from (default: skills/ in this folder)';
            $L[] = '# SYNERGYAI_SKILLS_DIR=./skills';
        }
        return implode("\n", $L) . "\n";
    }

    /** README.md: install, configure, modes, files written, run server, service units, code nodes. */
    private static function readme(array $facts): string
    {
        $name = (string) $facts['wfName'];
        $root = (string) $facts['safeName'] . (isset($facts['swarm']) ? '_modular_swarm' : '_modular');
        $slug = strtolower(trim((string) preg_replace('/[^a-z0-9]+/i', '-', $name), '-')) ?: 'workflow';
        // A swarm's workflow.py runs a prompt, or --cron; it has no --watch / --once / --quiet.
        $swarm = isset($facts['swarm']);
        $mode = $swarm ? 'prompt' : (string) ($facts['startMode'] ?? 'prompt');
        $def = fn(string $m) => $m === $mode ? ' **(default)**' : '';
        $L = [];
        $L[] = "# {$name}";
        $L[] = '';
        $L[] = 'A LangGraph program compiled from the SynergyAI workflow editor. It runs on its own: no database,';
        $L[] = 'no SynergyAI server. Everything it needs is in this folder.';
        $L[] = '';
        $L[] = '## Install';
        $L[] = '';
        $L[] = '```sh';
        $L[] = 'python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt';
        $L[] = 'cp .env.example .env   # then fill in the API keys and MCP headers';
        $L[] = '```';
        $L[] = '';
        $L[] = '## Modes';
        $L[] = '';
        $L[] = 'One mode per launch. With no flag the program runs in the mode its Start node set.';
        $L[] = '';
        $L[] = '| Command | Mode |';
        $L[] = '|---|---|';
        $L[] = '| `python workflow.py ["text"]` | one run on the text, or on the Start\'s prompt' . $def('prompt') . ' |';
        $L[] = '| `python workflow.py --cron [EXPR]` | a run on each tick of the schedule, until stopped' . $def('cron') . ' |';
        if (!$swarm) {
            $L[] = '| `python workflow.py --watch [server.tool {json}]` | a run for each event the trigger reports, until stopped' . $def('watch') . ' |';
            $L[] = '| `python workflow.py --once "text"` | exactly one run, whatever the default mode |';
        }
        $L[] = '';
        if (!$swarm) {
            $L[] = '`--quiet` prints only the done / failed line of each run; `--verbose` adds the progress lines.';
        }
        $L[] = 'Ctrl-C (or SIGTERM) stops a loop after the current run.';
        $L[] = '';
        $L[] = '## Files written';
        $L[] = '';
        $L[] = '- `outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).';
        $L[] = '- `runs/` -- one `<date>_<run id>.jsonl` event log per run, and `runs/current` (`RUNS_DIR` overrides).';
        $L[] = '  A run with nothing to do leaves no file.';
        $L[] = '';
        $L[] = '## Run server';
        $L[] = '';
        $L[] = '```sh';
        $L[] = 'python api.py            # HTTP run server: POST /runs, an SSE event stream per run';
        $L[] = 'python api.py --listen   # the same, plus the default mode running in the background';
        $L[] = '```';
        $L[] = '';
        $L[] = '## Running as a service';
        $L[] = '';
        $L[] = "Replace `/path/to/{$root}` with this folder's absolute path.";
        if ($mode === 'prompt') {
            $L[] = 'This workflow\'s default is one run, and a service is restarted when it exits: add `--cron EXPR`'
                . ($swarm ? '' : ' (or `--watch`)') . ' after `workflow.py` so it keeps running.';
        }
        $L[] = '';
        $L[] = "macOS (launchd): save as `~/Library/LaunchAgents/ai.synergy.{$slug}.plist`, then";
        $L[] = "`launchctl load ~/Library/LaunchAgents/ai.synergy.{$slug}.plist`.";
        $L[] = '';
        $L[] = '```xml';
        $L[] = '<?xml version="1.0" encoding="UTF-8"?>';
        $L[] = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
        $L[] = '<plist version="1.0">';
        $L[] = '<dict>';
        $L[] = '  <key>Label</key>';
        $L[] = "  <string>ai.synergy.{$slug}</string>";
        $L[] = '  <key>ProgramArguments</key>';
        $L[] = '  <array>';
        $L[] = "    <string>/path/to/{$root}/.venv/bin/python</string>";
        $L[] = "    <string>/path/to/{$root}/workflow.py</string>";
        $L[] = '  </array>';
        $L[] = '  <key>WorkingDirectory</key>';
        $L[] = "  <string>/path/to/{$root}</string>";
        $L[] = '  <key>KeepAlive</key>';
        $L[] = '  <true/>';
        $L[] = '  <key>StandardOutPath</key>';
        $L[] = "  <string>/path/to/{$root}/runs/service.log</string>";
        $L[] = '  <key>StandardErrorPath</key>';
        $L[] = "  <string>/path/to/{$root}/runs/service.log</string>";
        $L[] = '</dict>';
        $L[] = '</plist>';
        $L[] = '```';
        $L[] = '';
        $L[] = "Linux (systemd): save as `/etc/systemd/system/{$slug}.service`, then `systemctl enable --now {$slug}`.";
        $L[] = '';
        $L[] = '```ini';
        $L[] = '[Unit]';
        $L[] = "Description={$name} (LangGraph)";
        $L[] = 'After=network-online.target';
        $L[] = '';
        $L[] = '[Service]';
        $L[] = "ExecStart=/path/to/{$root}/.venv/bin/python /path/to/{$root}/workflow.py";
        $L[] = "WorkingDirectory=/path/to/{$root}";
        $L[] = 'Restart=always';
        $L[] = '';
        $L[] = '[Install]';
        $L[] = 'WantedBy=multi-user.target';
        $L[] = '```';
        if (($facts['codeData'] ?? []) !== []) {
            $L[] = '';
            $L[] = '## Editing code nodes';
            $L[] = '';
            $L[] = 'Each code node runs its file in `code/` (`code/start_<name>.py` is the Start option\'s code).';
            $L[] = 'The file is read at each run: an edit takes effect on the next run, with no recompile. The code';
            $L[] = 'runs under the same rules as in the editor (`code_harness.py`): standard library only, network';
            $L[] = 'only through `call_tool`, one of the node\'s exits, its timeout.';
        }
        return implode("\n", $L) . "\n";
    }
}
