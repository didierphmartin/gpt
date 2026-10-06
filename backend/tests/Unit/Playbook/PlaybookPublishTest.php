<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStoreError;

final class PlaybookPublishTest extends TestCase
{
    private PDO $db;
    private PlaybookStore $store;
    private const ROBOT = 99;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        PlaybookStoreTest::schema($this->db);
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT)');
        $this->db->exec("INSERT INTO users VALUES (3, 'ann@x.test', 'Ann', 'Lee'), (4, 'bob@x.test', '', ''), (99, 'robot@synergyai.invalid', 'SynergyAI', 'Operations')");
        $this->store = new PlaybookStore($this->db);
    }

    private function error(callable $fn): PlaybookStoreError
    {
        try { $fn(); } catch (PlaybookStoreError $e) { return $e; }
        $this->fail('expected PlaybookStoreError');
    }

    public function testFirstPublishCopiesTextAndKeyAndStampsTheColumns(): void
    {
        $src = $this->store->save(3, null, PlaybookStoreTest::OKTA, null);
        $row = $this->store->publish(3, $src['id'], self::ROBOT, false);
        $this->assertSame($src['pkey'], $row['pkey']);
        $this->assertSame(PlaybookStoreTest::OKTA, $row['text']);
        $this->assertSame($src['id'], (int) $row['source_id']);
        $this->assertSame(3, (int) $row['published_by']);
        $this->assertNotEmpty($row['published_at']);
        $this->assertNull($this->store->getByKey(3, 'x'));
        $this->assertCount(1, $this->store->list(3));
        $this->assertSame([], $this->store->list(4));
    }

    public function testRepublishReplacesInPlaceAndStatusTracksChanges(): void
    {
        $src = $this->store->save(3, null, PlaybookStoreTest::OKTA, null);
        $first = $this->store->publish(3, $src['id'], self::ROBOT, false);
        $this->assertSame(['' . $src['id'] => 'published'], $this->keys($this->store->publishStatus(3, self::ROBOT)));
        $edited = str_replace('locked out', 'locked out of Okta', PlaybookStoreTest::OKTA);
        $this->store->save(3, $src['id'], $edited, null);
        $this->assertSame(PlaybookStoreTest::OKTA, $this->store->get(self::ROBOT, $first['id'])['text']);
        $this->assertSame(['' . $src['id'] => 'changed'], $this->keys($this->store->publishStatus(3, self::ROBOT)));
        $again = $this->store->publish(3, $src['id'], self::ROBOT, false);
        $this->assertSame($first['id'], $again['id']);
        $this->assertSame($edited, $again['text']);
        $this->assertSame(['' . $src['id'] => 'published'], $this->keys($this->store->publishStatus(3, self::ROBOT)));
    }

    private function keys(array $m): array
    {
        $out = [];
        foreach ($m as $k => $v) { $out['' . $k] = $v; }
        return $out;
    }

    public function testADifferentSourceNeedsConfirmation(): void
    {
        $a = $this->store->save(3, null, PlaybookStoreTest::OKTA, null);
        $b = $this->store->save(4, null, PlaybookStoreTest::OKTA, null);
        $first = $this->store->publish(3, $a['id'], self::ROBOT, false);
        $e = $this->error(fn() => $this->store->publish(4, $b['id'], self::ROBOT, false));
        $this->assertSame('replaces', $e->kind);
        $this->assertSame(409, $e->status);
        $this->assertSame('Ann Lee', $e->data['published_by']);
        $this->assertSame($first['published_at'], $e->data['published_at']);
        $row = $this->store->publish(4, $b['id'], self::ROBOT, true);
        $this->assertSame($first['id'], $row['id']);
        $this->assertSame($b['id'], (int) $row['source_id']);
        $this->assertSame(4, (int) $row['published_by']);
        // The new publisher is named by email when they have no name.
        $e = $this->error(fn() => $this->store->publish(3, $a['id'], self::ROBOT, false));
        $this->assertSame('bob@x.test', $e->data['published_by']);
    }

    public function testAKeyFromADeletedSourceNeedsConfirmation(): void
    {
        $a = $this->store->save(3, null, PlaybookStoreTest::OKTA, null);
        $this->store->publish(3, $a['id'], self::ROBOT, false);
        $this->store->delete(3, $a['id']);
        $b = $this->store->save(3, null, PlaybookStoreTest::OKTA, null);
        $e = $this->error(fn() => $this->store->publish(3, $b['id'], self::ROBOT, false));
        $this->assertSame('replaces', $e->kind);
        $this->assertSame('Ann Lee', $e->data['published_by']);
        $this->assertSame($b['id'], (int) $this->store->publish(3, $b['id'], self::ROBOT, true)['source_id']);
    }

    public function testUnpublishDeletesTheRobotRow(): void
    {
        $a = $this->store->save(3, null, PlaybookStoreTest::OKTA, null);
        $row = $this->store->publish(3, $a['id'], self::ROBOT, false);
        $list = $this->store->robotList(self::ROBOT);
        $this->assertSame('Ann Lee', $list[0]['published_by_name']);
        $this->assertSame('Okta password reset', $list[0]['source_title']);
        $this->store->unpublish(self::ROBOT, $row['id']);
        $this->assertSame([], $this->store->robotList(self::ROBOT));
        $this->assertNotNull($this->store->get(3, $a['id']));
        $this->assertSame(404, $this->error(fn() => $this->store->unpublish(self::ROBOT, $row['id']))->status);
    }

    public function testPublishingSomeoneElsesPlaybookIsNotFound(): void
    {
        $a = $this->store->save(3, null, PlaybookStoreTest::OKTA, null);
        $e = $this->error(fn() => $this->store->publish(4, $a['id'], self::ROBOT, false));
        $this->assertSame(404, $e->status);
        $this->assertSame("Playbook #{$a['id']} not found", $e->getMessage());
    }
}
