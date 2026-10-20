<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Automation;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Automation\AutomationMcp;
use Quantis\AIPortfolioAssistant\Controllers\AutomationsController;

final class FakeMcp implements AutomationMcp
{
    public array $describe = [];   // server name => callRaw-shaped answer
    public array $installCalls = [];
    public array $installAnswer = ['ok' => true, 'result' => ['structuredContent' => ['installed' => true, 'scope' => 'x_a']]];

    public function describe(int $userId, string $serverName, string $key): array
    {
        return $this->describe[$serverName] ?? ['ok' => false, 'error' => 'unreachable'];
    }

    public function install(string $url, array $headerLines, array $args, int $timeoutSeconds): array
    {
        $this->installCalls[] = compact('url', 'headerLines', 'args', 'timeoutSeconds');
        return $this->installAnswer;
    }
}

final class AutomationsControllerTest extends TestCase
{
    private PDO $db;
    private FakeMcp $mcp;
    private AutomationsController $ctl;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        AutomationStoreTest::schema($this->db);
        $this->db->exec("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES
            ('3', 'ServiceNow PDI', 'https://h/servicenow/pdi/jobs', '{\"Authorization\":\"Bearer SECRET\"}'),
            ('3', 'ServiceNow Prod', 'https://h/servicenow/prod/jobs/mcp', NULL),
            ('3', 'Outlook', 'https://h/outlook', NULL),
            ('4', 'ServiceNow Other', 'https://h/servicenow/o/jobs', NULL)");
        $this->mcp = new FakeMcp();
        $this->ctl = new AutomationsController($this->db, [], $this->mcp);
    }

    private function req(string $method, array $body = [], array $params = [], int $user = 3): array
    {
        return ['user_id' => $user, 'body' => $body, 'params' => $params];
    }

    private function create(int $user = 3): array
    {
        return $this->ctl->create($this->req('POST', ['key' => 'okta-reset', 'title' => 'Okta', 'spec' => AutomationStoreTest::SPEC], [], $user));
    }

    private static function ok(array $variables, ?int $version = 1, string $env = 'dev'): array
    {
        return ['ok' => true, 'result' => ['structuredContent' => ['environment' => $env,
            'item' => ['sys_id' => 'abc', 'name' => 'Okta', 'version' => $version, 'variables' => $variables]]]];
    }

    public function testCreateReturnsShapeAndServers(): void
    {
        $r = $this->create();
        $this->assertSame(201, $r['status_code']);
        $d = $r['data'];
        $this->assertSame(['id' => 1, 'key' => 'okta-reset', 'version' => 1, 'playbook_id' => null, 'workflow_id' => null], array_intersect_key($d, array_flip(['id', 'key', 'version', 'playbook_id', 'workflow_id'])));
        $this->assertSame([['id' => 1, 'name' => 'ServiceNow PDI', 'environment' => null], ['id' => 2, 'name' => 'ServiceNow Prod', 'environment' => null]], $d['servers']);
        $again = $this->create();
        $this->assertSame(2, $again['data']['version']);
        $this->assertSame(1, $again['data']['id']);
    }

    public function testCreateValidates(): void
    {
        $r = $this->ctl->create($this->req('POST', ['key' => 'Bad Key', 'title' => 'T', 'spec' => []]));
        $this->assertSame(400, $r['status_code']);
        $r = $this->ctl->create($this->req('POST', ['key' => 'okta-reset', 'title' => '', 'spec' => ['a' => 1]]));
        $this->assertSame(400, $r['status_code']);
        $this->assertSame(401, $this->ctl->create(['body' => []])['status_code']);
    }

    public function testUpdateLinksAndReplacesSpecWithoutBump(): void
    {
        $this->create();
        $this->db->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'k', 't', 'x')");
        $r = $this->ctl->update($this->req('PUT', ['playbook_id' => 1, 'spec' => ['name' => 'okta-reset', 'n' => 2]], ['id' => 1]));
        $this->assertSame(200, $r['status_code']);
        $this->assertSame(1, $r['data']['playbook_id']);
        $this->assertSame(1, $r['data']['version']);
        $this->assertArrayHasKey('servers', $r['data']);
        $this->assertSame(2, json_decode((string) $this->db->query('SELECT spec_json FROM automations')->fetchColumn(), true)['n']);
        $this->assertSame(404, $this->ctl->update($this->req('PUT', ['workflow_id' => 5], ['id' => 1]))['status_code']);
        $this->assertSame(404, $this->ctl->update($this->req('PUT', ['playbook_id' => 1], ['id' => 1], 4))['status_code']);
    }

    public function testCheckInSyncMissingVariableNotInstalledAndForbidden(): void
    {
        $this->create();
        $vars = [['name' => 'user_email', 'type' => '6', 'mandatory' => true], ['name' => 'reason', 'type' => '6', 'mandatory' => false]];
        $this->mcp->describe['ServiceNow PDI'] = self::ok($vars);
        $this->mcp->describe['ServiceNow Prod'] = ['ok' => true, 'result' => ['structuredContent' => ['environment' => 'prod', 'item' => null]]];
        $r = $this->ctl->check($this->req('POST', [], ['id' => 1]));
        $by = array_column($r['data']['instances'], null, 'mcp_server_id');
        $this->assertSame('in_sync', $by[1]['status']);
        $this->assertSame(1, $by[1]['installed_version']);
        $this->assertSame('abc', $by[1]['sn_item_sys_id']);
        $this->assertSame('dev', $by[1]['environment']);
        $this->assertSame('not_installed', $by[2]['status']);
        // servers now carry the environment from the latest check
        $this->assertSame('dev', $r['data']['servers'][0]['environment']);
        $this->assertSame('prod', $r['data']['servers'][1]['environment']);

        // drift: reason missing, mandatory flipped, older version
        $this->mcp->describe['ServiceNow PDI'] = self::ok([['name' => 'user_email', 'type' => '6', 'mandatory' => false], ['name' => 'extra', 'type' => '6', 'mandatory' => false]], 0);
        $r = $this->ctl->check($this->req('POST', [], ['id' => 1]));
        $by = array_column($r['data']['instances'], null, 'mcp_server_id');
        $this->assertSame('out_of_sync', $by[1]['status']);
        foreach (['reason', 'extra', 'user_email', 'version'] as $needle) {
            $this->assertStringContainsString($needle, $by[1]['detail']);
        }
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM automation_instances WHERE mcp_server_id = 1')->fetchColumn());

        $this->mcp->describe['ServiceNow PDI'] = ['ok' => true, 'result' => ['isError' => true, 'structuredContent' => ['error' => ['code' => 'forbidden', 'message' => 'no read']]]];
        unset($this->mcp->describe['ServiceNow Prod']);
        $r = $this->ctl->check($this->req('POST', [], ['id' => 1]));
        $by = array_column($r['data']['instances'], null, 'mcp_server_id');
        $this->assertSame('out_of_sync', $by[1]['status']);
        $this->assertSame('cannot check: forbidden', $by[1]['detail']);
        $this->assertSame('out_of_sync', $by[2]['status']);
        $this->assertSame('cannot check: unreachable', $by[2]['detail']);
    }

    public function testCheckReadsAGarbledDescribeAnswerAsBadAnswer(): void
    {
        $this->create();
        // no `item` key at all (or not an object): not a "not installed" answer, the check cannot conclude
        $this->mcp->describe['ServiceNow PDI'] = ['ok' => true, 'result' => ['structuredContent' => ['environment' => 'dev']]];
        $this->mcp->describe['ServiceNow Prod'] = ['ok' => true, 'result' => ['structuredContent' => ['environment' => 'prod', 'item' => 'abc']]];
        $r = $this->ctl->check($this->req('POST', [], ['id' => 1]));
        $by = array_column($r['data']['instances'], null, 'mcp_server_id');
        foreach ([1, 2] as $sid) {
            $this->assertSame('out_of_sync', $by[$sid]['status']);
            $this->assertSame('cannot check: bad_answer', $by[$sid]['detail']);
        }
    }

    public function testCheckIgnoresOtherUsersAndAutomations(): void
    {
        $this->create();
        $this->assertSame(404, $this->ctl->check($this->req('POST', [], ['id' => 1], 4))['status_code']);
    }

    public function testListIncludesInstancesAndServers(): void
    {
        $this->create();
        $this->mcp->describe['ServiceNow PDI'] = self::ok([]);
        $this->ctl->check($this->req('POST', [], ['id' => 1]));
        $r = $this->ctl->index($this->req('GET'));
        $this->assertCount(1, $r['data']);
        $this->assertCount(2, $r['data'][0]['instances']);
        $this->assertCount(2, $r['data'][0]['servers']);
        $this->assertSame([], $this->ctl->index($this->req('GET', [], [], 4))['data']);
    }

    public function testDeployUrlDerivation(): void
    {
        $this->assertSame('https://h/servicenow/pdi/deploy', AutomationsController::deployUrl('https://h/servicenow/pdi/jobs'));
        $this->assertSame('https://h/servicenow/pdi/deploy', AutomationsController::deployUrl('https://h/servicenow/pdi/jobs/mcp'));
        $this->assertSame('https://h/servicenow/pdi/deploy', AutomationsController::deployUrl('https://h/servicenow/pdi/jobs/'));
        $this->assertNull(AutomationsController::deployUrl('https://h/servicenow/pdi/other'));
    }

    public function testInstallSendsStoredHeadersAndNeverReturnsThem(): void
    {
        $this->create();
        $r = $this->ctl->install($this->req('POST', ['server_id' => 1, 'scope' => 'x_a', 'files' => ['package.json' => '{}']], ['id' => 1]));
        $this->assertSame(200, $r['status_code']);
        $call = $this->mcp->installCalls[0];
        $this->assertSame('https://h/servicenow/pdi/deploy', $call['url']);
        $this->assertContains('Authorization: Bearer SECRET', $call['headerLines']);
        $this->assertSame(900, $call['timeoutSeconds']);
        $this->assertSame(['scope' => 'x_a', 'files' => ['package.json' => '{}']], $call['args']);
        $this->assertStringNotContainsString('SECRET', json_encode($r));
        $this->assertSame('x_a', $this->db->query('SELECT sn_scope FROM automations')->fetchColumn());
    }

    public function testInstallErrorsMapToStatuses(): void
    {
        $this->create();
        $body = ['server_id' => 1, 'scope' => 'x_a', 'files' => ['a' => 'b']];
        $this->mcp->installAnswer = ['ok' => true, 'result' => ['isError' => true, 'structuredContent' => ['error' => ['code' => 'not_allowed', 'message' => 'prod']]]];
        $r = $this->ctl->install($this->req('POST', $body, ['id' => 1]));
        $this->assertSame(409, $r['status_code']);
        $this->assertSame('not_allowed', $r['code']);
        $this->mcp->installAnswer = ['ok' => false, 'error' => 'unreachable'];
        $this->assertSame(502, $this->ctl->install($this->req('POST', $body, ['id' => 1]))['status_code']);
        // a server of another user, a non-ServiceNow URL, a bad body
        $this->assertSame(404, $this->ctl->install($this->req('POST', ['server_id' => 4] + $body, ['id' => 1]))['status_code']);
        $this->assertSame(400, $this->ctl->install($this->req('POST', ['server_id' => 3] + $body, ['id' => 1]))['status_code']);
        $this->assertSame(400, $this->ctl->install($this->req('POST', ['files' => []] + $body, ['id' => 1]))['status_code']);
    }
}
