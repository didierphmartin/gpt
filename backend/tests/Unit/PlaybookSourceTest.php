<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\PlaybookSource;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\PlaybookStoreTest;

final class PlaybookSourceTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        PlaybookStoreTest::schema($this->db);
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)");
    }

    private function robot(): int
    {
        $this->db->exec("INSERT INTO users (kind) VALUES ('service')");
        return (int) $this->db->lastInsertId();
    }

    private function pb(int $user, string $key, string $text): void
    {
        $this->db->prepare('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)')
            ->execute([$user, $key, $key, $text]);
    }

    public function testFromInputReadsThePublishedRobotCopy(): void
    {
        $r = $this->robot();
        $this->pb($r, 'test', 'T-published');
        $this->pb(7, 'test', 'T-draft');
        $this->assertSame(['ok' => true, 'key' => 'test', 'text' => 'T-published'],
            PlaybookSource::fromInput($this->db, 7, [], "## Get job\n{\"playbook\":\"test\",\"task\":\"x\"}"));
    }

    public function testFromInputUnpublishedDraft(): void
    {
        $this->robot();
        $this->pb(7, 'test', 'T-draft');
        $this->assertSame(['ok' => false, 'reason' => 'playbook_not_published:test'],
            PlaybookSource::fromInput($this->db, 7, [], '{"playbook":"test"}'));
    }

    public function testFromInputUnknownKey(): void
    {
        $this->robot();
        $this->assertSame(['ok' => false, 'reason' => 'playbook_not_found:nope'],
            PlaybookSource::fromInput($this->db, 7, [], '{"playbook":"nope"}'));
    }

    public function testFromInputBadInputFails(): void
    {
        $this->robot();
        foreach (['hello', '{"task":"x"}', '[1]', '{"playbook":5}'] as $t) {
            $this->assertSame(['ok' => false, 'reason' => 'bad_input'], PlaybookSource::fromInput($this->db, 7, [], $t), $t);
        }
    }

    public function testFromInputRejectsInvalidKey(): void
    {
        $this->robot();
        $this->assertSame(['ok' => false, 'reason' => 'bad_input'],
            PlaybookSource::fromInput($this->db, 7, [], '{"playbook":"../x"}'));
    }

    public function testFromInputWithoutRobotAccount(): void
    {
        $this->assertSame(['ok' => false, 'reason' => 'playbook_not_found:test'],
            PlaybookSource::fromInput($this->db, 7, [], '{"playbook":"test"}'));
        $this->pb(7, 'test', 'D');
        $this->assertSame(['ok' => false, 'reason' => 'playbook_not_published:test'],
            PlaybookSource::fromInput($this->db, 7, [], '{"playbook":"test"}'));
    }

    public function testCustomField(): void
    {
        $r = $this->robot();
        $this->pb($r, 'test', 'T');
        $this->assertTrue(PlaybookSource::fromInput($this->db, 7, ['playbook_input_field' => 'pb'], '{"pb":"test"}')['ok']);
    }

    public function testIsFromInput(): void
    {
        $this->assertTrue(PlaybookSource::isFromInput(['playbook_source' => 'input']));
        $this->assertFalse(PlaybookSource::isFromInput(['playbook_source' => 'fixed']));
        $this->assertFalse(PlaybookSource::isFromInput([]));
    }

    public function testJobLine(): void
    {
        $this->assertSame('Job: {"playbook":"a/b","task":"é"}', PlaybookSource::jobLine("## Get job\n{ \"playbook\": \"a/b\",\n \"task\": \"é\" }"));
        $this->assertSame('Job: {"task":"x"}', PlaybookSource::jobLine('{"task":"x"}'));
        $this->assertNull(PlaybookSource::jobLine('not json'));
        $this->assertNull(PlaybookSource::jobLine('[1,2]'));
        $this->assertNull(PlaybookSource::jobLine('"text"'));
        $this->assertNull(PlaybookSource::jobLine("## Get job\n"));
    }
}
