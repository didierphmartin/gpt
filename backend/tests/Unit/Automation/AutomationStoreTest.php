<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Automation;

use AgentTeam\Services\WorkflowRepository;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Automation\AutomationStore;
use Quantis\AIPortfolioAssistant\Automation\AutomationError;

final class AutomationStoreTest extends TestCase
{
    public const SPEC = ['name' => 'okta-reset', 'form' => ['variables' => [
        ['name' => 'user_email', 'mandatory' => true], ['name' => 'reason']]]];

    private PDO $db;
    private AutomationStore $store;

    public static function schema(PDO $db): void
    {
        $db->exec("CREATE TABLE automations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, automation_key TEXT NOT NULL,
            title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, spec_json TEXT NOT NULL, playbook_id INTEGER, workflow_id INTEGER,
            sn_scope TEXT, created_at TEXT, updated_at TEXT, UNIQUE (user_id, automation_key))");
        $db->exec("CREATE TABLE automation_instances (automation_id INTEGER NOT NULL, mcp_server_id INTEGER NOT NULL, installed_version INTEGER,
            sn_item_sys_id TEXT, last_check_at TEXT, status TEXT NOT NULL DEFAULT 'not_installed', detail TEXT, PRIMARY KEY (automation_id, mcp_server_id))");
        $db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER DEFAULT 1)');
        $db->exec('DROP TABLE IF EXISTS agent_workflows');
        $db->exec("CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER, name TEXT,
            description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, output_storage_enabled INTEGER DEFAULT 0,
            output_folder TEXT, orchestration TEXT DEFAULT 'workflow', created_at TEXT, updated_at TEXT, automation_id INTEGER)");
        $db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT, automation_id INTEGER)');
    }

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        self::schema($this->db);
        $this->store = new AutomationStore($this->db);
    }

    public function testCreateGivesVersionOneAndSameKeyBumpsKeepingTheId(): void
    {
        $a = $this->store->save(3, 'okta-reset', 'Okta', self::SPEC);
        $this->assertSame(1, $a['version']);
        $b = $this->store->save(3, 'okta-reset', 'Okta v2', self::SPEC + ['x' => 1]);
        $this->assertSame($a['id'], $b['id']);
        $this->assertSame(2, $b['version']);
        $this->assertSame('Okta v2', $b['title']);
        $this->assertSame(1, $this->store->get(3, $a['id'])['spec']['x']);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM automations')->fetchColumn());
    }

    public function testAnotherUsersKeyIsIndependent(): void
    {
        $a = $this->store->save(3, 'okta-reset', 'Okta', self::SPEC);
        $b = $this->store->save(4, 'okta-reset', 'Okta', self::SPEC);
        $this->assertNotSame($a['id'], $b['id']);
        $this->assertSame(1, $b['version']);
        $this->assertNull($this->store->get(4, $a['id']));
    }

    public function testBadKeyIsRejected(): void
    {
        foreach (['Okta', 'a', '-x', 'has space', str_repeat('a', 42), 'x_y'] as $k) {
            try { $this->store->save(3, $k, 'T', self::SPEC); $this->fail($k); } catch (AutomationError $e) { $this->assertSame(400, $e->status); }
        }
    }

    public function testLinkStampsAutomationIdAndRefusesForeignRows(): void
    {
        $a = $this->store->save(3, 'okta-reset', 'Okta', self::SPEC);
        $this->db->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'k', 't', 'x'), (4, 'k2', 't', 'x')");
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES (3, 'w')");
        $r = $this->store->link(3, $a['id'], 1, 1);
        $this->assertSame(1, $r['playbook_id']);
        $this->assertSame(1, $r['workflow_id']);
        $this->assertSame($a['id'], (int) $this->db->query('SELECT automation_id FROM playbooks WHERE id = 1')->fetchColumn());
        $this->assertSame($a['id'], (int) $this->db->query('SELECT automation_id FROM agent_workflows WHERE id = 1')->fetchColumn());
        try { $this->store->link(3, $a['id'], 2, null); $this->fail(); } catch (AutomationError $e) { $this->assertSame(404, $e->status); }
        $this->assertNull($this->db->query('SELECT automation_id FROM playbooks WHERE id = 2')->fetchColumn());
    }

    public function testWorkflowGetReturnsAutomationIdAfterLink(): void
    {
        $a = $this->store->save(3, 'okta-reset', 'Okta', self::SPEC);
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES (3, 'w')");
        $this->store->link(3, $a['id'], null, 1);
        $repo = new WorkflowRepository($this->db);
        $this->assertSame($a['id'], $repo->findById(1)->toArray()['automation_id']);
        $this->assertSame($a['id'], $repo->findById(1)->toApiArray()['automation_id']);
        $wf = $repo->findById(1);
        $repo->update($wf);   // a normal save must not clear the stamp
        $this->assertSame($a['id'], $repo->findById(1)->toArray()['automation_id']);
    }

    public function testReplaceSpecDoesNotBumpTheVersion(): void
    {
        $a = $this->store->save(3, 'okta-reset', 'Okta', self::SPEC);
        $this->store->replaceSpec(3, $a['id'], ['name' => 'okta-reset', 'changed' => true]);
        $row = $this->store->get(3, $a['id']);
        $this->assertSame(1, $row['version']);
        $this->assertTrue($row['spec']['changed']);
    }
}
