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

    private function plainAgent(string $type = 'playbook', array $extra = []): int
    {
        $r = (new AgentController($this->db, []))->create(['user_id' => 3, 'body' => array_merge(['name' => 'A' . $type, 'agent_type' => $type], $extra)]);
        $this->assertTrue($r['success'], json_encode($r));
        return (int) $r['data']['id'];
    }

    private function update(int $id, array $body, int $user = 3): array
    {
        return (new AgentController($this->db, []))->update(['user_id' => $user, 'params' => ['id' => $id], 'agent_id' => $id, 'body' => $body]);
    }

    public function testUpdateLinksAndEmptiesInstructions(): void
    {
        $pb = (new PlaybookStore($this->db))->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset');
        $id = $this->plainAgent('playbook', ['instructions' => 'old text']);
        $r = $this->update($id, ['playbook_id' => $pb['id']]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame($pb['id'], (int) $r['data']['playbook_id']);
        $this->assertSame('', (string) $r['data']['instructions']);
    }

    public function testUpdateWithUnknownOrForeignPlaybookIs404(): void
    {
        $foreign = (new PlaybookStore($this->db))->save(9, null, PlaybookStoreTest::OKTA, 'okta-reset');
        $id = $this->plainAgent();
        foreach ([99, $foreign['id']] as $bad) {
            $r = $this->update($id, ['playbook_id' => $bad]);
            $this->assertSame(404, $r['status_code']);
            $this->assertSame("Playbook #{$bad} not found", $r['error']);
        }
    }

    public function testLinkedAgentKeepsInstructionsEmptyOnUpdate(): void
    {
        $pb = (new PlaybookStore($this->db))->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset');
        $id = $this->plainAgent('playbook', ['playbook_id' => $pb['id']]);
        $r = $this->update($id, ['instructions' => 'stale text']);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame('', (string) $r['data']['instructions']);
        $this->assertSame($pb['id'], (int) $r['data']['playbook_id']);
    }

    public function testStandardAgentStoresNoLink(): void
    {
        $pb = (new PlaybookStore($this->db))->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset');
        $r = (new AgentController($this->db, []))->create(['user_id' => 3, 'body' => ['name' => 'S', 'agent_type' => 'standard', 'playbook_id' => $pb['id']]]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertNull($r['data']['playbook_id']);
        $id = (int) $r['data']['id'];
        $u = $this->update($id, ['playbook_id' => $pb['id']]);
        $this->assertNull($u['data']['playbook_id']);
    }

    public function testDuplicatingToAnotherOwnerCopiesThePlaybookIntoTheirCollection(): void
    {
        $store = new PlaybookStore($this->db);
        $pb = $store->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset');
        $store->save(4, null, PlaybookStoreTest::OKTA, null); // user 4 already has key okta-password-reset
        $id = $this->plainAgent('playbook', ['playbook_id' => $pb['id']]);
        $repo = new \AgentTeam\Services\AgentRepository($this->db);

        $copy = $repo->duplicate($id, 4, 'Mine');
        $copied = $store->get(4, (int) $copy->getPlaybookId());
        $this->assertNotNull($copied, 'the copy links to a playbook its owner can read');
        $this->assertSame('okta-password-reset-2', $copied['pkey']);
        $this->assertSame(PlaybookStoreTest::OKTA, $copied['text']);

        $same = $repo->duplicate($id, 3, 'Again');
        $this->assertSame($pb['id'], $same->getPlaybookId());
        $this->assertSame(2, (int) $this->db->query('SELECT COUNT(*) FROM playbooks WHERE user_id = 4')->fetchColumn());
    }
}
