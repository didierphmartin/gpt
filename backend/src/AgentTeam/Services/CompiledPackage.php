<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use RuntimeException;

/**
 * The files that make a compiled ADK, MAF or NOOA program run on its own, in its own folder, as LangGraph's
 * packages do: requirements.txt, .env.example, README.md and, for a package, the code-node harness (a copy,
 * code_harness.py), each code node's code (code/), each used skill's folder (skills/) and the Start's
 * documents (start_documents/). workflow.py, common.py and api.py are the target generator's.
 *
 * $target names the compile target: ['key' => 'adk', 'title' => 'Google ADK', 'framework' => [package, ...]]
 * (ADKPackage::TARGET, MAFGenerator::TARGET, NOOAGenerator::TARGET). $layout: 'single' | 'modular' | 'a2a'.
 */
final class CompiledPackage
{
    /** What every compiled program imports besides its framework: the MCP client and .env. */
    private const BASE_REQUIREMENTS = ['httpx', 'python-dotenv'];

    /** A package's run server (api.py; an A2A agent server serves with uvicorn too). */
    private const SERVER_REQUIREMENTS = ['fastapi', 'uvicorn'];

    /** The A2A package: its servers are A2A servers, its orchestrator their client. */
    private const A2A_REQUIREMENTS = ['a2a-sdk[http-server]'];

    /** The TO RUN install line of a package's files: the package's requirements.txt holds the list. */
    public const PIP_REQUIREMENTS = 'pip install -r requirements.txt';

    private const HARNESS = __DIR__ . '/../../../../frontend/assets/py/code_node_harness.py';

    /**
     * @param array $analyzed the generator's analysis, with 'startDocuments' already pointing at start_documents/
     * @param list<array> $documentFiles the start_documents/ entries (LangGraphPackage::startDocuments()['files'])
     * @return list<array{path:string,code:string,encoding?:string}>
     */
    public static function files(array $analyzed, string $skillsRoot, array $documentFiles, array $target,
        string $layout = 'modular'): array
    {
        $skills = LangGraphPackage::skillFiles(['agentData' => $analyzed['agents'] ?? []], $skillsRoot);
        $out = self::docFiles($analyzed, $target, $layout, $skills, self::folder($analyzed, $target, $layout),
            $layout === 'a2a' ? 'orchestrator.py' : 'workflow.py');
        if (($analyzed['code'] ?? []) !== []) {
            $harness = file_get_contents(self::HARNESS);
            if ($harness === false) {
                throw new RuntimeException('code node harness not found (frontend/assets/py/code_node_harness.py)');
            }
            $out[] = ['path' => 'code_harness.py', 'code' => $harness];
            foreach ($analyzed['code'] as $nid => $cd) {
                $out[] = LangGraphPackage::codeFile((string) $nid, $cd, self::isTrigger($analyzed, (string) $nid));
            }
        }
        foreach ($skills as $f) {
            $out[] = $f['entry'];
        }
        foreach ($documentFiles as $f) {
            $out[] = $f;
        }
        return $out;
    }

    /**
     * The files a single-file export carries beside its script ($filename): requirements.txt, .env.example and
     * README.md (the script reads the .env next to it first).
     *
     * @return list<array{path:string,code:string}>
     */
    public static function singleFiles(array $analyzed, array $target, string $filename): array
    {
        return self::docFiles($analyzed, $target, 'single', [], (string) preg_replace('/\.py$/', '', $filename), $filename);
    }

    /** The folder a $layout export unzips to: the package's root, the single file's name. */
    private static function folder(array $analyzed, array $target, string $layout): string
    {
        return preg_replace('/[^a-z0-9_]+/i', '_', strtolower((string) $analyzed['workflow']['name'])) . '_' . $target['key']
            . ($layout === 'a2a' ? '_a2a' : '');
    }

    private static function docFiles(array $analyzed, array $target, string $layout, array $skillFiles, string $folder, string $entry): array
    {
        return [
            ['path' => 'requirements.txt', 'code' => PythonRequirements::txt(self::requirementNames($analyzed, $target, $layout, $skillFiles))],
            ['path' => '.env.example', 'code' => PackageDocs::envExample((string) $analyzed['workflow']['name'], self::envVariables($analyzed),
                self::optionalEnv($analyzed, $layout))],
            ['path' => 'README.md', 'code' => self::readme($analyzed, $target, $layout, $folder, $entry)],
        ];
    }

    /** code/<file> of a code node, as files() writes it. */
    public static function codePath(array $analyzed, string $nid): string
    {
        return LangGraphPackage::codeFile($nid, $analyzed['code'][$nid], self::isTrigger($analyzed, $nid))['path'];
    }

    /** The Start option's hidden code node (StartOptionGraph) carries its trigger in its config. */
    private static function isTrigger(array $analyzed, string $nid): bool
    {
        return is_array($analyzed['byId'][$nid]['config']['start_trigger'] ?? null);
    }

    private static function providers(array $analyzed): array
    {
        $p = [];
        foreach (array_merge(array_values($analyzed['agents'] ?? []), array_values($analyzed['playbooks'] ?? [])) as $d) {
            if (($d['provider'] ?? '') !== '') {
                $p[strtolower((string) $d['provider'])] = true;
            }
        }
        return array_keys($p);
    }

    /**
     * The packages a $target program of $layout imports: the one list its requirements.txt, its TO RUN install
     * line and its README come from. $skillFiles: the skills the package carries (their SKILL.md dependencies);
     * the single file reads its skills from the editor's folder and installs their dependencies at the first run.
     *
     * @return list<string>
     */
    public static function requirementNames(array $analyzed, array $target, string $layout, array $skillFiles = []): array
    {
        $req = array_merge($target['framework'], self::BASE_REQUIREMENTS);
        if ($layout !== 'single') {
            array_push($req, ...self::SERVER_REQUIREMENTS);
        }
        if ($layout === 'a2a') {
            array_push($req, ...self::A2A_REQUIREMENTS);
        }
        // A playbook node runs the shared interpreter (langchain-core + langgraph + its provider's package).
        array_push($req, ...PlaybookEmit::requirementNames($analyzed));
        foreach ($skillFiles as $f) {
            if ($f['rel'] === 'SKILL.md') {
                array_push($req, ...LangGraphPackage::skillDependencies($f['bytes']));
            }
        }
        array_push($req, ...PythonRequirements::documentNames($analyzed['startDocuments'] ?? []));
        return $req;
    }

    /** The single file's TO RUN install line (no requirements.txt beside the script in the editor's scripts/). */
    public static function pipInstall(array $analyzed, array $target): string
    {
        return PythonRequirements::pipInstall(self::requirementNames($analyzed, $target, 'single'));
    }

    /** The environment the program reads that .env must provide (PackageDocs' $vars). */
    public static function envVariables(array $analyzed): array
    {
        $keys = [];
        foreach (self::providers($analyzed) as $p) {
            $k = PythonEmitHelpers::providerKeyEnv($p);
            if ($k !== null) {
                $keys[$k][] = $p;
            }
        }
        $decision = [];
        foreach ((array) ($analyzed['decisions'] ?? []) as $d) {
            foreach ($d['decision'] as $c) {
                $decision[(string) $c['key_env']] = (string) $c['url_env'];
            }
        }
        return ['keys' => $keys, 'decision' => $decision, 'mcp' => $analyzed['serverSlugs'] ?? []];
    }

    /** The optional variables a $layout program reads, as .env.example lists them: [what it does, KEY=example]. */
    private static function optionalEnv(array $analyzed, string $layout): array
    {
        $single = $layout === 'single';
        $o = [$single
            ? ['Where saved outputs go (default: ~/Documents/synergyAI/outputs)', 'SYNERGYAI_OUTPUT_ROOT=/path/to/outputs']
            : ['Where saved outputs go (default: outputs/ in this folder)', 'SYNERGYAI_OUTPUT_ROOT=./outputs']];
        if (!$single) {
            $o[] = ['Where workflow.py writes its run logs (default: runs/ in this folder)', 'RUNS_DIR=./runs'];
        }
        if (LangGraphPackage::skillDirs(['agentData' => $analyzed['agents'] ?? []]) !== []) {
            $o[] = $single
                ? ['Where the skills are read from (default: ' . PackageDocs::EDITOR_SKILLS_DIR . ')', 'SYNERGYAI_SKILLS_DIR=/path/to/skills']
                : ['Where the skills are read from (default: skills/ in this folder)', 'SYNERGYAI_SKILLS_DIR=./skills'];
        }
        if ($layout === 'a2a') {
            $o[] = ['First port of the agent servers, one per node in order (default: 8701)', 'A2A_BASE_PORT=8701'];
        }
        return $o;
    }

    /** README.md: what the folder is, install, configure, the run modes, run server, service, files. */
    private static function readme(array $analyzed, array $target, string $layout, string $folder, string $entry): string
    {
        $name = (string) $analyzed['workflow']['name'];
        $title = (string) $target['title'];
        $skills = LangGraphPackage::skillDirs(['agentData' => $analyzed['agents'] ?? []]);
        $intro = match ($layout) {
            'single' => ["A {$title} program compiled from the SynergyAI workflow editor, as one Python file: `{$entry}`.",
                'It runs on its own: no database, no SynergyAI server.'],
            'a2a' => ["A {$title} program compiled from the SynergyAI workflow editor, as A2A agents: each node is an A2A",
                'server of its own (`servers/`), and `orchestrator.py` runs the workflow over them. It runs on its own: no',
                'database, no SynergyAI server. Everything it needs is in this folder.'],
            default => ["A {$title} program compiled from the SynergyAI workflow editor, with each node in a file of its own",
                '(`agents/`). It runs on its own: no database, no SynergyAI server. Everything it needs is in this folder.'],
        };
        if ($layout === 'single') {
            array_push($intro, ...PackageDocs::editorSkillsNote($skills));
        }
        $L = PackageDocs::head($name, $intro, $folder, self::envVariables($analyzed));
        $L[] = '## Run';
        $L[] = '';
        $L[] = 'Run these from the folder, with the environment active.';
        $L[] = '';
        $startMode = (string) ($analyzed['startMode'] ?? 'prompt');
        if ($layout === 'single') {
            $L[] = '```sh';
            $L[] = "python {$entry} \"your prompt\"   # one run on the text (no text: the Start node's prompt)";
            $L[] = '```';
            $L[] = '';
            $L[] = 'The single file makes one run per launch: it has no schedule or event-trigger mode, and no run server.';
            $L[] = 'Export with "agents in separate files" for those.';
            $L[] = '';
        } else {
            if ($layout === 'a2a') {
                $L[] = '```sh';
                $L[] = 'python orchestrator.py "your prompt"   # one run over the agent servers (no text: the Start node\'s prompt)';
                $L[] = '```';
                $L[] = '';
                array_push($L, ...self::a2aServerLines(CompiledA2AEmit::layout($analyzed)));
                $L[] = '`workflow.py` runs the same workflow in one process, without the agent servers, in any of these modes:';
                $L[] = '';
            }
            array_push($L, ...PackageDocs::modes('workflow.py', $startMode, $analyzed['defaultCron'] ?? null, $analyzed['defaultWatch'] ?? null, true));
        }
        $L[] = '## Files written';
        $L[] = '';
        if ($layout === 'single') {
            $L[] = '- `~/Documents/synergyAI/outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).';
        } else {
            $L[] = '- `outputs/` in this folder -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).';
            $L[] = '- `runs/` in this folder -- one `<date>_<run id>.jsonl` event log per run of `workflow.py` (`RUNS_DIR` overrides).';
        }
        $L[] = '';
        if ($layout !== 'single') {
            array_push($L, ...PackageDocs::runServer($layout === 'modular',
                $layout === 'a2a' ? ['The agent servers start with its first run and stop when it exits.'] : []));
            array_push($L, ...PackageDocs::service($name, $title, $folder, 'workflow.py', '', $startMode));
        }
        $L[] = '## Files';
        $L[] = '';
        if ($layout === 'single') {
            $L[] = "- `{$entry}` -- the whole program: the runtime, one node of the canvas per agent / executor, the CLI.";
        } else {
            if ($layout === 'a2a') {
                $L[] = '- `orchestrator.py` -- walks the canvas, sending each node its input as an A2A task.';
                $L[] = '- `servers/` -- one A2A agent server per node.';
            }
            $L[] = '- `workflow.py` -- the workflow: assembles the nodes and runs them; its CLI is above.';
            $L[] = '- `agents/` -- one module per node; `common.py` -- the runtime they share.';
            $L[] = '- `api.py` -- the run server.';
        }
        if (($analyzed['code'] ?? []) !== [] && $layout !== 'single') {
            $L[] = '- `code/` -- each code node\'s Python, read at every run (edit it here to change the node).';
            $L[] = '- `code_harness.py` -- the code-node contract (inputs, exits, declared MCP servers, timeout), as the editor runs it.';
        }
        if ($skills !== [] && $layout !== 'single') {
            $L[] = '- `skills/` -- the skills the agents run.';
        }
        if (($analyzed['startDocuments'] ?? []) !== [] && $layout !== 'single') {
            $L[] = '- `start_documents/` -- the documents attached to the Start node.';
        }
        return implode("\n", $L) . "\n";
    }

    /** The A2A servers: what starts them, their files and default URLs. $servers: CompiledA2AEmit::layout(). */
    private static function a2aServerLines(array $servers): array
    {
        $L = [];
        $L[] = 'The orchestrator starts every agent server at its first run and stops them when it ends. `--keep-serving`';
        $L[] = 'leaves them running; `--no-spawn` starts none and uses servers already running, each at its';
        $L[] = '`A2A_AGENT_<id>_URL` (default below; `A2A_BASE_PORT` moves the whole range).';
        $L[] = '';
        $L[] = '| Node | File | Default URL |';
        $L[] = '|---|---|---|';
        foreach ($servers as $nid => $e) {
            $L[] = "| {$e['display']} ({$nid}) | `{$e['file']}` | http://127.0.0.1:{$e['port']}/ |";
        }
        $L[] = '';
        $first = $servers ? $servers[array_key_first($servers)] : null;
        if ($first !== null) {
            $L[] = "To start one by hand: `python {$first['file']} --port {$first['port']}` (`--host` sets the interface).";
            $L[] = '';
        }
        return $L;
    }
}
