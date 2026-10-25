<?php
/**
 * The PHP side of the compiler differential test (tests/CompilerParity.test.ts): runs backend/'s
 * LangGraph compiler on a fixture without MySQL and prints the result as JSON.
 *
 *   php php_compile.php compile <fixture.json>   -> {"ok": true, "result": <generate() result>} | {"ok": false, "error": "..."}
 *   php php_compile.php target <fixture.json> <target> <mode>
 *                                               -> one target's (langgraph|adk|maf|nooa) result in one mode
 *                                                  (single|modular|a2a), as WorkflowController generates it
 *   php php_compile.php targets <fixture.json>   -> {target: {mode: that result}} for every target and mode
 *   php php_compile.php facts <fixture.json>     -> analyzeForEmit()'s facts (the workflow object as its fields)
 *   php php_compile.php call                     -> stdin {"class", "method", "args": [...]}: a static method's
 *                                                   return value (private ones too); an argument
 *                                                   {"$facts": "<fixture.json>"} is that fixture's facts
 *
 * A fixture: {workflow: {id, name, user_id, orchestration, output_storage_enabled, output_folder}, user_id,
 * graph: {nodes, edges}, agents: {id: agent record}, code_components: {id: component row}, sql: [statements],
 * skills: {dir: {relative path: text}}, options: {a2a, modular}}. The database is an in-memory SQLite
 * (schema below + the fixture's statements); repositories are in-memory stubs. No vendor/ autoloader is
 * needed: backend/src is loaded by its PSR-4 prefixes.
 */
declare(strict_types=1);

$backend = realpath(__DIR__ . '/../../../../backend');
spl_autoload_register(function (string $class) use ($backend): void {
    foreach (['AgentTeam\\' => '/src/AgentTeam/', 'Quantis\\AIPortfolioAssistant\\' => '/src/'] as $prefix => $dir) {
        if (str_starts_with($class, $prefix)) {
            $f = $backend . $dir . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
            if (is_file($f)) {
                require_once $f;
            }
            return;
        }
    }
});
date_default_timezone_set(getenv('TZ') ?: 'UTC');
ini_set('serialize_precision', '-1');
error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', 'stderr');
ini_set('error_log', '/dev/null');

// The tables the compiler reads (shared with the TypeScript side: tests/support/compilerFixture.ts).
define('BASE_SCHEMA', json_decode((string) file_get_contents(__DIR__ . '/schema.json'), true));

/** A fixture file; {"extends": "<other fixture>", ...} is that fixture with these top-level keys replaced. */
function fixture_load(string $path): array
{
    $fx = json_decode((string) file_get_contents($path), true);
    if (isset($fx['extends'])) {
        $base = fixture_load(dirname($path) . '/' . $fx['extends'] . '.json');
        unset($fx['extends']);
        $fx = array_replace($base, $fx);
    }
    return $fx;
}

function fixture_pdo(array $fx): PDO
{
    $pdo = new PDO('sqlite::memory:');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    foreach (array_merge(BASE_SCHEMA, $fx['sql'] ?? []) as $s) {
        $pdo->exec($s);
    }
    return $pdo;
}

function fixture_skills_root(array $fx): string
{
    $root = sys_get_temp_dir() . '/lg_parity_skills_' . getmypid() . '_' . bin2hex(random_bytes(3));
    mkdir($root, 0777, true);
    foreach ($fx['skills'] ?? [] as $dir => $files) {
        foreach ($files as $rel => $text) {
            @mkdir(dirname("{$root}/{$dir}/{$rel}"), 0777, true);
            file_put_contents("{$root}/{$dir}/{$rel}", $text);
        }
    }
    register_shutdown_function(function () use ($root): void {
        exec('rm -rf ' . escapeshellarg($root));
    });
    return $root;
}

function fixture_generator(array $fx, string $class = \AgentTeam\Services\LangGraphGenerator::class): object
{
    $pdo = fixture_pdo($fx);
    $wf = new \AgentTeam\Models\Workflow($fx['workflow']);
    $wfRepo = new class($wf) extends \AgentTeam\Services\WorkflowRepository {
        public function __construct(private \AgentTeam\Models\Workflow $wf) {}
        public function findById(int $id, bool $includeGraph = false): ?\AgentTeam\Models\Workflow
        {
            return $this->wf;
        }
    };
    $graphRepo = new class($fx) extends \AgentTeam\Services\WorkflowGraphRepository {
        public function __construct(private array $fx) {}
        public function getGraph(int $workflowId): array
        {
            $components = $this->fx['code_components'] ?? [];
            return \AgentTeam\Services\StartOptionGraph::expand($this->fx['graph'],
                fn(int $id): ?array => $components[(string) $id] ?? null);
        }
    };
    $agentRepo = new class($fx['agents'] ?? []) extends \AgentTeam\Services\AgentRepository {
        public function __construct(private array $agents) {}
        public function findById(int $id): ?\AgentTeam\Models\Agent
        {
            return isset($this->agents[(string) $id]) ? new \AgentTeam\Models\Agent($this->agents[(string) $id]) : null;
        }
    };
    return new $class($pdo, $wfRepo, $graphRepo, $agentRepo, fixture_skills_root($fx), fixture_documents($fx));
}

/**
 * The user's document storage when the fixture has "start_documents": {"user_folder": f, "files": {path: text | {"base64": b}}}:
 * a local root holding synergyaichatroot/<f>/<path> (no universalFS adapter), read through StartDocumentStore.
 */
function fixture_documents(array $fx): ?\AgentTeam\Services\StartDocumentStore
{
    if (!isset($fx['start_documents'])) {
        return null;
    }
    $root = sys_get_temp_dir() . '/lg_parity_docs_' . getmypid() . '_' . bin2hex(random_bytes(3));
    $folder = (string) $fx['start_documents']['user_folder'];
    foreach ($fx['start_documents']['files'] ?? [] as $rel => $content) {
        $p = "{$root}/synergyaichatroot/{$folder}/{$rel}";
        @mkdir(dirname($p), 0777, true);
        file_put_contents($p, is_array($content) ? base64_decode($content['base64']) : $content);
    }
    register_shutdown_function(function () use ($root): void {
        exec('rm -rf ' . escapeshellarg($root));
    });
    return new \AgentTeam\Services\StartDocumentStore($folder, null, $root);
}

/** The generator classes of the compile targets (php_compile.php targets). */
const TARGET_CLASSES = [
    'langgraph' => \AgentTeam\Services\LangGraphGenerator::class,
    'adk' => \AgentTeam\Services\ADKGenerator::class,
    'maf' => \AgentTeam\Services\MAFGenerator::class,
    'nooa' => \AgentTeam\Services\NOOAGenerator::class,
];

/**
 * One target's generation of a fixture in one code structure, as WorkflowController calls it: LangGraph's
 * generate() with {a2a} / {modular} / {}, the other targets' generateA2A() / generatePackage() / generate().
 */
function fixture_target_compile(array $fx, string $target, string $mode): array
{
    $gen = fixture_generator($fx, TARGET_CLASSES[$target]);
    $wid = (int) $fx['workflow']['id'];
    $uid = isset($fx['user_id']) ? (string) $fx['user_id'] : null;
    try {
        if ($target === 'langgraph') {
            $result = $gen->generate($wid, $uid, ['a2a' => $mode === 'a2a', 'modular' => $mode === 'modular']);
        } else {
            $result = match ($mode) {
                'a2a' => $gen->generateA2A($wid, $uid),
                'modular' => $gen->generatePackage($wid, $uid),
                default => $gen->generate($wid, $uid),
            };
        }
        return ['ok' => true, 'result' => $result];
    } catch (\Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)];
    }
}

function fixture_facts(string $path): array
{
    $fx = fixture_load($path);
    $gen = fixture_generator($fx);
    $m = new ReflectionMethod($gen, 'analyzeForEmit');
    $facts = $m->invoke($gen, (int) $fx['workflow']['id'], isset($fx['user_id']) ? (string) $fx['user_id'] : null);
    $w = $facts['workflow'];
    $facts['workflow'] = ['id' => $w->getId(), 'name' => $w->getName(), 'output_storage_enabled' => $w->isOutputStorageEnabled(),
        'output_folder' => $w->getOutputFolder(), 'orchestration' => $w->getOrchestration()];
    return $facts;
}

function out(mixed $v): void
{
    echo json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE), "\n";
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') !== __FILE__) {
    return;   // required by another harness script for the fixture functions above
}
$cmd = $argv[1] ?? '';
try {
    switch ($cmd) {
        case 'compile':
            $fx = fixture_load($argv[2]);
            $gen = fixture_generator($fx);
            $result = $gen->generate((int) $fx['workflow']['id'], isset($fx['user_id']) ? (string) $fx['user_id'] : null, $fx['options'] ?? []);
            out(['ok' => true, 'result' => $result]);
            break;
        case 'target':   // target <fixture.json> <langgraph|adk|maf|nooa> <single|modular|a2a>
            out(fixture_target_compile(fixture_load($argv[2]), $argv[3], $argv[4]));
            break;
        case 'targets':   // targets <fixture.json> -> {target: {mode: {ok, result} | {ok: false, error}}}
            $fx = fixture_load($argv[2]);
            $all = [];
            foreach (array_keys(TARGET_CLASSES) as $t) {
                foreach (['single', 'modular', 'a2a'] as $m) {
                    $all[$t][$m] = fixture_target_compile($fx, $t, $m);
                }
            }
            out($all);
            break;
        case 'facts':
            out(fixture_facts($argv[2]));
            break;
        case 'call':
            $req = json_decode((string) stream_get_contents(STDIN), true);
            $args = array_map(fn($a) => is_array($a) && isset($a['$facts']) ? fixture_facts($a['$facts']) : $a, $req['args'] ?? []);
            $class = (str_contains($req['class'], '\\') ? '' : 'AgentTeam\\Services\\') . $req['class'];
            $m = new ReflectionMethod($class, $req['method']);
            out(['ok' => true, 'result' => $m->invokeArgs(null, $args)]);
            break;
        default:
            fwrite(STDERR, "usage: php_compile.php compile|facts <fixture.json> | call\n");
            exit(2);
    }
} catch (\Throwable $e) {
    out(['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)]);
}
