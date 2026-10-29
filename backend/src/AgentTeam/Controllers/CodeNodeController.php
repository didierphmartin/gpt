<?php
declare(strict_types=1);

namespace AgentTeam\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\RobotOwnership;

/**
 * POST /api/v1/workflows/code-node/tool-call -- a code node's call_tool from the editor.
 *
 * Runs server.tool(args) with the logged-in user's MCP servers and returns the raw MCP result
 * (the harness needs structuredContent and isError). The declared-tools check is the harness's,
 * so it is identical when compiled; this endpoint gives the user no more than their own MCP access.
 * With the run's workflow_id, a robot workflow's call uses the robot's servers (RobotOwnership::runAs).
 */
final class CodeNodeController
{
    /** @var \Closure(int): \Closure(string, string, array): array */
    private \Closure $callerFor;
    private RobotOwnership $ownership;

    public function __construct(PDO $db, array $config, ?\Closure $callerFor = null)
    {
        $this->ownership = new RobotOwnership($db, $config);
        $this->callerFor = $callerFor ?? static function (int $userId) use ($db): \Closure {
            $loader = new MCPToolsLoader($db);
            $loader->loadToolsForUser((string) $userId);
            $executor = new LoaderMcpExecutor($loader);
            return static fn(string $server, string $tool, array $args): array => $executor->callRaw($server, $tool, $args);
        };
    }

    public function toolCall(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if ($userId <= 0) {
            return ['ok' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $body = is_array($request['body'] ?? null) ? $request['body'] : [];
        $server = $body['server'] ?? null;
        $tool = $body['tool'] ?? null;
        $args = $body['args'] ?? [];
        if (!is_string($server) || !preg_match('/^[a-z0-9_]{1,64}$/', $server)
            || !is_string($tool) || !preg_match('/^[A-Za-z0-9_.-]{1,128}$/', $tool) || !is_array($args)) {
            return ['ok' => false, 'error' => 'body must be {server: slug, tool: name, args: object}', 'status_code' => 400];
        }
        $workflowId = (int) ($body['workflow_id'] ?? 0);
        $actor = $workflowId > 0 ? $this->ownership->runAs($userId, $workflowId) : $userId;
        return (($this->callerFor)($actor))($server, $tool, $args);
    }
}
