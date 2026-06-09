<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Models\WorkflowSchema;
use AgentTeam\Services\WorkflowSchemaRepository;
use PDO;

/**
 * Workflow Schema Controller
 *
 * REST endpoints for managing reusable JSON Schemas used by workflow
 * agent nodes for constrained decoding (structured outputs).
 */
class WorkflowSchemaController
{
    private PDO $db;
    private array $config;
    private WorkflowSchemaRepository $repository;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->repository = new WorkflowSchemaRepository($db);
    }

    /**
     * GET /api/v1/workflow-schemas
     */
    public function index(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        if (!$userId) {
            return $this->error('Authentication required', 401);
        }

        try {
            $schemas = $this->repository->findByUser($userId);
            return [
                'success' => true,
                'data' => array_map(fn($s) => $s->toApiArray(), $schemas),
                'count' => count($schemas),
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return $this->error($e->getMessage(), 500);
        }
    }

    /**
     * GET /api/v1/workflow-schemas/{id}
     */
    public function show(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        $id = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return $this->error('Authentication required', 401);
        }

        try {
            $schema = $this->repository->findById($id);
            if (!$schema || $schema->getUserId() !== $userId) {
                return $this->error('Schema not found', 404);
            }
            return [
                'success' => true,
                'data' => $schema->toApiArray(),
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return $this->error($e->getMessage(), 500);
        }
    }

    /**
     * POST /api/v1/workflow-schemas
     * Body: { name, description, schema_json, strict }
     */
    public function create(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return $this->error('Authentication required', 401);
        }

        try {
            $schema = new WorkflowSchema();
            $schema->setUserId($userId)
                   ->setName((string) ($body['name'] ?? ''))
                   ->setDescription((string) ($body['description'] ?? ''))
                   ->setSchemaJson(is_array($body['schema_json'] ?? null) ? $body['schema_json'] : [])
                   ->setStrict((bool) ($body['strict'] ?? true));

            $errors = $schema->validate();
            if (!empty($errors)) {
                return [
                    'success' => false,
                    'error' => 'Invalid schema',
                    'validation_errors' => $errors,
                    'status_code' => 400,
                ];
            }

            // Enforce unique name per user
            $existing = $this->repository->findByName($userId, $schema->getName());
            if ($existing) {
                return $this->error("A schema named '{$schema->getName()}' already exists", 409);
            }

            $created = $this->repository->create($schema);

            return [
                'success' => true,
                'data' => $created->toApiArray(),
                'message' => 'Schema created',
                'status_code' => 201,
            ];
        } catch (\Throwable $e) {
            return $this->error($e->getMessage(), 500);
        }
    }

    /**
     * PUT /api/v1/workflow-schemas/{id}
     */
    public function update(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        $id = (int) ($request['params']['id'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return $this->error('Authentication required', 401);
        }

        try {
            $schema = $this->repository->findById($id);
            if (!$schema || $schema->getUserId() !== $userId) {
                return $this->error('Schema not found', 404);
            }

            if (array_key_exists('name', $body))        $schema->setName((string) $body['name']);
            if (array_key_exists('description', $body)) $schema->setDescription((string) $body['description']);
            if (array_key_exists('schema_json', $body) && is_array($body['schema_json'])) {
                $schema->setSchemaJson($body['schema_json']);
            }
            if (array_key_exists('strict', $body))      $schema->setStrict((bool) $body['strict']);

            $errors = $schema->validate();
            if (!empty($errors)) {
                return [
                    'success' => false,
                    'error' => 'Invalid schema',
                    'validation_errors' => $errors,
                    'status_code' => 400,
                ];
            }

            // If renamed, check uniqueness
            $sameName = $this->repository->findByName($userId, $schema->getName());
            if ($sameName && $sameName->getId() !== $schema->getId()) {
                return $this->error("A schema named '{$schema->getName()}' already exists", 409);
            }

            $this->repository->update($schema);

            return [
                'success' => true,
                'data' => $schema->toApiArray(),
                'message' => 'Schema updated',
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return $this->error($e->getMessage(), 500);
        }
    }

    /**
     * DELETE /api/v1/workflow-schemas/{id}
     */
    public function destroy(array $request): array
    {
        $userId = (int) ($request['user_id'] ?? 0);
        $id = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return $this->error('Authentication required', 401);
        }

        try {
            $schema = $this->repository->findById($id);
            if (!$schema || $schema->getUserId() !== $userId) {
                return $this->error('Schema not found', 404);
            }
            $this->repository->delete($id, $userId);
            return [
                'success' => true,
                'message' => 'Schema deleted',
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return $this->error($e->getMessage(), 500);
        }
    }

    private function error(string $message, int $status): array
    {
        return [
            'success' => false,
            'error' => $message,
            'status_code' => $status,
        ];
    }
}
