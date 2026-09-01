<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\{PlaybookDocument, PlaybookRunState, PlaybookTranscript};

class PlaybookRunStateTest extends TestCase
{
    private \PDO $pdo;
    private PlaybookRunState $state;
    private string $dir;

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

    private function doc(): PlaybookDocument
    {
        return PlaybookDocument::fromArray(['title' => 'T',
            'trigger' => ['kind' => 'request', 'description' => 'd'], 'instructions' => '#Resolve Request.']);
    }

    public function testCreateRunAndStatus(): void
    {
        $id = $this->state->createRun(1, $this->doc(), ['email' => 'low@test'], []);
        $this->assertSame('running', $this->state->getRun($id)['status']);
        $this->state->setStatus($id, 'resolved');
        $this->assertSame('resolved', $this->state->getRun($id)['status']);
    }

    public function testLedgerReplayGuard(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $this->state->ledgerAppend($id, 0, '#Reset Password (Okta)', 'okta.reset_password',
            ['user_id' => 'u1', 'send_email' => true], 'ok', 'done');
        $hit = $this->state->ledgerFindOk($id, 'okta.reset_password', ['user_id' => 'u1', 'send_email' => true]);
        $this->assertNotNull($hit);
        $this->assertNull($this->state->ledgerFindOk($id, 'okta.reset_password', ['user_id' => 'OTHER']));
        $this->assertNull($this->state->ledgerFindOk($id + 1, 'okta.reset_password', ['user_id' => 'u1', 'send_email' => true]));
    }

    public function testSensitiveRedaction(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $this->state->ledgerAppend($id, 0, '#Get Key', 'okta.get_key', ['secret' => 'ABC'], 'ok', 'key=ABC', true);
        $row = $this->state->ledgerAll($id)[0];
        $this->assertSame('"«redacted»"', $row['args']);
        $this->assertSame('«redacted»', $row['result_summary']);
    }

    public function testTranscriptRoundTrip(): void
    {
        $id = $this->state->createRun(1, $this->doc(), [], []);
        $t = new PlaybookTranscript($this->dir);
        $t->append($id, ['type' => 'leg_started', 'leg' => 0]);
        $t->append($id, ['type' => 'tool_call', 'tool' => 'okta.search_users']);
        $events = $t->read($id);
        $this->assertCount(2, $events);
        $this->assertSame('leg_started', $events[0]['type']);
        $this->assertArrayHasKey('ts', $events[0]);
    }
}
