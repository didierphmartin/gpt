<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;

/**
 * Context Controller
 *
 * Manages CRUD operations for conversation contexts.
 */
class ContextController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * List all contexts for the authenticated user
     */
    public function list(array $request): array
    {
        $userId = $request['user_id'];

        $stmt = $this->db->prepare('
            SELECT
                id,
                title,
                provider,
                message_count,
                created_at,
                updated_at
            FROM conversation_contexts
            WHERE user_id = ?
            ORDER BY updated_at DESC
        ');
        $stmt->execute([$userId]);
        $contexts = $stmt->fetchAll();

        return [
            'success' => true,
            'data' => $contexts,
            'status_code' => 200
        ];
    }

    /**
     * Get a specific context by ID
     */
    public function get(array $request, int $id): array
    {
        $userId = $request['user_id'];

        $stmt = $this->db->prepare('
            SELECT
                id,
                title,
                context_data,
                provider,
                message_count,
                created_at,
                updated_at
            FROM conversation_contexts
            WHERE id = ? AND user_id = ?
        ');
        $stmt->execute([$id, $userId]);
        $context = $stmt->fetch();

        if (!$context) {
            return [
                'success' => false,
                'message' => 'Context not found',
                'status_code' => 404
            ];
        }

        // Decode JSON data
        $context['context_data'] = json_decode($context['context_data'], true);

        return [
            'success' => true,
            'data' => $context,
            'status_code' => 200
        ];
    }

    /**
     * Create a new context or update existing
     */
    public function create(array $request): array
    {
        $userId = $request['user_id'];
        $input = $request['body'];

        // Validate required fields
        if (empty($input['messages']) || !is_array($input['messages'])) {
            return [
                'success' => false,
                'message' => 'Messages array is required',
                'status_code' => 400
            ];
        }

        $contextId = $input['id'] ?? null;
        $messages = $input['messages'];
        $metadata = $input['metadata'] ?? [];

        // Generate title from first user message (first 100 chars)
        $title = '';
        foreach ($messages as $msg) {
            if ($msg['role'] === 'user') {
                $title = mb_substr($msg['content'], 0, 100);
                break;
            }
        }
        if (empty($title)) {
            $title = 'Untitled Conversation';
        }

        // Determine primary provider (from last assistant message)
        $provider = 'unknown';
        for ($i = count($messages) - 1; $i >= 0; $i--) {
            if ($messages[$i]['role'] === 'assistant' && !empty($messages[$i]['provider'])) {
                $provider = $messages[$i]['provider'];
                break;
            }
        }

        $messageCount = count($messages);

        // Build context_data JSON
        $contextData = json_encode([
            'messages' => $messages,
            'metadata' => $metadata
        ], JSON_UNESCAPED_UNICODE);

        if ($contextId) {
            // Update existing context
            $stmt = $this->db->prepare('
                UPDATE conversation_contexts
                SET title = ?,
                    context_data = ?,
                    provider = ?,
                    message_count = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ?
            ');
            $stmt->execute([$title, $contextData, $provider, $messageCount, $contextId, $userId]);

            return [
                'success' => true,
                'message' => 'Context updated successfully',
                'data' => ['id' => $contextId],
                'status_code' => 200
            ];
        } else {
            // Create new context
            $stmt = $this->db->prepare('
                INSERT INTO conversation_contexts (user_id, title, context_data, provider, message_count)
                VALUES (?, ?, ?, ?, ?)
            ');
            $stmt->execute([$userId, $title, $contextData, $provider, $messageCount]);
            $newId = (int) $this->db->lastInsertId();

            return [
                'success' => true,
                'message' => 'Context created successfully',
                'data' => ['id' => $newId],
                'status_code' => 200
            ];
        }
    }

    /**
     * Update a context (e.g., rename title)
     */
    public function update(array $request, int $id): array
    {
        $userId = $request['user_id'];
        $input = $request['body'];

        // Validate that title is provided
        if (!isset($input['title']) || trim($input['title']) === '') {
            return [
                'success' => false,
                'message' => 'Title is required',
                'status_code' => 400
            ];
        }

        $newTitle = trim($input['title']);

        // Update the context title
        $stmt = $this->db->prepare('
            UPDATE conversation_contexts
            SET title = ?
            WHERE id = ? AND user_id = ?
        ');
        $stmt->execute([$newTitle, $id, $userId]);

        if ($stmt->rowCount() === 0) {
            return [
                'success' => false,
                'message' => 'Context not found',
                'status_code' => 404
            ];
        }

        return [
            'success' => true,
            'message' => 'Context updated successfully',
            'status_code' => 200
        ];
    }

    /**
     * Delete a context
     */
    public function delete(array $request, int $id): array
    {
        $userId = $request['user_id'];

        $stmt = $this->db->prepare('
            DELETE FROM conversation_contexts
            WHERE id = ? AND user_id = ?
        ');
        $stmt->execute([$id, $userId]);

        if ($stmt->rowCount() === 0) {
            return [
                'success' => false,
                'message' => 'Context not found',
                'status_code' => 404
            ];
        }

        return [
            'success' => true,
            'message' => 'Context deleted successfully',
            'status_code' => 200
        ];
    }
}
