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

    public function testImpactNamesTheWorkflows(): void
    {
        $this->seedTwoWorkflows();
        $this->assertSame([['workflow_id' => 64, 'workflow_name' => 'email prototype']], $this->store->startTriggerImpact(3, $this->id));
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

    public function testScheduleBodyAddsOnlyTheStartTagToTheWatch(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (64, ?, ?)')->execute(['start',
            json_encode(['type' => 'start', 'start_option' => $this->id,
                'start_args' => ['tag' => 'okta-reset', 'version' => 2, 'hand_back_group' => 'g']])]);
        $b = $this->store->scheduleBody(3, ['workflow_id' => 64, 'trigger_component_id' => (string) $this->id]);
        $this->assertEquals(['args' => ['folder' => 'Inbox'], 'tag' => 'okta-reset'], $b['event_trigger']['args']);
        // the update path has no workflow_id in its body: the caller names it
        $b = $this->store->scheduleBody(3, ['trigger_component_id' => (string) $this->id], 64);
        $this->assertSame('okta-reset', $b['event_trigger']['args']['tag']);
        // another workflow, or a Start without a tag: the watch as stored
        $b = $this->store->scheduleBody(3, ['workflow_id' => 65, 'trigger_component_id' => (string) $this->id]);
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

    private function seedTaggedStart(int $wf, string $tag): void
    {
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')->execute([$wf, 'start',
            json_encode(['type' => 'start', 'start_option' => $this->id, 'start_args' => ['tag' => $tag]])]);
    }

    /** Review focus 1: editing the watch must not strip a tagged schedule's tag. */
    public function testEditingTheWatchKeepsEachSchedulesTag(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $this->seedTaggedStart(64, 'okta-reset');
        $this->db->exec("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
            VALUES (3, 64, 'event', '{}', {$this->id}, 'pending'), (3, 65, 'event', '{}', {$this->id}, 'pending')");
        $t = self::TRIGGER;
        $t['watch']['args'] = ['args' => ['folder' => 'Archive']];
        $this->store->setStartTrigger(3, $this->id, $t);
        $by = array_column($this->db->query('SELECT workflow_id, event_trigger FROM scheduled_workflows')->fetchAll(), 'event_trigger', 'workflow_id');
        $this->assertEquals(['args' => ['folder' => 'Archive'], 'tag' => 'okta-reset'], json_decode($by[64], true)['args']);
        $this->assertSame(['args' => ['folder' => 'Archive']], json_decode($by[65], true)['args']);
    }

    /** The workflow's Start tag beats a default tag in the component's own watch args. */
    public function testTheStartTagWinsOverTheComponentsOwnTag(): void
    {
        $t = self::TRIGGER;
        $t['watch']['args'] = ['tag' => 'default'];
        $this->store->setStartTrigger(3, $this->id, $t);
        $this->seedTaggedStart(64, 'okta-reset');
        $b = $this->store->scheduleBody(3, ['workflow_id' => 64, 'trigger_component_id' => (string) $this->id]);
        $this->assertSame('okta-reset', $b['event_trigger']['args']['tag']);
    }

    // ---------- spec 2026-10-22 §6.1: pass_args, named Start args reach the watch ----------

    private function seedStart(int $wf, array $startArgs): void
    {
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')->execute([$wf, 'start',
            json_encode(['type' => 'start', 'start_option' => $this->id, 'start_args' => $startArgs])]);
    }

    private function dropTrigger(): array
    {
        $t = self::TRIGGER;
        $t['watch']['args'] = ['poll' => 'poll_new_mail', 'folder' => 'To SharePoint'];
        return ['pass_args' => ['folder']] + $t;
    }

    public function testPassArgsReachTheEventRowWatch(): void
    {
        $this->store->setStartTrigger(3, $this->id, $this->dropTrigger());
        $this->assertSame(['folder'], $this->store->get(3, $this->id)['start_trigger']['pass_args']);
        $this->seedStart(64, ['folder' => 'Mail in', 'sharepoint_folder' => 'D']);
        $b = $this->store->scheduleBody(3, ['workflow_id' => 64, 'trigger_component_id' => (string) $this->id]);
        $this->assertSame(['poll' => 'poll_new_mail', 'folder' => 'Mail in'], $b['event_trigger']['args']);
        // the schedule already on the option gets it too when the option is edited
        $this->db->exec("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)
            VALUES (3, 64, 'event', '{}', {$this->id}, 'pending')");
        $this->store->setStartTrigger(3, $this->id, $this->dropTrigger());
        $row = $this->db->query('SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = 64')->fetchColumn();
        $this->assertSame(['poll' => 'poll_new_mail', 'folder' => 'Mail in'], json_decode($row, true)['args']);
    }

    public function testUndeclaredStartArgsStayOut(): void
    {
        $t = $this->dropTrigger();
        unset($t['pass_args']);
        $this->store->setStartTrigger(3, $this->id, $t);
        $this->assertSame([], $this->store->get(3, $this->id)['start_trigger']['pass_args']);   // absent = []
        $this->seedStart(64, ['folder' => 'Mail in', 'sharepoint_folder' => 'D']);
        $b = $this->store->scheduleBody(3, ['workflow_id' => 64, 'trigger_component_id' => (string) $this->id]);
        $this->assertSame(['poll' => 'poll_new_mail', 'folder' => 'To SharePoint'], $b['event_trigger']['args']);
    }

    public function testTagStillMergedWithoutPassArgs(): void
    {
        $this->store->setStartTrigger(3, $this->id, self::TRIGGER);
        $this->seedStart(64, ['tag' => 'okta-reset', 'folder' => 'Mail in']);
        $b = $this->store->scheduleBody(3, ['workflow_id' => 64, 'trigger_component_id' => (string) $this->id]);
        $this->assertEquals(['args' => ['folder' => 'Inbox'], 'tag' => 'okta-reset'], $b['event_trigger']['args']);
    }

    /** @dataProvider badPassArgs */
    public function testPassArgsValidation(mixed $passArgs): void
    {
        $e = $this->error(fn() => $this->store->setStartTrigger(3, $this->id, ['pass_args' => $passArgs] + self::TRIGGER));
        $this->assertSame('invalid', $e->kind);
        $this->assertSame(422, $e->status);
        $this->assertStringContainsString('pass_args', $e->getMessage());
    }

    public static function badPassArgs(): array
    {
        return [
            'starts with a digit' => [['9x']],
            'not a list' => [['a' => 'folder']],
            'a string' => ['folder'],
            'a number in it' => [[1]],
            'more than 20' => [array_map(fn($i) => "a{$i}", range(1, 21))],
        ];
    }
}
