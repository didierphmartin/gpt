<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use PDO;

/** The tables the event worker reads, in SQLite; NOW() comes from the test's clock. */
final class EventWorkerSchema
{
    public static function create(PDO $db, callable $now): void
    {
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $db->sqliteCreateFunction('NOW', $now, 0);
        $db->exec('PRAGMA foreign_keys = ON');
        $db->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, enabled INTEGER DEFAULT 1)');
        $db->exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, config TEXT)');
        $db->exec("CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, from_node_id INTEGER,
            to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1')");
        $db->exec('CREATE TABLE code_components (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, start_trigger TEXT)');
        $db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, url TEXT,
            headers TEXT, enabled INTEGER DEFAULT 1)');
        $db->exec("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workflow_id INTEGER,
            input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending', repeat_type TEXT DEFAULT 'none',
            repeat_interval INTEGER DEFAULT 1, cron TEXT, event_trigger TEXT, trigger_component_id INTEGER,
            last_run TEXT, next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)");
        $db->exec("CREATE TABLE active_workflows (user_id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL
            REFERENCES agent_workflows (id) ON DELETE CASCADE, mode TEXT NOT NULL, trigger_component_id INTEGER,
            activated_at TEXT NOT NULL, watch_state TEXT NOT NULL DEFAULT 'starting', watch_message TEXT, watch_checked_at TEXT)");
    }

    public const WATCH = ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['args' => ['folder' => 'Inbox']]];

    /** Workflow $id of user $user: Start (on option $option, or plain) linked to an Output unless $linked is false. */
    public static function workflow(PDO $db, int $id, int $user, ?int $option, bool $linked = true): void
    {
        $db->prepare('INSERT INTO agent_workflows (id, user_id, name) VALUES (?, ?, ?)')->execute([$id, $user, "wf $id"]);
        $cfg = json_encode(['type' => 'start'] + ($option ? ['start_option' => $option] : []));
        $db->prepare("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, 'start', ?)")->execute([$id, $cfg]);
        $start = (int) $db->lastInsertId();
        $db->prepare("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, 'output', '{}')")->execute([$id]);
        $out = (int) $db->lastInsertId();
        if ($linked) {
            $db->prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)')->execute([$id, $start, $out]);
        }
    }

    public static function option(PDO $db, int $id, int $user): void
    {
        $db->prepare('INSERT INTO code_components (id, user_id, name, start_trigger) VALUES (?, ?, ?, ?)')
            ->execute([$id, $user, "c $id", json_encode(['label' => 'New email', 'watch' => self::WATCH, 'work_exit' => 'new_mail'])]);
    }

    /** A saved schedule row; returns its id. */
    public static function row(PDO $db, int $wf, int $user, string $type, ?int $component = null, string $status = 'pending'): int
    {
        $db->prepare('INSERT INTO scheduled_workflows (user_id, workflow_id, status, repeat_type, event_trigger, trigger_component_id, next_run)
            VALUES (?, ?, ?, ?, ?, ?, ?)')->execute([$user, $wf, $status, $type,
            $type === 'event' ? json_encode(self::WATCH) : null, $component, $type === 'event' ? null : '2026-10-15 09:00:00']);
        return (int) $db->lastInsertId();
    }
}
