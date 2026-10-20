<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Runs one code node server-side: backend/scripts/code_node_run.py in a short-lived python3 process,
 * the same harness the editor and compiled LangGraph use. The node reaches the user's MCP servers it
 * checked, with their stored headers. Switched off with CODE_NODES_SERVER_SIDE=0.
 */
final class CodeNodeExecutor
{
    private const RUNNER = __DIR__ . '/../../../scripts/code_node_run.py'; // src/AgentTeam/Services -> backend/scripts
    private const HARNESS_DIR = __DIR__ . '/../../../../frontend/assets/py';
    /** Extra seconds beyond the node's own timeout before the process is killed. */
    private const KILL_GRACE_S = 5;

    public function __construct(private \PDO $db, private array $config)
    {
    }

    public static function enabled(array $config): bool
    {
        return (bool) ($config['code_nodes']['server_side'] ?? true);
    }

    public function run(array $node, array $edges, array $nodeIds, string $userId, array $parents, string $userPrompt): array
    {
        $servers = $this->servers($userId);
        $slugToUrl = [];
        foreach ($servers as $slug => $s) {
            $slugToUrl[$slug] = $s['url'];
        }
        $data = CodeNodeEmit::nodeData($node, $edges, $slugToUrl, $nodeIds);
        $request = [
            'source' => $data['source'], 'exits' => $data['exits'], 'timeout_s' => $data['timeout_s'],
            'parents' => $parents, 'user_prompt' => $userPrompt, 'name' => $data['display'],
            'args' => (object) (is_array($cfgArgs = ($node['config'] ?? [])['args'] ?? null) ? $cfgArgs : []),
            'servers' => (object) array_intersect_key($servers, array_flip($data['mcp_servers'])),
        ];
        return ['data' => $data, 'result' => $this->spawn($request, $data['timeout_s'] + self::KILL_GRACE_S)];
    }

    /** slug => {url, headers}: enabled global servers plus the user's own; the user's row wins a name clash. */
    private function servers(string $userId): array
    {
        $stmt = $this->db->prepare('SELECT name, url, headers, user_id FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)');
        $stmt->execute([$userId]);
        $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);
        usort($rows, fn($a, $b) => ($b['user_id'] === null) <=> ($a['user_id'] === null)); // globals first, own overwrite
        $out = [];
        foreach ($rows as $r) {
            $headers = is_string($r['headers'] ?? null) ? (json_decode($r['headers'], true) ?: []) : [];
            $out[CodeNodeEmit::slug((string) $r['name'])] = ['url' => (string) $r['url'], 'headers' => (object) $headers];
        }
        return $out;
    }

    private function spawn(array $request, int $killAfterS): array
    {
        $python = (string) ($this->config['code_nodes']['python'] ?? 'python3');
        $runner = realpath(self::RUNNER);
        $harness = realpath(self::HARNESS_DIR);
        if ($runner === false || $harness === false) {
            throw new \RuntimeException('code node runner files are missing (scripts/code_node_run.py, frontend/assets/py)');
        }
        $cmd = [$python, $runner, $harness];
        $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) {
            throw new \RuntimeException("could not start {$python} for the code node");
        }
        // A child that died early closes the pipe: the warning is not an error here, the empty stdout below reports it.
        @fwrite($pipes[0], json_encode($request, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $stdout = $stderr = '';
        $deadline = microtime(true) + $killAfterS;
        while (true) {
            $stdout .= stream_get_contents($pipes[1]);
            $stderr .= stream_get_contents($pipes[2]);
            if (!proc_get_status($proc)['running']) {
                break;
            }
            if (microtime(true) > $deadline) {
                proc_terminate($proc, 9);
                fclose($pipes[1]);
                fclose($pipes[2]);
                proc_close($proc);
                return ['ok' => false, 'error' => "code node timed out after {$killAfterS}s (process killed)", 'stdout' => '', 'tool_calls' => []];
            }
            usleep(20000);
        }
        $stdout .= stream_get_contents($pipes[1]);
        $stderr .= stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);
        $result = json_decode($stdout, true);
        if (!is_array($result)) {
            return ['ok' => false, 'error' => 'code node runner failed: ' . (trim($stderr) ?: trim($stdout) ?: "exit code {$code}"),
                'stdout' => '', 'tool_calls' => []];
        }
        return $result;
    }
}
