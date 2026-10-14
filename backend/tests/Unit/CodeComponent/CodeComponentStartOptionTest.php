<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/** spec 2026-10-13 start-trigger-options: a component as a Start option. */
final class CodeComponentStartOptionTest extends TestCase
{
    public const TRIGGER = ['label' => 'New email',
        'watch' => ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['args' => ['folder' => 'Inbox']]],
        'work_exit' => 'new_mail'];

    private PDO $db;
    private CodeComponentStore $store;
    private int $id;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        CodeComponentStoreTest::schema($this->db);
        $this->store = new CodeComponentStore($this->db);
        $this->id = $this->store->save(3, null, CodeComponentStoreTest::POLL)['id'];
    }

    private function error(callable $fn): CodeComponentError
    {
        try { $fn(); } catch (CodeComponentError $e) { return $e; }
        $this->fail('expected CodeComponentError');
    }

    public function testAComponentIsNotAnOptionByDefault(): void
    {
        $this->assertNull($this->store->get(3, $this->id)['start_trigger']);
    }

    public function testSetStartTriggerStoresTheNormalisedTrigger(): void
    {
        $row = $this->store->setStartTrigger(3, $this->id, ['label' => '  New email '] + self::TRIGGER);
        $this->assertSame('New email', $row['start_trigger']['label']);
        $this->assertSame('new_mail', $row['start_trigger']['work_exit']);
        $this->assertSame(['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['args' => ['folder' => 'Inbox']]],
            $this->store->watchFor(3, $this->id));
        $this->assertSame('New email', $this->store->list(3)[0]['start_trigger']['label']);
    }

    public function testABlankLabelBecomesTheComponentName(): void
    {
        $row = $this->store->setStartTrigger(3, $this->id, ['label' => ' '] + self::TRIGGER);
        $this->assertSame('Poll Inbox', $row['start_trigger']['label']);
    }

    public function testEmptyArgsStayAnObject(): void
    {
        $t = self::TRIGGER;
        $t['watch']['args'] = [];
        $this->store->setStartTrigger(3, $this->id, $t);
        $raw = $this->db->query('SELECT start_trigger FROM code_components')->fetchColumn();
        $this->assertStringContainsString('"args":{}', $raw);
    }

    /** @dataProvider badTriggers */
    public function testABadTriggerIsRefused(array $t, string $needle): void
    {
        $e = $this->error(fn() => $this->store->setStartTrigger(3, $this->id, $t));
        $this->assertSame('invalid', $e->kind);
        $this->assertSame(422, $e->status);
        $this->assertStringContainsString($needle, $e->getMessage());
    }

    public static function badTriggers(): array
    {
        $t = self::TRIGGER;
        return [
            'server not among the component servers' => [['watch' => ['server' => 'Gmail'] + $t['watch']] + $t, 'Gmail'],
            'no tool' => [['watch' => ['tool' => ''] + $t['watch']] + $t, 'tool'],
            'args a list' => [['watch' => ['args' => [1, 2]] + $t['watch']] + $t, 'args'],
            'work exit not an exit' => [['work_exit' => 'job'] + $t, 'job'],
            'label too long' => [['label' => str_repeat('x', 61)] + $t, 'label'],
        ];
    }

    public function testAnotherUsersComponentIsNotFound(): void
    {
        $this->assertSame('not_found', $this->error(fn() => $this->store->setStartTrigger(4, $this->id, self::TRIGGER))->kind);
        $this->assertSame('not_found', $this->error(fn() => $this->store->watchFor(4, $this->id))->kind);
    }

    public function testWatchForRefusesAComponentThatIsNotAnOption(): void
    {
        $e = $this->error(fn() => $this->store->watchFor(3, $this->id));
        $this->assertSame('not_option', $e->kind);
        $this->assertSame(422, $e->status);
    }

    /** Review focus 1. */
    public function testAnEditThatDropsTheWorkExitIsRefused(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $e = $this->error(fn() => $this->store->save(3, $this->id, ['exits' => ['job', 'no_job']] + CodeComponentStoreTest::POLL));
        $this->assertSame('start_exit', $e->kind);
        $this->assertSame(422, $e->status);
        $this->assertStringContainsString('new_mail', $e->getMessage());
    }

    /** Review focus 1. */
    public function testAnEditThatDropsTheWatchedServerIsRefused(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $e = $this->error(fn() => $this->store->save(3, $this->id, ['mcp_servers' => []] + CodeComponentStoreTest::POLL));
        $this->assertSame('start_exit', $e->kind);
        $this->assertStringContainsString('Outlook', $e->getMessage());
    }

    public function testAnEditThatKeepsTheWorkExitIsSaved(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $row = $this->store->save(3, $this->id, ['timeout_s' => 90] + CodeComponentStoreTest::POLL);
        $this->assertSame(90, $row['timeout_s']);
        $this->assertSame('new_mail', $row['start_trigger']['work_exit']);
    }

    /** Workflow 64 uses the option (schedule row + linked node after Start); 65 has only an unrelated schedule. */
    private function seedTwoWorkflows(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (64, '3', 'email prototype'), (65, '3', 'AA test')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES
            (64, 'code', '{\"type\":\"code\",\"name\":\"Email processing\",\"code_component_id\":{$this->id}}')");
        $this->db->exec("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
            VALUES (3, 64, 'event', '{}', {$this->id}, 'pending'), (3, 65, 'cron', NULL, NULL, 'pending'),
                   (4, 99, 'event', '{}', {$this->id}, 'pending')");
    }

    public function testImpactNamesTheWorkflowsAndTheirNode(): void
    {
        $this->seedTwoWorkflows();
        $this->assertSame([['workflow_id' => 64, 'workflow_name' => 'email prototype', 'node_name' => 'Email processing']],
            $this->store->startTriggerImpact(3, $this->id));
    }

    public function testClearRemovesTheOptionAndOnlyItsScheduleRows(): void
    {
        $this->seedTwoWorkflows();
        $impact = $this->store->clearStartTrigger(3, $this->id);
        $this->assertSame([64], array_column($impact, 'workflow_id'));
        $this->assertNull($this->store->get(3, $this->id)['start_trigger']);
        $left = $this->db->query('SELECT user_id, workflow_id FROM scheduled_workflows ORDER BY workflow_id')->fetchAll();
        $this->assertSame([['user_id' => 3, 'workflow_id' => 65], ['user_id' => 4, 'workflow_id' => 99]], $left);
        // the graphs are not touched: the linked node stays (decision 6)
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM workflow_nodes')->fetchColumn());
    }

    /** Review focus 2. */
    public function testAnOptionCannotBeDeletedBeforeItIsRemoved(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $e = $this->error(fn() => $this->store->delete(3, $this->id));
        $this->assertSame('is_option', $e->kind);
        $this->assertSame(409, $e->status);
        $this->store->clearStartTrigger(3, $this->id);
        $this->store->delete(3, $this->id);
        $this->assertNull($this->store->get(3, $this->id));
    }

    public function testScheduleBodyFillsTheEventFromTheOption(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $b = $this->store->scheduleBody(3, ['workflow_id' => 64, 'repeat_type' => 'cron', 'cron' => '* * * * *',
            'trigger_component_id' => (string) $this->id]);
        $this->assertSame('event', $b['repeat_type']);
        $this->assertNull($b['cron']);
        $this->assertSame($this->id, $b['trigger_component_id']);
        $this->assertSame(self::TRIGGER['watch'], $b['event_trigger']);
    }

    public function testScheduleBodyLeavesOtherSchedulesAlone(): void
    {
        $body = ['workflow_id' => 64, 'repeat_type' => 'daily'];
        $this->assertSame($body, $this->store->scheduleBody(3, $body));
    }

    /** Review focus 3. */
    public function testScheduleBodyRefusesAForeignOrNonOptionComponent(): void
    {
        $this->assertSame('not_option', $this->error(fn() => $this->store->scheduleBody(3, ['trigger_component_id' => $this->id]))->kind);
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $this->assertSame('not_found', $this->error(fn() => $this->store->scheduleBody(4, ['trigger_component_id' => $this->id]))->kind);
    }

    /** Final review 4: editing the option's watch reaches the schedules already using it, and only those. */
    public function testEditingTheWatchUpdatesTheSchedulesUsingTheOption(): void
    {
        $this->seedTwoWorkflows();
        $other = $this->store->save(3, null, ['name' => 'Poll Archive'] + CodeComponentStoreTest::POLL)['id'];
        $this->db->exec("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
            VALUES (3, 66, 'event', '{}', {$other}, 'pending')");
        $t = self::TRIGGER;
        $t['watch']['args'] = ['args' => ['folder' => 'Archive']];
        $this->store->setStartTrigger(3, $this->id, $t);
        $rows = $this->db->query('SELECT user_id, workflow_id, event_trigger FROM scheduled_workflows ORDER BY workflow_id')->fetchAll();
        $by = array_column($rows, 'event_trigger', 'workflow_id');
        $this->assertSame('{"server":"Outlook","tool":"wait_for_new","args":{"args":{"folder":"Archive"}}}', $by[64]);
        $this->assertNull($by[65]);
        $this->assertSame('{}', $by[66]);   // another component's schedule
        $this->assertSame('{}', $by[99]);   // another user's schedule
    }
}
