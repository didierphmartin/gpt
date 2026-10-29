<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PDO;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;
use Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker\EventWorkerSchema;

/** The robot tests' fixture: wf 75 of user 2 (Mail to PDF) with its code components, Start option and schedule row. */
final class RobotSchema
{
    public const POLL = ['name' => 'Poll Drop', 'code' => 'def run(input, call_tool): pass', 'exits' => ['new_mail', 'no_mail'],
        'mcp_servers' => ['Outlook'], 'timeout_s' => 20];
    public const PDF = ['name' => 'To PDF', 'code' => 'v1', 'exits' => ['done'], 'mcp_servers' => ['Converter']];
    public const SP = ['name' => 'Store SharePoint', 'code' => 'sp', 'exits' => ['done'], 'mcp_servers' => ['SharePoint', 'Outlook']];
    public const WF = 75;
    public const OWNER = 2;

    /**
     * EventWorkerSchema plus the users/packages the robot needs (RobotControllerTest's), an empty LLM settings
     * table (WorkflowController reads it), and wf 75 of user 2: Start on "Poll Drop" -> To PDF -> Store SharePoint -> Output,
     * with its event schedule row. Returns the owner's component ids by name.
     */
    public static function create(PDO $db): array
    {
        EventWorkerSchema::create($db, fn() => '2026-10-26 09:00:00');
        $db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,
            first_name TEXT, last_name TEXT, role TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0)");
        $db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}'), ('admin', 'Admin', 1, '{}'), ('ops', 'Ops', 0, '{\"use_robot\": true}')");
        $db->exec("INSERT INTO users (id, email, role) VALUES (1, 'u@x.test', 'user'), (2, 'o@x.test', 'ops'), (3, 'a@x.test', 'admin')");
        $db->exec('CREATE TABLE system_llm_settings (provider_key TEXT, enabled INTEGER)');

        $store = new CodeComponentStore($db);
        $ids = [];
        foreach ([self::POLL, self::PDF, self::SP] as $c) {
            $ids[$c['name']] = $store->save(self::OWNER, null, $c)['id'];
        }
        $store->setStartTrigger(self::OWNER, $ids['Poll Drop'],
            ['label' => 'New drop', 'watch' => EventWorkerSchema::WATCH, 'work_exit' => 'new_mail']);
        $db->prepare('INSERT INTO agent_workflows (id, user_id, name) VALUES (?, ?, ?)')->execute([self::WF, self::OWNER, 'Mail to PDF']);
        $node = function (string $type, array $cfg) use ($db): int {
            $db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
                ->execute([self::WF, $type, json_encode(['type' => $type] + $cfg)]);
            return (int) $db->lastInsertId();
        };
        $start = $node('start', ['start_option' => $ids['Poll Drop'], 'start_args' => ['tag' => 'vip']]);
        $pdf = $node('code', ['name' => 'PDF', 'code_component_id' => $ids['To PDF']]);
        $sp = $node('code', ['name' => 'SP', 'code_component_id' => $ids['Store SharePoint']]);
        $out = $node('output', []);
        $edge = $db->prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (?, ?, ?, ?)');
        $edge->execute([self::WF, $start, $pdf, 'output_1']);
        $edge->execute([self::WF, $pdf, $sp, 'output_1']);
        $edge->execute([self::WF, $sp, $out, 'output_1']);
        EventWorkerSchema::row($db, self::WF, self::OWNER, 'event', $ids['Poll Drop']);
        return $ids;
    }

    /** The agents and playbooks tables (unique per owner, as in MySQL) and workflow_nodes.agent_id. */
    public static function agentsAndPlaybooks(PDO $db): void
    {
        $db->exec('ALTER TABLE workflow_nodes ADD COLUMN agent_id INTEGER');
        $db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,
            title TEXT NOT NULL, text TEXT NOT NULL, automation_id INTEGER, created_at TEXT, updated_at TEXT, UNIQUE (user_id, pkey))');
        $db->exec("CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER,
            category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER,
            can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT,
            playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT,
            created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))");
    }
}
