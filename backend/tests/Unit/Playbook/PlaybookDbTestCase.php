<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookRunState;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookTranscript;

abstract class PlaybookDbTestCase extends TestCase
{
    protected \PDO $pdo;
    protected PlaybookRunState $state;
    protected string $dir;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec("CREATE TABLE playbook_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, playbook_title TEXT,
            document TEXT, status TEXT DEFAULT 'pending', requester TEXT, variables TEXT, pending_gate TEXT,
            current_leg INT DEFAULT 0, coverage TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            direction TEXT, audience TEXT, text TEXT, sensitive INT DEFAULT 0, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
            author TEXT DEFAULT 'agent', text TEXT, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            seq INT, action_name TEXT, tool TEXT, args TEXT, outcome TEXT, result_summary TEXT, returned_ids TEXT,
            sensitive INT DEFAULT 0, duration_ms INT, created_at TEXT)");
        $this->pdo->exec("CREATE TABLE playbook_run_gates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
            kind TEXT, args TEXT, asked_of TEXT, opened_at TEXT, closed_at TEXT, decision TEXT, actor TEXT)");
        $this->dir = sys_get_temp_dir() . '/pbtest-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->state = new PlaybookRunState($this->pdo, new PlaybookTranscript($this->dir));
    }
}
