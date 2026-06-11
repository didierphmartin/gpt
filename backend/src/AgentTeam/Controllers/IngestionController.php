<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\IngestionCompiler;
use AgentTeam\Services\WorkflowRepository;
use PDO;

/**
 * Dedicated RAG ingestion endpoints — separate from the agent run/compile
 * controller (WorkflowController). Each chunk/script is compiled from the
 * node configs the FRONTEND sends, NOT from the saved graph. The real
 * separation lives in IngestionCompiler; this controller only auth-gates and
 * relays.
 *
 * Constructor signature matches every other AgentTeam controller so the
 * front-controller dispatcher (backend/index.php: `new $controllerClass($pdo,
 * $config)`) instantiates it the same way.
 */
final class IngestionController
{
    private PDO $db;
    private array $config;
    private WorkflowRepository $workflowRepository;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->workflowRepository = new WorkflowRepository($db);
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/node-code
     * Compile the Python chunk for a SINGLE node from the config the frontend
     * sends. Body: { node_type: string, config: object }.
     */
    public function nodeCode(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $nodeType = $body['node_type'] ?? 'loader';
        $config = $body['config'] ?? [];

        try {
            $code = IngestionCompiler::compileNodeChunk((string) $nodeType, (array) $config);
            return [
                'success'     => true,
                'data'        => ['node' => $nodeType, 'code' => $code],
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/compile
     * Compile the full runnable standalone script from the three node configs
     * the frontend sends. Body: { loader: object, splitter: object,
     * vectorstore: object }. Best-effort writes it under langchain_runner/.
     */
    public function compile(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $loader = (array) ($body['loader'] ?? []);
        $splitter = (array) ($body['splitter'] ?? []);
        $store = (array) ($body['vectorstore'] ?? []);

        try {
            $r = IngestionCompiler::compileScript($loader, $splitter, $store);

            $path = dirname(__DIR__, 4) . '/langchain_runner/' . basename($r['filename']);
            $written = @file_put_contents($path, $r['code']);

            return [
                'success' => true,
                'data'    => [
                    'filename' => $r['filename'],
                    'path'     => $written !== false ? $path : null,
                    'written'  => $written !== false,
                    'code'     => $r['code'],
                ],
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
    }
}
