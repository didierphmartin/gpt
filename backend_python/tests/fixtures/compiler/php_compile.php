<?php
/**
 * Differential oracle: compile fixture workflows with the PHP LangGraph compiler, no database.
 *
 *   php php_compile.php <fixture.json> [<fixture.json> ...]
 *
 * Prints {"<fixture name>": {"<mode>": <generate() result> | {"error": "<message>"}}} as JSON.
 * Each fixture names a workflow row, its graph, the agent records it references,
 * the code components a Start option expands to, and SQL rows for the tables the
 * compiler reads (schema.sql beside this script, in an in-memory SQLite). The
 * Python twin (tests/unit/test_lang_graph_compiler_differential.py) builds the
 * same inputs and compares every emitted file byte for byte.
 */
declare(strict_types=1);

error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', 'stderr');
ini_set('error_log', '/dev/null');   // the compiler's error_log() notes are not output
date_default_timezone_set('UTC');

$src = dirname(__DIR__, 4) . '/backend/src/';
spl_autoload_register(function (string $class) use ($src): void {
    foreach (['AgentTeam\\' => $src . 'AgentTeam/', 'Quantis\\AIPortfolioAssistant\\' => $src] as $ns => $dir) {
        if (str_starts_with($class, $ns)) {
            $file = $dir . str_replace('\\', '/', substr($class, strlen($ns))) . '.php';
            if (is_file($file)) {
                require_once $file;
            }
            return;
        }
    }
});

use AgentTeam\Models\Agent;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\StartOptionGraph;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

final class FixtureWorkflowRepo extends WorkflowRepository
{
    public function __construct(private array $row) {}

    public function findById(int $id, bool $includeGraph = false): ?Workflow
    {
        return (int) $this->row['id'] === $id ? new Workflow($this->row) : null;
    }
}

final class FixtureGraphRepo extends WorkflowGraphRepository
{
    public function __construct(private array $graph, private array $components) {}

    public function getGraph(int $workflowId): array
    {
        $components = $this->components;
        return StartOptionGraph::expand($this->graph, fn(int $id): ?array => $components[(string) $id] ?? null);
    }
}

final class FixtureAgentRepo extends AgentRepository
{
    public function __construct(private array $agents) {}

    public function findById(int $id): ?Agent
    {
        return isset($this->agents[(string) $id]) ? new Agent($this->agents[(string) $id]) : null;
    }
}

function fixturePdo(array $sql): PDO
{
    $pdo = new PDO('sqlite::memory:');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    foreach (array_filter(array_map('trim', explode(";\n", file_get_contents(__DIR__ . '/schema.sql')))) as $ddl) {
        $pdo->exec($ddl);
    }
    foreach ($sql as $stmt) {
        $pdo->exec($stmt);
    }
    return $pdo;
}

$out = [];
foreach (array_slice($argv, 1) as $path) {
    $fx = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    $name = basename($path, '.json');
    $skillsRoot = __DIR__ . '/skills';
    $results = [];
    foreach ($fx['modes'] ?? ['single', 'modular', 'a2a'] as $mode) {
        $gen = new LangGraphGenerator(
            fixturePdo($fx['sql'] ?? []),
            new FixtureWorkflowRepo($fx['workflow']),
            new FixtureGraphRepo($fx['graph'], $fx['code_components'] ?? []),
            new FixtureAgentRepo($fx['agents'] ?? []),
            $skillsRoot,
            // A Start document is copied from storage/synergyaichatroot/<user folder>/ (no universalFS adapter).
            isset($fx['document_store'])
                ? new \AgentTeam\Services\StartDocumentStore((string) $fx['document_store']['user_folder'], null, __DIR__ . '/storage')
                : null
        );
        try {
            $results[$mode] = $gen->generate((int) $fx['workflow']['id'], (string) ($fx['user_id'] ?? '3'),
                ['a2a' => $mode === 'a2a', 'modular' => $mode === 'modular']);
        } catch (Throwable $e) {
            $results[$mode] = ['error' => $e->getMessage()];
        }
    }
    $out[$name] = $results;
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRETTY_PRINT), "\n";
