<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;

/**
 * Prompt Library Controller
 *
 * Manages CRUD operations for hierarchical prompt library.
 */
class PromptLibraryController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Get prompt library tree structure for user
     */
    public function getTree(array $request): array
    {
        $userId = $request['user_id'];

        // Fetch all items for user
        $stmt = $this->db->prepare('
            SELECT
                id,
                parent_id,
                type,
                name,
                content,
                sort_order,
                created_at,
                updated_at
            FROM prompt_library
            WHERE user_id = ?
            ORDER BY parent_id, sort_order, name
        ');
        $stmt->execute([$userId]);
        $items = $stmt->fetchAll();

        // Build hierarchical tree
        $tree = $this->buildTree($items);

        return [
            'success' => true,
            'data' => $tree,
            'status_code' => 200
        ];
    }

    /**
     * Get a specific prompt library item by ID
     */
    public function get(array $request, int $id): array
    {
        $userId = $request['user_id'];

        $stmt = $this->db->prepare('
            SELECT
                id,
                parent_id,
                type,
                name,
                content,
                sort_order,
                created_at,
                updated_at
            FROM prompt_library
            WHERE id = ? AND user_id = ?
        ');
        $stmt->execute([$id, $userId]);
        $item = $stmt->fetch();

        if (!$item) {
            return [
                'success' => false,
                'message' => 'Item not found',
                'status_code' => 404
            ];
        }

        return [
            'success' => true,
            'data' => $item,
            'status_code' => 200
        ];
    }

    /**
     * Create new prompt or folder
     */
    public function create(array $request): array
    {
        $userId = $request['user_id'];
        $input = $request['body'];

        // Validate required fields
        if (empty($input['type']) || !in_array($input['type'], ['folder', 'prompt'])) {
            return [
                'success' => false,
                'message' => 'Valid type (folder or prompt) is required',
                'status_code' => 400
            ];
        }

        if (empty($input['name'])) {
            return [
                'success' => false,
                'message' => 'Name is required',
                'status_code' => 400
            ];
        }

        // Extract data
        $type = $input['type'];
        $name = trim($input['name']);
        $parentId = $input['parent_id'] ?? null;
        $content = ($type === 'prompt' && isset($input['content'])) ? $input['content'] : null;
        $sortOrder = $input['sort_order'] ?? 0;

        // Validate parent exists if specified
        if ($parentId !== null) {
            $stmt = $this->db->prepare('SELECT id FROM prompt_library WHERE id = ? AND user_id = ?');
            $stmt->execute([$parentId, $userId]);
            if (!$stmt->fetch()) {
                return [
                    'success' => false,
                    'message' => 'Parent folder not found',
                    'status_code' => 400
                ];
            }
        }

        // Insert new item
        $stmt = $this->db->prepare('
            INSERT INTO prompt_library (user_id, parent_id, type, name, content, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
        ');
        $stmt->execute([$userId, $parentId, $type, $name, $content, $sortOrder]);
        $newId = $this->db->lastInsertId();

        return [
            'success' => true,
            'message' => ucfirst($type) . ' created successfully',
            'data' => [
                'id' => $newId,
                'type' => $type,
                'name' => $name,
                'parent_id' => $parentId,
                'content' => $content
            ],
            'status_code' => 200
        ];
    }

    /**
     * Update existing prompt or folder
     */
    public function update(array $request, int $id): array
    {
        $userId = $request['user_id'];
        $input = $request['body'];

        // Check if item exists and belongs to user
        $stmt = $this->db->prepare('SELECT id, type FROM prompt_library WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $userId]);
        $item = $stmt->fetch();

        if (!$item) {
            return [
                'success' => false,
                'message' => 'Item not found',
                'status_code' => 404
            ];
        }

        // Build update query dynamically based on provided fields
        $updates = [];
        $params = [];

        if (isset($input['name']) && !empty(trim($input['name']))) {
            $updates[] = 'name = ?';
            $params[] = trim($input['name']);
        }

        if (isset($input['content'])) {
            $updates[] = 'content = ?';
            $params[] = $input['content'];
        }

        if (isset($input['parent_id'])) {
            $updates[] = 'parent_id = ?';
            $params[] = $input['parent_id'];
        }

        if (isset($input['sort_order'])) {
            $updates[] = 'sort_order = ?';
            $params[] = $input['sort_order'];
        }

        if (empty($updates)) {
            return [
                'success' => false,
                'message' => 'No fields to update',
                'status_code' => 400
            ];
        }

        // Add WHERE parameters
        $params[] = $id;
        $params[] = $userId;

        // Execute update
        $sql = 'UPDATE prompt_library SET ' . implode(', ', $updates) . ' WHERE id = ? AND user_id = ?';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return [
            'success' => true,
            'message' => ucfirst($item['type']) . ' updated successfully',
            'data' => ['id' => $id],
            'status_code' => 200
        ];
    }

    /**
     * Delete prompt or folder (cascades to children)
     */
    public function delete(array $request, int $id): array
    {
        $userId = $request['user_id'];

        // Check if item exists and belongs to user
        $stmt = $this->db->prepare('SELECT id, type, name FROM prompt_library WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $userId]);
        $item = $stmt->fetch();

        if (!$item) {
            return [
                'success' => false,
                'message' => 'Item not found',
                'status_code' => 404
            ];
        }

        // Delete item (CASCADE will handle children)
        $stmt = $this->db->prepare('DELETE FROM prompt_library WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, $userId]);

        return [
            'success' => true,
            'message' => ucfirst($item['type']) . ' deleted successfully',
            'status_code' => 200
        ];
    }

    /**
     * Build hierarchical tree from flat array
     */
    private function buildTree(array $items, ?int $parentId = null): array
    {
        $branch = [];

        foreach ($items as $item) {
            if ($item['parent_id'] == $parentId) {
                $children = $this->buildTree($items, (int)$item['id']);
                if ($children) {
                    $item['children'] = $children;
                }
                $branch[] = $item;
            }
        }

        return $branch;
    }
}
