<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStoreError;

final class PlaybookStoreTest extends TestCase
{
    public const OKTA = "A note for colleagues: Okta prod tenant only.\n\nTitle: Okta password reset\nTrigger: A user is locked out.\nInstructions:\n1. #Search Okta Users with the email.\n2. #Reset Okta Password.\n\n(Ask Identity Team before changing step 2.)\nTools used: Okta\nActions used: #Search Okta Users; #Reset Okta Password\n";

    private PDO $db;
    private PlaybookStore $store;

    public static function schema(PDO $db): void
    {
        $db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,
            title TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, updated_at TEXT,
            published_by INTEGER NULL, published_at TEXT NULL, source_id INTEGER NULL, automation_id INTEGER NULL, UNIQUE (user_id, pkey))');
        $db->exec('CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
            agent_type TEXT DEFAULT "standard", instructions TEXT, playbook_id INTEGER)');
        $db->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)');
        $db->exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT)');
    }

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        self::schema($this->db);
        $this->store = new PlaybookStore($this->db);
    }

    private function error(callable $fn): PlaybookStoreError
    {
        try { $fn(); } catch (PlaybookStoreError $e) { return $e; }
        $this->fail('expected PlaybookStoreError');
    }

    public function testKeyFromTitleAndFormat(): void
    {
        $this->assertSame('reinitialisation', PlaybookStore::keyFromTitle('Réinitialisation'));
        $this->assertSame('ca-va', PlaybookStore::keyFromTitle('Ça va'));
        $this->assertFalse(PlaybookStore::isValidKey("okta-reset\n"));
        $this->assertSame('okta-password-reset', PlaybookStore::keyFromTitle('Okta password reset'));
        $this->assertSame('time-off-leave', PlaybookStore::keyFromTitle('  Time off & leave!! '));
        $this->assertSame('playbook', PlaybookStore::keyFromTitle('###'));
        $this->assertSame(64, strlen(PlaybookStore::keyFromTitle(str_repeat('abcd', 20))));
        $this->assertTrue(PlaybookStore::isValidKey('okta-reset'));
        foreach (['Okta', 'okta--reset', '-okta', 'okta_reset', '', str_repeat('a', 65)] as $bad) {
            $this->assertFalse(PlaybookStore::isValidKey($bad), $bad);
        }
    }

    public function testListShowsWhichAutomationManagesEachPlaybook(): void
    {
        // save_playbook_agent reads it on a key collision (ruling R11): unmanaged or this automation's -> update in place.
        $row = $this->store->save(3, null, self::OKTA, 'okta-reset');
        $this->assertNull($this->store->list(3)[0]['automation_id']);
        $this->db->prepare('UPDATE playbooks SET automation_id = 9 WHERE id = ?')->execute([$row['id']]);
        $this->assertSame(9, $this->store->list(3)[0]['automation_id']);
    }

    public function testSaveKeepsTheTextVerbatimAndCopiesTheTitle(): void
    {
        $row = $this->store->save(3, null, self::OKTA, null);
        $this->assertSame('okta-password-reset', $row['pkey']);
        $this->assertSame('Okta password reset', $row['title']);
        $this->assertSame(self::OKTA, $this->store->get(3, (int) $row['id'])['text']);
    }

    public function testATitleRenameNeverChangesTheKey(): void
    {
        $row = $this->store->save(3, null, self::OKTA, 'okta-reset');
        $renamed = str_replace('Title: Okta password reset', 'Title: Okta reset v2', self::OKTA);
        $again = $this->store->save(3, (int) $row['id'], $renamed, null);
        $this->assertSame('okta-reset', $again['pkey']);
        $this->assertSame('Okta reset v2', $again['title']);
    }

    public function testUnparsableTextIsRefused(): void
    {
        $e = $this->error(fn() => $this->store->save(3, null, "Trigger: x\n", null));
        $this->assertSame('invalid_text', $e->kind);
        $this->assertSame(422, $e->status);
        $this->assertStringContainsString('Title', $e->getMessage());
    }

    public function testKeysAreUniquePerUserOnly(): void
    {
        $this->store->save(3, null, self::OKTA, 'okta-reset');
        $e = $this->error(fn() => $this->store->save(3, null, self::OKTA, 'okta-reset'));
        $this->assertSame('key_taken', $e->kind);
        $this->assertSame(409, $e->status);
        $other = $this->store->save(4, null, self::OKTA, 'okta-reset');   // another user may use the same key
        $this->assertSame('okta-reset', $other['pkey']);
        $this->assertNull($this->store->get(3, (int) $other['id']));      // and it is invisible to user 3
        $this->assertSame(1, count($this->store->list(3)));
    }

    public function testAnInvalidKeyIsRefused(): void
    {
        $e = $this->error(fn() => $this->store->save(3, null, self::OKTA, 'Okta Reset'));
        $this->assertSame('invalid_key', $e->kind);
    }

    public function testGetByKeyAndNotFound(): void
    {
        $row = $this->store->save(3, null, self::OKTA, 'okta-reset');
        $this->assertSame((int) $row['id'], (int) $this->store->getByKey(3, 'okta-reset')['id']);
        $this->assertNull($this->store->getByKey(4, 'okta-reset'));
        $e = $this->error(fn() => $this->store->save(3, 999, self::OKTA, null));
        $this->assertSame('not_found', $e->kind);
        $this->assertSame('Playbook #999 not found', $e->getMessage());
    }

    public function testUsedByAndDeleteRefusedWhileInUse(): void
    {
        $id = (int) $this->store->save(3, null, self::OKTA, 'okta-reset')['id'];
        $this->db->exec("INSERT INTO agents (user_id, name, agent_type, playbook_id) VALUES (3, 'Okta agent', 'playbook', $id)");
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'ServiceNow bridge')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"name\":\"Reset\",\"playbook_id\":$id}')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"name\":\"Other\",\"playbook_id\":77}')");
        $used = $this->store->usedBy(3, $id);
        $this->assertSame([['id' => 1, 'name' => 'Okta agent']], $used['agents']);
        $this->assertSame([['workflow_id' => 1, 'workflow_name' => 'ServiceNow bridge', 'node_name' => 'Reset']], $used['nodes']);
        $this->assertSame(2, $this->store->list(3)[0]['used_by']);
        $e = $this->error(fn() => $this->store->delete(3, $id));
        $this->assertSame('in_use', $e->kind);
        $this->assertStringContainsString('Okta agent', $e->getMessage());
        $this->assertStringContainsString('ServiceNow bridge', $e->getMessage());
    }

    public function testDeleteAnUnusedPlaybook(): void
    {
        $id = (int) $this->store->save(3, null, self::OKTA, 'okta-reset')['id'];
        $this->store->delete(3, $id);
        $this->assertNull($this->store->get(3, $id));
    }

    public function testATitleLongerThan255IsRefused(): void
    {
        $long = str_replace('Title: Okta password reset', 'Title: ' . str_repeat('x', 256), self::OKTA);
        $e = $this->error(fn() => $this->store->save(3, null, $long, 'long'));
        $this->assertSame('invalid_text', $e->kind);
        $this->assertSame(422, $e->status);
        $this->assertStringContainsString('longer than 255', $e->getMessage());
        $ok = str_replace('Title: Okta password reset', 'Title: ' . str_repeat('é', 255), self::OKTA);
        $this->assertSame(255, mb_strlen($this->store->save(3, null, $ok, 'ok')['title']));
    }
}
