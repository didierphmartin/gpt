<?php
/**
 * Shared by the differential oracles (php_compile.php, php_compiled_emit.php): the backend's autoloader
 * (this repository's backend/src, no vendor), fixture repositories and the in-memory SQLite database.
 */
declare(strict_types=1);

error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', 'stderr');
ini_set('error_log', '/dev/null');   // the compilers' error_log() notes are not output
date_default_timezone_set('UTC');
// Every compile target sets this before it emits (XAMPP's php.ini says 100): shortest round-trip floats.
ini_set('serialize_precision', '-1');

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
