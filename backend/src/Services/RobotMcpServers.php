<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Services;

use AgentTeam\Services\CodeNodeEmit;
use PDO;

/** A robot workflow's MCP calls go to the robot's servers, matched to the caller's by slug (servers have no slug column: the name's). */
final class RobotMcpServers
{
    /**
     * The caller's servers behind these requested tools (mcp_<tool>, as a node selects them) that the robot has
     * no enabled server for, by name. A null selection (every tool) names none.
     *
     * @return string[]
     */
    public static function missing(PDO $db, string $callerId, string $robotId, ?array $toolNames): array
    {
        $tools = array_values(array_unique(array_map(fn($t) => substr((string) $t, 4),
            array_filter($toolNames ?? [], fn($t) => str_starts_with((string) $t, 'mcp_')))));
        if ($tools === []) {
            return [];
        }
        $st = $db->prepare('SELECT DISTINCT s.name FROM mcp_server_tools t JOIN mcp_servers s ON s.id = t.server_id
            WHERE s.enabled = 1 AND (s.user_id IS NULL OR s.user_id = ?) AND t.tool_name IN (' . implode(',', array_fill(0, count($tools), '?')) . ')
            ORDER BY s.name');
        $st->execute([$callerId, ...$tools]);
        $needed = $st->fetchAll(PDO::FETCH_COLUMN);
        $st = $db->prepare('SELECT name FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)');
        $st->execute([$robotId]);
        $have = array_flip(array_map(fn($n) => CodeNodeEmit::slug((string) $n), $st->fetchAll(PDO::FETCH_COLUMN)));
        return array_values(array_filter($needed, fn($n) => !isset($have[CodeNodeEmit::slug((string) $n)])));
    }

    /** The 422 body naming the first missing server. */
    public static function missingResponse(string $server): array
    {
        return ['success' => false, 'error_code' => 'robot_server_missing', 'server' => $server,
            'error' => "The robot has no enabled \"{$server}\" MCP server. Add it to the robot's connections.", 'status_code' => 422];
    }
}
