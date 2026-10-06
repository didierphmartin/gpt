<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Support;

use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * A self-contained "Dispatcher demo" workflow in an in-memory SQLite database,
 * for the compile-target package tests (ADK/MAF/NOOAPackageTest).
 *
 * Those tests used to read workflow 44 from the CONTEXTS database configured in
 * backend/.env, which is the production database. This builds the same shape
 * instead -- Start -> techBuddy (dispatcher) -> IT claims | Human resources ->
 * Output -- in the tables the real repositories read (agent_workflows,
 * workflow_nodes, workflow_edges, mcp_servers, mcp_server_tools,
 * system_llm_settings), so the generators run unchanged against real
 * WorkflowRepository / WorkflowGraphRepository / AgentRepository objects.
 */
final class DispatcherDemoFixture
{
    public const WORKFLOW_ID = 44;

    public static function pdo(): \PDO
    {
        $db = new \PDO('sqlite::memory:');
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);

        $db->exec("CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, workspace_id INTEGER,
            name TEXT, description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1,
            created_at TEXT, updated_at TEXT, output_storage_enabled INTEGER DEFAULT 0, output_folder TEXT,
            orchestration TEXT DEFAULT 'workflow')");
        $db->exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY, workflow_id INTEGER, node_type TEXT,
            agent_id INTEGER, config TEXT, pos_x INTEGER DEFAULT 0, pos_y INTEGER DEFAULT 0,
            drawflow_node_id TEXT, created_at TEXT)');
        $db->exec("CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY, workflow_id INTEGER, from_node_id INTEGER,
            to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1',
            condition_expr TEXT, created_at TEXT)");
        $db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $db->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT,
            description TEXT, input_schema TEXT)');
        $db->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');

        $db->exec("INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-chat', 1)");
        $db->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");

        $wf = self::WORKFLOW_ID;
        $db->exec("INSERT INTO agent_workflows (id, user_id, name, description, steps, orchestration)
            VALUES ({$wf}, 3, 'Dispatcher demo', 'Routes a request to IT or HR', '[]', 'workflow')");

        $agent = static fn(string $name, string $type = 'standard'): array => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'deepseek', 'model' => '', 'tools' => [],
        ];
        $nodes = [
            1 => ['start', ['type' => 'start', 'prompt' => 'My laptop will not boot.']],
            2 => ['agent', $agent('techBuddy', 'dispatcher')],
            3 => ['agent', $agent('IT claims')],
            4 => ['agent', $agent('Human resources')],
            5 => ['output', ['type' => 'output']],
        ];
        $insNode = $db->prepare('INSERT INTO workflow_nodes (id, workflow_id, node_type, agent_id, config, drawflow_node_id)
            VALUES (?, ?, ?, NULL, ?, ?)');
        foreach ($nodes as $id => [$type, $config]) {
            $insNode->execute([$id, $wf, $type, json_encode($config), (string) $id]);
        }
        $insEdge = $db->prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)');
        foreach ([[1, 2], [2, 3], [2, 4], [3, 5], [4, 5]] as [$from, $to]) {
            $insEdge->execute([$wf, $from, $to]);
        }

        return $db;
    }

    /**
     * Construct a generator class (ADKGenerator, MAFGenerator, NOOAGenerator)
     * over the given PDO with the real repositories.
     *
     * @template T of object
     * @param class-string<T> $generatorClass
     * @return T
     */
    public static function generator(string $generatorClass, \PDO $db): object
    {
        return new $generatorClass(
            $db,
            new WorkflowRepository($db),
            new WorkflowGraphRepository($db),
            new AgentRepository($db)
        );
    }

    /** generatePackage() of the fixture workflow, as [path => code]. */
    public static function packageFiles(string $generatorClass): array
    {
        $pkg = self::generator($generatorClass, self::pdo())->generatePackage(self::WORKFLOW_ID);
        return array_column($pkg['files'], 'code', 'path');
    }
}
