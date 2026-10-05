<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookMigration;

final class PlaybookMigrationTest extends TestCase
{
    private PDO $db;
    private int $badAgent;
    private int $firstAgent;

    private function text(string $title): string
    {
        return "Title: {$title}\nTrigger: When asked.\nInstructions:\n1. Do it.\n";
    }

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        PlaybookStoreTest::schema($this->db);

        $ins = $this->db->prepare("INSERT INTO agents (user_id, name, agent_type, instructions) VALUES (3, ?, 'playbook', ?)");
        $ins->execute(['A1', $this->text('Okta password reset')]);
        $this->firstAgent = (int) $this->db->lastInsertId();
        $ins->execute(['A2', $this->text('Okta password reset')]);
        $ins->execute(['Bad', "Trigger: x\nInstructions: y\n"]);
        $this->badAgent = (int) $this->db->lastInsertId();

        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'WF')");
        $node = $this->db->prepare("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', ?)");
        $node->execute([json_encode(['name' => 'N1', 'agent_id' => $this->firstAgent, 'playbook' => 'stale'])]);
        $node->execute([json_encode(['name' => 'N2', 'agent_id' => $this->firstAgent])]);
        $node->execute([json_encode(['name' => 'N3', 'playbook' => $this->text('Leave')])]);
        $node->execute([json_encode(['name' => 'N4', 'playbook' => [
            'title' => 'Json one', 'trigger' => ['kind' => 'request', 'description' => 'Asked'],
            'instructions' => '1. #Do It', 'tools_used' => ['X', 'Y'], 'actions_used' => ['#Do It'],
            'bindings' => ['#Do It' => 'x.y', '#Skip' => null],
        ]])]);
    }

    private function n(string $sql): int
    {
        return (int) $this->db->query($sql)->fetchColumn();
    }

    public function testDryRunReportsAndChangesNothing(): void
    {
        $report = (new PlaybookMigration($this->db))->run(false);
        $this->assertSame(0, $this->n('SELECT COUNT(*) FROM playbooks'));
        $this->assertSame(0, $this->n('SELECT COUNT(*) FROM agents WHERE playbook_id IS NOT NULL'));
        $this->assertSame(3, $this->n("SELECT COUNT(*) FROM agents WHERE instructions <> ''"));
        $this->assertSame(3, $this->n("SELECT COUNT(*) FROM workflow_nodes WHERE config LIKE '%\"playbook\"%'"));
        $this->assertCount(4, $report['created']);
        $this->assertSame(2, $report['agents_linked']);
        $this->assertSame(4, $report['nodes_linked']);
    }

    public function testWriteMovesEverythingIntoTheCollection(): void
    {
        $report = (new PlaybookMigration($this->db))->run(true);
        $this->assertSame(4, $this->n('SELECT COUNT(*) FROM playbooks'));
        $this->assertSame(['okta-password-reset', 'okta-password-reset-2', 'leave', 'json-one'],
            $this->db->query('SELECT pkey FROM playbooks ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));
        $this->assertSame([['title' => 'Okta password reset', 'pkey' => 'okta-password-reset-2']], $report['suffixed']);
        $this->assertSame([['title' => 'Json one', 'action' => '#Do It', 'tool' => 'x.y']], $report['dropped_bindings']);

        $a1 = $this->db->query("SELECT playbook_id, instructions FROM agents WHERE name = 'A1'")->fetch();
        $this->assertSame('', (string) $a1['instructions']);
        $cfgs = [];
        foreach ($this->db->query('SELECT config FROM workflow_nodes ORDER BY id')->fetchAll(PDO::FETCH_COLUMN) as $c) {
            $cfgs[] = json_decode($c, true);
        }
        $this->assertSame((int) $a1['playbook_id'], $cfgs[0]['playbook_id']);
        $this->assertSame($cfgs[0]['playbook_id'], $cfgs[1]['playbook_id']);
        foreach ($cfgs as $cfg) {
            $this->assertArrayNotHasKey('playbook', $cfg);
            $this->assertIsInt($cfg['playbook_id']);
        }
        $json = $this->db->query("SELECT text FROM playbooks WHERE pkey = 'json-one'")->fetchColumn();
        $this->assertStringContainsString("Title: Json one\nTrigger: Asked\nInstructions:\n1. #Do It\nTools used: X; Y\nActions used: #Do It", $json);

        $this->assertCount(1, $report['errors']);
        $this->assertStringContainsString('Title', $report['errors'][0]['error']);
        $bad = $this->db->query("SELECT playbook_id, instructions FROM agents WHERE id = {$this->badAgent}")->fetch();
        $this->assertNull($bad['playbook_id']);
        $this->assertSame("Trigger: x\nInstructions: y\n", $bad['instructions']);
        $this->assertSame(2, $report['agents_linked']);
        $this->assertSame(4, $report['nodes_linked']);
    }

    private function addNode(array $cfg): int
    {
        $this->db->prepare("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', ?)")->execute([json_encode($cfg)]);
        return (int) $this->db->lastInsertId();
    }

    private function cfg(int $id): array
    {
        return json_decode($this->db->query("SELECT config FROM workflow_nodes WHERE id = {$id}")->fetchColumn(), true);
    }

    public function testANodeNeverLinksToAnotherUsersAgent(): void
    {
        $this->db->exec("INSERT INTO agents (user_id, name, agent_type, instructions) VALUES (4, 'Other', 'playbook', 'Title: Theirs\nInstructions: x\n')");
        $other = (int) $this->db->lastInsertId();
        $own = $this->addNode(['name' => 'Own', 'agent_id' => $other, 'playbook' => $this->text('Mine')]);
        $none = $this->addNode(['name' => 'None', 'agent_id' => $other]);
        $report = (new PlaybookMigration($this->db))->run(true);
        $theirs = (int) $this->db->query("SELECT id FROM playbooks WHERE user_id = 4")->fetchColumn();
        $mine = $this->db->query("SELECT id, user_id FROM playbooks WHERE pkey = 'mine'")->fetch();
        $this->assertSame(3, (int) $mine['user_id']);
        $this->assertSame((int) $mine['id'], $this->cfg($own)['playbook_id']);
        $this->assertNotSame($theirs, $this->cfg($own)['playbook_id']);
        $this->assertArrayNotHasKey('playbook_id', $this->cfg($none));
        $this->assertContains("node #{$none} \"None\" in workflow \"WF\"", array_column($report['errors'], 'from'));
    }

    public function testANodeTakesThePlaybookOfAnAlreadyLinkedAgent(): void
    {
        $pb = (new \Quantis\AIPortfolioAssistant\Playbook\PlaybookStore($this->db))->save(3, null, $this->text('Linked'), null);
        $this->db->exec("INSERT INTO agents (user_id, name, agent_type, instructions, playbook_id) VALUES (3, 'L', 'playbook', '', {$pb['id']})");
        $agent = (int) $this->db->lastInsertId();
        $node = $this->addNode(['name' => 'L1', 'agent_id' => $agent, 'playbook' => $this->text('Linked')]);
        (new PlaybookMigration($this->db))->run(true);
        $this->assertSame($pb['id'], $this->cfg($node)['playbook_id']);
        $this->assertArrayNotHasKey('playbook', $this->cfg($node));
        $this->assertSame(1, $this->n("SELECT COUNT(*) FROM playbooks WHERE title = 'Linked'"));
    }

    public function testAFailureMidRunLeavesTheDatabaseUnchanged(): void
    {
        $snap = fn() => [
            $this->db->query('SELECT * FROM playbooks')->fetchAll(),
            $this->db->query('SELECT * FROM agents')->fetchAll(),
            $this->db->query('SELECT * FROM workflow_nodes')->fetchAll(),
        ];
        $before = $snap();
        $m = new class($this->db) extends PlaybookMigration {
            private int $seen = 0;
            protected function nodeLinked(int $nodeId): void
            {
                if (++$this->seen === 2) throw new \RuntimeException('boom');
            }
        };
        try {
            $m->run(true);
            $this->fail('expected the exception to propagate');
        } catch (\RuntimeException $e) {
            $this->assertSame('boom', $e->getMessage());
        }
        $this->assertSame($before, $snap());
        $this->assertFalse($this->db->inTransaction());
    }
}
