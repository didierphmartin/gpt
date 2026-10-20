<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Automation;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/** Production AutomationMcp: describe through the loader (like CodeNodeController), install by one JSON-RPC POST. */
final class LiveAutomationMcp implements AutomationMcp
{
    public function __construct(private readonly PDO $db) {}

    public function describe(int $userId, string $serverName, string $key): array
    {
        $loader = new MCPToolsLoader($this->db);
        $loader->loadToolsForUser((string) $userId);
        $slug = strtolower((string) preg_replace('/[^a-z0-9]+/i', '_', $serverName));
        return (new LoaderMcpExecutor($loader))->callRaw($slug, 'describe_item', ['key' => $key]);
    }

    public function install(string $url, array $headerLines, array $args, int $timeoutSeconds): array
    {
        $body = json_encode(['jsonrpc' => '2.0', 'id' => time(), 'method' => 'tools/call',
            'params' => ['name' => 'install_app', 'arguments' => $args]], JSON_UNESCAPED_SLASHES);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json', 'Accept: application/json, text/event-stream'], $headerLines),
            CURLOPT_TIMEOUT => $timeoutSeconds, CURLOPT_CONNECTTIMEOUT => 15,
        ]);
        $resp = curl_exec($ch);
        $http = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($resp === false || $err !== '') {
            return ['ok' => false, 'error' => 'unreachable'];
        }
        if ($http >= 400) {
            return ['ok' => false, 'error' => 'http_' . $http];
        }
        if (preg_match_all('/^data:\s?(.*)$/m', $resp, $m)) {
            $resp = (string) end($m[1]);
        }
        $rpc = json_decode($resp, true);
        if (!is_array($rpc)) {
            return ['ok' => false, 'error' => 'bad_answer'];
        }
        if (isset($rpc['error'])) {
            return ['ok' => false, 'error' => is_array($rpc['error']) ? (string) ($rpc['error']['message'] ?? 'rpc_error') : 'rpc_error'];
        }
        return ['ok' => true, 'result' => $rpc['result'] ?? []];
    }
}
