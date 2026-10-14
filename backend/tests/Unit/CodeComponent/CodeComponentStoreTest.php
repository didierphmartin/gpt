<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

final class CodeComponentStoreTest extends TestCase
{
    public const POLL = ['name' => 'Poll Inbox', 'description' => 'New mail in Inbox',
        'code' => "def run(input, call_tool):\n    return {'route': 'new_mail', 'output': 1}",
        'exits' => ['new_mail', 'no_mail', 'error'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 20];

    private PDO $db;
    private CodeComponentStore $store;

    public static function schema(PDO $db): void
    {
        $db->exec('CREATE TABLE code_components (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
            description TEXT, code TEXT NOT NULL, exits TEXT NOT NULL, mcp_servers TEXT NOT NULL, timeout_s INTEGER NOT NULL DEFAULT 30,
            created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))');
        $db->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)');
        $db->exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT, pos_x INTEGER, pos_y INTEGER, drawflow_node_id TEXT)');
    }

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        self::schema($this->db);
        $this->store = new CodeComponentStore($this->db);
    }

    private function error(callable $fn): CodeComponentError
    {
        try { $fn(); } catch (CodeComponentError $e) { return $e; }
        $this->fail('expected CodeComponentError');
    }

    public function testSaveRoundTripsTypedFields(): void
    {
        $row = $this->store->save(3, null, self::POLL);
        $this->assertIsInt($row['id']);
        $this->assertSame(['new_mail', 'no_mail', 'error'], $row['exits']);
        $this->assertSame(['Outlook'], $row['mcp_servers']);
        $this->assertSame(20, $row['timeout_s']);
        $this->assertSame(self::POLL['code'], $this->store->get(3, $row['id'])['code']);
    }

    public function testCreateWithAnExistingNameUpdatesThatRow(): void
    {
        $a = $this->store->save(3, null, self::POLL);
        $b = $this->store->save(3, null, ['code' => 'def run(i, c):\n    return 2'] + self::POLL);
        $this->assertSame($a['id'], $b['id']);
        $this->assertSame(1, count($this->store->list(3)));
        $this->assertStringContainsString('return 2', $this->store->get(3, $a['id'])['code']);
    }

    public function testRenameOntoAnotherNameIsRefused(): void
    {
        $this->store->save(3, null, self::POLL);
        $other = $this->store->save(3, null, ['name' => 'Poll Support'] + self::POLL);
        $e = $this->error(fn() => $this->store->save(3, $other['id'], self::POLL));
        $this->assertSame('name_taken', $e->kind);
        $this->assertSame(409, $e->status);
    }

    public function testNamesAreScopedPerUser(): void
    {
        $mine = $this->store->save(3, null, self::POLL);
        $theirs = $this->store->save(4, null, self::POLL);
        $this->assertNotSame($mine['id'], $theirs['id']);
        $this->assertNull($this->store->get(3, $theirs['id']));
    }

    public function testValidation(): void
    {
        foreach ([
            ['name' => '  '] + self::POLL,
            ['exits' => []] + self::POLL,
            ['exits' => ['Bad-Exit']] + self::POLL,
            ['exits' => ['a', 'a']] + self::POLL,
            ['exits' => array_map(fn($i) => "e$i", range(1, 9))] + self::POLL,
            ['timeout_s' => 0] + self::POLL,
            ['timeout_s' => 301] + self::POLL,
            ['mcp_servers' => 'Outlook'] + self::POLL,
        ] as $bad) {
            $e = $this->error(fn() => $this->store->save(3, null, $bad));
            $this->assertSame('invalid', $e->kind, json_encode($bad));
            $this->assertSame(422, $e->status);
        }
        $row = $this->store->save(3, null, array_diff_key(self::POLL, ['timeout_s' => 1, 'description' => 1]));
        $this->assertSame(30, $row['timeout_s']);
        $this->assertSame('', $row['description']);
    }

    public function testUpdateUnknownIdIsNotFound(): void
    {
        $e = $this->error(fn() => $this->store->save(3, 99, self::POLL));
        $this->assertSame('not_found', $e->kind);
        $this->assertSame('Code component #99 not found', $e->getMessage());
    }

    public function testUsedByAndDeleteGuard(): void
    {
        $id = $this->store->save(3, null, self::POLL)['id'];
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Mail triage')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'code', '{\"name\":\"Poll\",\"code_component_id\":$id}')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'code', '{\"name\":\"Other\",\"code_component_id\":77}')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'agent', '{\"code_component_id\":$id}')");
        $this->assertSame([['workflow_id' => 1, 'workflow_name' => 'Mail triage', 'node_name' => 'Poll']], $this->store->usedBy(3, $id));
        $this->assertSame(1, $this->store->list(3)[0]['used_by']);
        $e = $this->error(fn() => $this->store->delete(3, $id));
        $this->assertSame('in_use', $e->kind);
        $this->assertStringContainsString('Mail triage', $e->getMessage());
        $this->db->exec('DELETE FROM workflow_nodes');
        $this->store->delete(3, $id);
        $this->assertNull($this->store->get(3, $id));
    }
}
