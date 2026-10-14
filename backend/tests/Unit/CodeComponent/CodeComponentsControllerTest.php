<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\CodeComponentsController;

final class CodeComponentsControllerTest extends TestCase
{
    private CodeComponentsController $c;

    protected function setUp(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        CodeComponentStoreTest::schema($db);
        $this->c = new CodeComponentsController($db, []);
    }

    private function req(array $body = [], array $params = [], int $user = 3): array
    {
        return ['user_id' => $user, 'body' => $body, 'query' => [], 'params' => $params];
    }

    public function testCrudRoundTrip(): void
    {
        $r = $this->c->create($this->req(CodeComponentStoreTest::POLL));
        $this->assertTrue($r['success']);
        $id = $r['data']['id'];
        $this->assertSame('Poll Inbox', $this->c->show($this->req([], ['id' => $id]))['data']['name']);
        $this->assertSame(0, $this->c->index($this->req())['data'][0]['used_by']);
        $u = $this->c->update($this->req(['timeout_s' => 60] + CodeComponentStoreTest::POLL, ['id' => $id]));
        $this->assertSame(60, $u['data']['timeout_s']);
        $this->assertSame([], $this->c->usedBy($this->req([], ['id' => $id]))['data']);
        $this->assertTrue($this->c->destroy($this->req([], ['id' => $id]))['success']);
    }

    public function testErrorsCarryKindAndStatus(): void
    {
        $r = $this->c->show($this->req([], ['id' => 9]));
        $this->assertSame(['not_found', 404], [$r['kind'], $r['status_code']]);
        $r = $this->c->create($this->req(['exits' => []] + CodeComponentStoreTest::POLL));
        $this->assertSame(['invalid', 422], [$r['kind'], $r['status_code']]);
        $r = $this->c->index(['user_id' => 0, 'body' => [], 'query' => [], 'params' => []]);
        $this->assertSame(401, $r['status_code']);
    }

    public function testAnotherUsersComponentIsNotFound(): void
    {
        $id = $this->c->create($this->req(CodeComponentStoreTest::POLL, [], 4))['data']['id'];
        $this->assertSame(404, $this->c->show($this->req([], ['id' => $id]))['status_code']);
        $this->assertSame(404, $this->c->usedBy($this->req([], ['id' => $id]))['status_code']);
    }

    public function testStartOptionRoundTrip(): void
    {
        $id = $this->c->create($this->req(CodeComponentStoreTest::POLL))['data']['id'];
        $set = $this->c->setStartOption($this->req(CodeComponentStartOptionTest::TRIGGER, ['id' => $id]));
        $this->assertTrue($set['success']);
        $this->assertSame('New email', $set['data']['start_trigger']['label']);
        $this->assertSame([], $this->c->startOptionImpact($this->req([], ['id' => $id]))['data']);
        $del = $this->c->destroy($this->req([], ['id' => $id]));
        $this->assertSame(['is_option', 409], [$del['kind'], $del['status_code']]);
        $this->assertSame([], $this->c->clearStartOption($this->req([], ['id' => $id]))['data']);
        $this->assertTrue($this->c->destroy($this->req([], ['id' => $id]))['success']);
    }

    public function testABadStartOptionIs422(): void
    {
        $id = $this->c->create($this->req(CodeComponentStoreTest::POLL))['data']['id'];
        $r = $this->c->setStartOption($this->req(['work_exit' => 'job'] + CodeComponentStartOptionTest::TRIGGER, ['id' => $id]));
        $this->assertSame([false, 'invalid', 422], [$r['success'], $r['kind'], $r['status_code']]);
    }
}
