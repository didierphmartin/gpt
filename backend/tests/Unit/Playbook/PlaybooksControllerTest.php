<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\PlaybooksController;

final class PlaybooksControllerTest extends TestCase
{
    private PlaybooksController $c;

    protected function setUp(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        PlaybookStoreTest::schema($db);
        $db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)');
        $db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $this->c = new PlaybooksController($db, []);
    }

    private function req(array $body = [], array $params = [], int $user = 3): array
    {
        return ['user_id' => $user, 'body' => $body, 'query' => [], 'params' => $params];
    }

    public function testCreateShowListRoundTripTheTextVerbatim(): void
    {
        $r = $this->c->create($this->req(['text' => PlaybookStoreTest::OKTA, 'pkey' => 'okta-reset']));
        $this->assertTrue($r['success']);
        $id = $r['data']['id'];
        $this->assertSame(PlaybookStoreTest::OKTA, $this->c->show($this->req([], ['id' => $id]))['data']['text']);
        $list = $this->c->index($this->req());
        $this->assertSame('okta-reset', $list['data'][0]['pkey']);
        $this->assertSame(0, $list['data'][0]['used_by']);
    }

    public function testErrorsCarryKindAndStatus(): void
    {
        $bad = $this->c->create($this->req(['text' => "Trigger: x\n"]));
        $this->assertSame(['success' => false, 'kind' => 'invalid_text'], array_intersect_key($bad, ['success' => 0, 'kind' => 0]));
        $this->assertSame(422, $bad['status_code']);
        $this->assertSame(404, $this->c->show($this->req([], ['id' => 42]))['status_code']);
        $this->assertSame('Playbook #42 not found', $this->c->show($this->req([], ['id' => 42]))['error']);
        $this->assertSame(401, $this->c->index(['user_id' => 0])['status_code']);
        $this->assertSame(400, $this->c->create($this->req(['text' => '']))['status_code']);
    }

    public function testUpdateUsedByAndDelete(): void
    {
        $id = $this->c->create($this->req(['text' => PlaybookStoreTest::OKTA]))['data']['id'];
        $u = $this->c->update($this->req(['text' => PlaybookStoreTest::OKTA, 'pkey' => 'okta-reset'], ['id' => $id]));
        $this->assertSame('okta-reset', $u['data']['pkey']);
        $this->assertSame(['agents' => [], 'nodes' => [], 'others' => 0], $this->c->usedBy($this->req([], ['id' => $id]))['data']);
        $this->assertTrue($this->c->destroy($this->req([], ['id' => $id]))['success']);
        $this->assertSame([], $this->c->index($this->req())['data']);
    }
}
