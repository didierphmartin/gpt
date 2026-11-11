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
            orchestration TEXT DEFAULT 'workflow', mlflow_tracing INTEGER DEFAULT 0)");
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
    public static function generator(string $generatorClass, \PDO $db, string|\Closure|null $skillsRoot = null): object
    {
        return new $generatorClass(
            $db,
            new WorkflowRepository($db),
            new WorkflowGraphRepository($db),
            new AgentRepository($db),
            $skillsRoot
        );
    }

    /** The fixture with "IT claims" (node 3) bound to the skill $dir and, when given, "Human resources" (node 4) to $second. */
    public static function pdoWithSkill(string $dir = 'pdf-report', ?string $second = null): \PDO
    {
        $db = self::pdo();
        foreach ([3 => $dir, 4 => $second] as $node => $skill) {
            if ($skill === null) {
                continue;
            }
            $cfg = json_decode((string) $db->query("SELECT config FROM workflow_nodes WHERE id = $node")->fetchColumn(), true);
            $cfg['bound_skill'] = ['dir_name' => $skill];
            $db->prepare('UPDATE workflow_nodes SET config = ? WHERE id = ?')->execute([json_encode($cfg), $node]);
        }
        return $db;
    }

    /** @var list<string> the temp skill roots wheelSkillsRoot() made; removeTempRoots() deletes them */
    private static array $tempRoots = [];

    /**
     * A temp skills root holding pdf-report, whose libraries were bundled: .wheels/native/ (regular Python),
     * .wheels/pyodide/ (the browser's) and .wheels/wheels.json; and plain-skill, with no bundled libraries.
     * Call removeTempRoots() after the test.
     */
    public static function wheelSkillsRoot(): string
    {
        $root = sys_get_temp_dir() . '/wheelskills_' . bin2hex(random_bytes(4));
        self::$tempRoots[] = $root;
        mkdir("$root/pdf-report/.wheels/native", 0777, true);
        mkdir("$root/pdf-report/.wheels/pyodide", 0777, true);
        mkdir("$root/plain-skill", 0777, true);
        file_put_contents("$root/pdf-report/SKILL.md", "---\nname: pdf-report\ndependencies: [fpdf2]\n---\nRender a PDF.\n");
        file_put_contents("$root/pdf-report/run.py", "print('pdf')\n");
        file_put_contents("$root/pdf-report/.wheels/native/fpdf2-2.8.1-py3-none-any.whl", "PK\x03\x04\xffnative");
        file_put_contents("$root/pdf-report/.wheels/pyodide/fpdf2-2.8.1-py3-none-any.whl", "PK\x03\x04pyodide");
        file_put_contents("$root/pdf-report/.wheels/wheels.json", '{"format":1}');
        file_put_contents("$root/plain-skill/SKILL.md", "---\nname: plain-skill\ndependencies: [zz-plain-dep]\n---\nPlain.\n");
        return $root;
    }

    public static function removeTempRoots(): void
    {
        foreach (self::$tempRoots as $root) {
            exec('rm -rf ' . escapeshellarg($root));
        }
        self::$tempRoots = [];
    }

    /** The skill files (skills/...) of a package, sorted. */
    public static function skillPaths(array $files): array
    {
        $paths = array_values(array_filter(array_column($files, 'path'), fn($p) => str_starts_with($p, 'skills/')));
        sort($paths);
        return $paths;
    }

    /** generatePackage() of the fixture workflow, as [path => code]. */
    public static function packageFiles(string $generatorClass): array
    {
        $pkg = self::generator($generatorClass, self::pdo())->generatePackage(self::WORKFLOW_ID);
        return array_column($pkg['files'], 'code', 'path');
    }
}
