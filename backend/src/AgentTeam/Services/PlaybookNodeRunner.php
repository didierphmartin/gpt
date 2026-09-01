<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\LoaderMcpExecutor;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\SkillBridgeGateBridge;
use Quantis\AIPortfolioAssistant\Playbook\Adapters\WorkflowLlmClient;
use Quantis\AIPortfolioAssistant\Playbook\GateManager;
use Quantis\AIPortfolioAssistant\Playbook\McpExecutorInterface;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookActionSpace;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookAnalyzer;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookInterpreter;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookNativeTools;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookRunState;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookTranscript;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/**
 * Server-side entry point for running one Playbook-bound workflow node:
 * parses the node's playbook document, wires up the Playbook library
 * (analyzer → run state → native tools → gates → action space →
 * interpreter) exactly the way PlaybookController::validate() wires the
 * analyzer/loader pair for registration-time validation, and runs a single
 * leg to completion.
 *
 * CONTROLLER RULING: every real collaborator (contexts PDO, MCP executor,
 * LLM closure, gate bridge) is built by an overridable factory closure so
 * PlaybookNodeRunnerTest can run entirely against fakes + an in-memory
 * SQLite PDO — never MySQL, never a live provider. Production call sites
 * (WorkflowController::runPlaybookNode) simply omit the factories and get
 * the real implementations below.
 */
final class PlaybookNodeRunner
{
    public function __construct(
        private readonly array $config,
        /** @var (\Closure(array):\Closure)|null fn(array $nodeConfig): callable LLM closure */
        private readonly ?\Closure $llmFactory = null,
        /** @var (\Closure(PDO,int):McpExecutorInterface)|null fn(PDO $pdo, int $userId): McpExecutorInterface */
        private readonly ?\Closure $mcpFactory = null,
        /** @var (\Closure(\Closure):\Quantis\AIPortfolioAssistant\Playbook\GateBridgeInterface)|null fn(\Closure $emit): GateBridgeInterface */
        private readonly ?\Closure $bridgeFactory = null,
        /** @var (\Closure():PDO)|null fn(): PDO — the contexts DB connection */
        private readonly ?\Closure $pdoFactory = null,
    ) {
    }

    /**
     * @return array{output:string, run_id:int, status:string}
     */
    public function run(int $userId, array $nodeConfig, string $requestText, \Closure $emit): array
    {
        $doc = $this->parseDocument($nodeConfig['playbook'] ?? null);

        $pdo = $this->pdoFactory !== null ? ($this->pdoFactory)() : $this->defaultPdo();
        $mcp = $this->mcpFactory !== null ? ($this->mcpFactory)($pdo, $userId) : $this->defaultMcp($pdo, $userId);

        // Bound agent.* targets have no real invocation path yet (see
        // PlaybookActionSpace's constructor comment), so there is no need to
        // resolve available agent names here — every agent.* binding is
        // treated as unbound regardless of what we pass.
        $analysis = (new PlaybookAnalyzer())->analyze($doc, array_keys($mcp->availableTools()), []);
        if (!empty($analysis['errors'])) {
            throw new \RuntimeException(
                'Playbook has unresolved bindings: ' . implode('; ', $analysis['errors'])
            );
        }

        $transcript = new PlaybookTranscript(WorkflowRunLog::defaultDir($this->config));
        $state = new PlaybookRunState($pdo, $transcript);

        $requester = ['id' => (string)$userId];
        $runId = $state->createRun($userId, $doc, $requester, []);

        $native = new PlaybookNativeTools($state);
        $bridge = $this->bridgeFactory !== null
            ? ($this->bridgeFactory)($emit)
            : new SkillBridgeGateBridge($emit);
        $gates = new GateManager($state, $bridge);

        $space = new PlaybookActionSpace($analysis['actions'], $native, $mcp, $state, $doc->policy, $gates);

        $llm = $this->llmFactory !== null
            ? ($this->llmFactory)($nodeConfig)
            : new WorkflowLlmClient($nodeConfig, $this->config, $pdo);

        $interpreter = new PlaybookInterpreter($space, $state, $transcript, $llm, 40, $emit);

        $result = $interpreter->runLeg($runId, 0, $doc, [], $requester, $requestText);

        $output = (string)($result['output'] ?? '') . "\n\n[playbook run {$runId}: {$result['status']}]";

        return ['output' => $output, 'run_id' => $runId, 'status' => (string)$result['status']];
    }

    private function parseDocument(mixed $playbook): PlaybookDocument
    {
        if (is_string($playbook)) {
            return PlaybookDocument::fromConsoleText($playbook);
        }
        if (is_array($playbook)) {
            return PlaybookDocument::fromArray($playbook);
        }
        throw new \RuntimeException('nodeConfig.playbook (object or string) is required.');
    }

    private function defaultPdo(): PDO
    {
        return SessionSearchService::connectFromConfig($this->config);
    }

    private function defaultMcp(PDO $pdo, int $userId): McpExecutorInterface
    {
        $loader = new MCPToolsLoader($pdo);
        $loader->loadToolsForUser((string)$userId);
        return new LoaderMcpExecutor($loader);
    }
}
