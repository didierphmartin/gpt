<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Controllers\AgentController;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\PlaybookStoreTest;

final class AgentPlaybookLinkTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,
            title TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, updated_at TEXT, UNIQUE (user_id, pkey))');
        $this->db->exec("CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER,
            category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER,
            can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT,
            playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT,
            created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))");
    }

    public function testAPlaybookAgentLinksAndKeepsNoText(): void
    {
        $pb = (new PlaybookStore($this->db))->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset');
        $c = new AgentController($this->db, []);
        $r = $c->create(['user_id' => 3, 'body' => ['name' => 'Okta agent', 'agent_type' => 'playbook', 'playbook_id' => $pb['id']]]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame($pb['id'], (int) $r['data']['playbook_id']);
        $this->assertSame('', (string) $r['data']['instructions']);
    }

    public function testAnUnknownPlaybookIsRefused(): void
    {
        $c = new AgentController($this->db, []);
        $r = $c->create(['user_id' => 3, 'body' => ['name' => 'X', 'agent_type' => 'playbook', 'playbook_id' => 99]]);
        $this->assertSame(404, $r['status_code']);
        $this->assertSame('Playbook #99 not found', $r['error']);
    }
}
