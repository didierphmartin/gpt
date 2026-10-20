<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Automation\AutomationError;
use Quantis\AIPortfolioAssistant\Automation\AutomationMcp;
use Quantis\AIPortfolioAssistant\Automation\AutomationStore;
use Quantis\AIPortfolioAssistant\Automation\LiveAutomationMcp;

/**
 * /api/v1/automations -- the automation record, its drift check against the owner's ServiceNow MCP servers, and the
 * dev/test install through the connector's deploy toolset. Owner-scoped on every route. Stored server headers are
 * sent to the deploy URL and never returned or logged.
 */
final class AutomationsController
{
    private const STAMP_VARIABLE = 'synergyai_automation';
    private const INSTALL_TIMEOUT_S = 900;

    private AutomationStore $store;
    private AutomationMcp $mcp;

    public function __construct(PDO $db, array $config, ?AutomationMcp $mcp = null)
    {
        $this->store = new AutomationStore($db);
        $this->mcp = $mcp ?? new LiveAutomationMcp($db);
    }

    public function index(array $request): array
    {
        return $this->guard($request, function (int $u) {
            $rows = $this->store->list($u);
            $servers = $this->store->servers($u);
            foreach ($rows as &$r) {
                $r['servers'] = $servers;
            }
            return ['success' => true, 'data' => $rows, 'status_code' => 200];
        });
    }

    public function create(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            $b = $this->body($request);
            if (!is_string($b['key'] ?? null) || !is_string($b['title'] ?? null) || !is_array($b['spec'] ?? null)) {
                throw new AutomationError('body must be {key, title, spec}');
            }
            $a = $this->store->save($u, $b['key'], $b['title'], $b['spec']);
            return ['success' => true, 'data' => $this->summary($u, $a), 'status_code' => 201];
        });
    }

    public function update(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            $id = (int) ($request['params']['id'] ?? 0);
            $b = $this->body($request);
            if ($this->store->get($u, $id) === null) {
                throw new AutomationError('automation not found', 404, 'not_found');
            }
            if (array_key_exists('spec', $b)) {
                if (!is_array($b['spec']) || $b['spec'] === []) {
                    throw new AutomationError('spec must be a non-empty object');
                }
                $this->store->replaceSpec($u, $id, $b['spec']);
            }
            $a = $this->store->link($u, $id, $this->optId($b, 'playbook_id'), $this->optId($b, 'workflow_id'));
            return ['success' => true, 'data' => $this->summary($u, $a), 'status_code' => 200];
        });
    }

    public function check(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            $a = $this->owned($u, $request);
            foreach ($this->store->servers($u) as $s) {
                $this->checkOne($u, $a, $s);
            }
            return ['success' => true, 'data' => ['instances' => $this->store->instances($a['id']), 'servers' => $this->store->servers($u)], 'status_code' => 200];
        });
    }

    public function install(array $request): array
    {
        return $this->guard($request, function (int $u) use ($request) {
            $a = $this->owned($u, $request);
            $b = $this->body($request);
            $serverId = (int) ($b['server_id'] ?? 0);
            $scope = $b['scope'] ?? null;
            $files = $b['files'] ?? null;
            if ($serverId <= 0 || !is_string($scope) || !preg_match('/^[A-Za-z0-9_]{1,100}$/', $scope)
                || !is_array($files) || $files === [] || array_filter($files, static fn($v, $k) => !is_string($k) || !is_string($v), ARRAY_FILTER_USE_BOTH)) {
                throw new AutomationError('body must be {server_id, scope, files: {path: text}}');
            }
            $server = $this->store->serverRow($u, $serverId);
            if ($server === null) {
                throw new AutomationError('server not found', 404, 'not_found');
            }
            $url = str_starts_with((string) $server['name'], 'ServiceNow') ? self::deployUrl((string) $server['url']) : null;
            if ($url === null) {
                throw new AutomationError('not a ServiceNow connector server URL (.../jobs)');
            }
            $r = $this->mcp->install($url, self::headerLines($server['headers'] ?? null), ['scope' => $scope, 'files' => $files], self::INSTALL_TIMEOUT_S);
            [$payload, $err] = self::payload($r);
            if ($err !== null) {
                $status = match ($err) { 'not_allowed' => 409, 'bad_argument' => 400, default => 502 };
                return ['success' => false, 'error' => $err, 'code' => $err, 'status_code' => $status];
            }
            $this->store->setScope($u, $a['id'], $scope);
            return ['success' => true, 'data' => $payload, 'status_code' => 200];
        });
    }

    /** The deploy URL for a connector server URL: the final /jobs (optionally followed by /mcp) becomes /deploy. */
    public static function deployUrl(string $serverUrl): ?string
    {
        $new = preg_replace('#/jobs(?:/mcp)?/?$#', '/deploy', $serverUrl, 1, $n);
        return $n === 1 ? $new : null;
    }

    private function checkOne(int $u, array $a, array $server): void
    {
        $r = $this->mcp->describe($u, $server['name'], $a['key']);
        [$payload, $err] = self::payload($r);
        if ($err !== null) {
            $this->store->saveInstance($a['id'], $server['id'], 'out_of_sync', null, null, null, 'cannot check: ' . $err);
            return;
        }
        $env = is_string($payload['environment'] ?? null) ? $payload['environment'] : null;
        $item = $payload['item'] ?? null;
        if (!is_array($item)) {
            $this->store->saveInstance($a['id'], $server['id'], 'not_installed', null, null, $env, '');
            return;
        }
        $version = isset($item['version']) && is_numeric($item['version']) ? (int) $item['version'] : null;
        $diffs = self::differences($a, $item, $version);
        $this->store->saveInstance($a['id'], $server['id'], $diffs === [] ? 'in_sync' : 'out_of_sync', $version,
            is_string($item['sys_id'] ?? null) ? $item['sys_id'] : null, $env, implode('; ', $diffs));
    }

    /** Variable names and mandatory flags (bool, default false; the stamp variable ignored), then the version. */
    private static function differences(array $a, array $item, ?int $version): array
    {
        $want = [];
        foreach (($a['spec']['form']['variables'] ?? []) as $v) {
            if (is_array($v) && is_string($v['name'] ?? null)) {
                $want[$v['name']] = ($v['mandatory'] ?? false) === true;
            }
        }
        $have = [];
        foreach (($item['variables'] ?? []) as $v) {
            if (is_array($v) && is_string($v['name'] ?? null) && $v['name'] !== self::STAMP_VARIABLE) {
                $have[$v['name']] = ($v['mandatory'] ?? false) === true;
            }
        }
        $d = [];
        foreach ($want as $n => $m) {
            if (!array_key_exists($n, $have)) {
                $d[] = "variable {$n} missing in ServiceNow";
            } elseif ($have[$n] !== $m) {
                $d[] = "variable {$n} mandatory is " . ($have[$n] ? 'true' : 'false') . " in ServiceNow, " . ($m ? 'true' : 'false') . ' in the spec';
            }
        }
        foreach ($have as $n => $_) {
            if (!array_key_exists($n, $want)) {
                $d[] = "variable {$n} exists in ServiceNow but not in the spec";
            }
        }
        if ($version === null) {
            $d[] = "version unknown in ServiceNow, spec is {$a['version']}";
        } elseif ($version !== $a['version']) {
            $d[] = "version {$version} in ServiceNow, spec is {$a['version']}";
        }
        return $d;
    }

    /** [payload, null] or [null, reason]: the structured payload of a callRaw answer, or the connector error code / transport reason. */
    private static function payload(array $r): array
    {
        if (empty($r['ok'])) {
            return [null, (string) ($r['error'] ?? 'unreachable')];
        }
        $res = is_array($r['result'] ?? null) ? $r['result'] : [];
        $p = is_array($res['structuredContent'] ?? null) ? $res['structuredContent']
            : json_decode((string) ($res['content'][0]['text'] ?? ''), true);
        $p = is_array($p) ? $p : [];
        if (!empty($res['isError']) || isset($p['error'])) {
            $e = $p['error'] ?? null;
            $code = is_array($e) ? ($e['code'] ?? null) : $e;
            return [null, is_string($code) && $code !== '' ? $code : 'tool_error'];
        }
        return [$p, null];
    }

    /** Stored headers JSON -> header lines (CR/LF/colon stripped from names, CR/LF from values). */
    private static function headerLines(?string $json): array
    {
        $h = is_string($json) ? json_decode($json, true) : null;
        $out = [];
        foreach (is_array($h) ? $h : [] as $k => $v) {
            if (is_string($k) && $k !== '' && is_scalar($v)) {
                $out[] = preg_replace('/[\r\n:]/', '', $k) . ': ' . preg_replace('/[\r\n]/', '', (string) $v);
            }
        }
        return $out;
    }

    private function summary(int $u, array $a): array
    {
        return ['id' => $a['id'], 'key' => $a['key'], 'version' => $a['version'], 'playbook_id' => $a['playbook_id'],
            'workflow_id' => $a['workflow_id'], 'servers' => $this->store->servers($u)];
    }

    private function owned(int $u, array $request): array
    {
        $a = $this->store->get($u, (int) ($request['params']['id'] ?? 0));
        if ($a === null) {
            throw new AutomationError('automation not found', 404, 'not_found');
        }
        return $a;
    }

    private function optId(array $b, string $k): ?int
    {
        if (!isset($b[$k])) {
            return null;
        }
        if (!is_int($b[$k]) || $b[$k] <= 0) {
            throw new AutomationError("{$k} must be a positive integer");
        }
        return $b[$k];
    }

    private function body(array $request): array
    {
        return is_array($request['body'] ?? null) ? $request['body'] : [];
    }

    private function guard(array $request, callable $fn): array
    {
        $u = (int) ($request['user_id'] ?? 0);
        if ($u <= 0) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        try {
            return $fn($u);
        } catch (AutomationError $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'code' => $e->errorCode, 'status_code' => $e->status];
        }
    }
}
