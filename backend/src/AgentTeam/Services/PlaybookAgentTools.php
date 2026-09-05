<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookAnalyzer;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/**
 * A playbook agent's `tools` selection = the MCP tools its #Actions bind to,
 * named the way the runtime and the agent form name them (mcp_<tool>). Kept
 * in step on every save so the form's checkboxes show what the playbook
 * needs. Native verbs and unbound actions contribute nothing.
 */
final class PlaybookAgentTools
{
    /** @param string[] $availableTools "server.tool" ids @return string[] mcp_<tool> names, unique, prose order */
    public static function fromPlaybookText(string $text, array $availableTools): array
    {
        try {
            $doc = PlaybookDocument::fromConsoleText($text);
        } catch (\Throwable) {
            return [];
        }
        $analysis = (new PlaybookAnalyzer())->analyze($doc, $availableTools, []);
        $out = [];
        foreach ($analysis['actions'] as $a) {
            if (($a['kind'] ?? '') !== 'bound') continue;
            $target = (string)($a['target'] ?? '');
            $dot = strpos($target, '.');
            if ($dot === false) continue; // agent.* bindings have no MCP tool
            $name = 'mcp_' . substr($target, $dot + 1);
            if (!in_array($name, $out, true)) $out[] = $name;
        }
        return $out;
    }

    /** Same, against the user's live MCP registry. Never throws (returns [] on any failure). */
    public static function forUser(PDO $db, string $userId, string $text): array
    {
        try {
            $loader = new MCPToolsLoader($db);
            $loader->loadToolsForUser($userId);
            return self::fromPlaybookText($text, array_keys((new LoaderMcpExecutor($loader))->availableTools()));
        } catch (\Throwable $e) {
            error_log('[PlaybookAgentTools] registry unavailable: ' . $e->getMessage());
            return [];
        }
    }
}
