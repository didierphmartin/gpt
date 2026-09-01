<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookAnalyzer;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/**
 * Registration-time playbook validation (spec T4).
 *
 * Parses the submitted playbook, resolves its action bindings against the
 * caller's available MCP tools and agents, and reports blocking errors
 * before any run is ever created.
 */
class PlaybookController
{
    private PDO $db;
    private array $config;

    /** @var (callable(?string):MCPToolsLoader)|null Injection seam for tests; production leaves this null. */
    private $loaderFactory;

    public function __construct(PDO $db, array $config, ?callable $loaderFactory = null)
    {
        $this->db = $db;
        $this->config = $config;
        $this->loaderFactory = $loaderFactory;
    }

    /**
     * POST /api/v1/playbooks/validate
     * body: { "playbook": object|string }
     */
    public function validate(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        if ($userId === null || $userId === '') {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401,
            ];
        }

        $body = $request['body'] ?? [];
        $playbook = $body['playbook'] ?? null;

        try {
            if (is_string($playbook)) {
                $doc = PlaybookDocument::fromConsoleText($playbook);
            } elseif (is_array($playbook)) {
                $doc = PlaybookDocument::fromArray($playbook);
            } else {
                throw new \InvalidArgumentException('Field "playbook" (object or string) is required.');
            }
        } catch (\InvalidArgumentException $e) {
            return [
                'valid' => false,
                'errors' => [$e->getMessage()],
                'status_code' => 422,
            ];
        }

        $loader = $this->makeLoader((string) $userId);
        $executor = new LoaderMcpExecutor($loader);
        $availableTools = array_keys($executor->availableTools());
        $availableAgents = $this->loadAgentNames($userId);

        $result = (new PlaybookAnalyzer())->analyze($doc, $availableTools, $availableAgents);
        $valid = $result['errors'] === [];

        return [
            'valid' => $valid,
            'actions' => $result['actions'],
            'gates' => $result['gates'],
            'checklist' => $result['checklist'],
            'errors' => $result['errors'],
            'warnings' => $result['warnings'],
            'status_code' => $valid ? 200 : 422,
        ];
    }

    private function makeLoader(string $userId): MCPToolsLoader
    {
        if ($this->loaderFactory !== null) {
            return ($this->loaderFactory)($userId);
        }
        $loader = new MCPToolsLoader($this->db);
        $loader->loadToolsForUser($userId);
        return $loader;
    }

    /** @return string[] */
    private function loadAgentNames(mixed $userId): array
    {
        $stmt = $this->db->prepare('SELECT name FROM agents WHERE user_id = ?');
        $stmt->execute([$userId]);
        return array_column($stmt->fetchAll(PDO::FETCH_ASSOC), 'name');
    }
}
