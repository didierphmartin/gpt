<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Workflow Output Storage Service
 *
 * Handles saving workflow outputs to external storage via universalFS.
 * Supports local, S3, Google Drive, and OneDrive providers.
 */
class WorkflowOutputStorage
{
    private PDO $db;
    private array $config;
    private ?object $universalFSClient = null;

    // Path to universalFS library
    private const UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs';
    private const ROOT_FOLDER = 'synergyaichatroot';

    public function __construct(PDO $db, array $config = [])
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * Build the full path including the root folder
     * Structure: synergyaichatroot/{user_folder}/{path}
     */
    private function buildFullPath(string $userFolder, string $path = ''): string
    {
        $parts = [self::ROOT_FOLDER];

        if (!empty($userFolder)) {
            $parts[] = trim($userFolder, '/');
        }

        if (!empty($path)) {
            $parts[] = trim($path, '/');
        }

        return implode('/', $parts);
    }

    /**
     * Save workflow output to storage
     *
     * @param int $workflowId The workflow ID
     * @param int $userId The user ID
     * @param array $output The workflow output data
     * @return array Result with success status and file path
     */
    public function saveOutput(int $workflowId, int $userId, array $output): array
    {
        try {
            // Get workflow details
            $workflow = $this->getWorkflow($workflowId);
            if (!$workflow) {
                return ['success' => false, 'error' => 'Workflow not found'];
            }

            // Check if output storage is enabled for this workflow
            if (!$workflow['output_storage_enabled']) {
                return ['success' => false, 'error' => 'Output storage not enabled for this workflow'];
            }

            // Get storage configuration
            $storageConfig = $this->getStorageConfig($userId, $workflow);
            if (!$storageConfig['provider'] || !$storageConfig['folder']) {
                return ['success' => false, 'error' => 'Storage not configured'];
            }

            // Generate filename
            $filename = $this->generateFilename($workflow['name']);

            // Build full path: synergyaichatroot/{user_folder}/{filename}
            $fullPath = $this->buildFullPath($storageConfig['folder'], $filename);

            // Prepare content
            $content = json_encode($output, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);

            // Save via universalFS
            $result = $this->saveToStorage(
                $storageConfig['provider'],
                $fullPath,
                $content,
                $userId
            );

            if ($result['success']) {
                error_log("[WorkflowOutputStorage] Saved output to {$storageConfig['provider']}://{$fullPath}");
            }

            return array_merge($result, [
                'filename' => $filename,
                'path' => $fullPath,
                'provider' => $storageConfig['provider']
            ]);

        } catch (\Exception $e) {
            error_log("[WorkflowOutputStorage] Error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }

    /**
     * List outputs for a workflow
     *
     * @param int $workflowId The workflow ID
     * @param int $userId The user ID
     * @return array List of output files
     */
    public function listOutputs(int $workflowId, int $userId): array
    {
        try {
            $workflow = $this->getWorkflow($workflowId);
            if (!$workflow) {
                return ['success' => false, 'error' => 'Workflow not found'];
            }

            $storageConfig = $this->getStorageConfig($userId, $workflow);
            if (!$storageConfig['provider'] || !$storageConfig['folder']) {
                return ['success' => true, 'files' => [], 'message' => 'Storage not configured'];
            }

            // Generate pattern to match files for this workflow
            $sanitizedName = $this->sanitizeFilename($workflow['name']);
            $pattern = $sanitizedName . '_';

            // Build full path: synergyaichatroot/{user_folder}
            $fullPath = $this->buildFullPath($storageConfig['folder']);

            // List files from storage
            $files = $this->listFromStorage(
                $storageConfig['provider'],
                $fullPath,
                $pattern,
                $userId
            );

            return [
                'success' => true,
                'files' => $files,
                'provider' => $storageConfig['provider'],
                'folder' => $storageConfig['folder']
            ];

        } catch (\Exception $e) {
            error_log("[WorkflowOutputStorage] List error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }

    /**
     * Get a specific output file content
     */
    public function getOutput(int $workflowId, int $userId, string $filename): array
    {
        try {
            $workflow = $this->getWorkflow($workflowId);
            if (!$workflow) {
                return ['success' => false, 'error' => 'Workflow not found'];
            }

            $storageConfig = $this->getStorageConfig($userId, $workflow);
            if (!$storageConfig['provider'] || !$storageConfig['folder']) {
                return ['success' => false, 'error' => 'Storage not configured'];
            }

            // Build full path: synergyaichatroot/{user_folder}/{filename}
            $fullPath = $this->buildFullPath($storageConfig['folder'], $filename);

            $content = $this->readFromStorage(
                $storageConfig['provider'],
                $fullPath,
                $userId
            );

            return [
                'success' => true,
                'content' => $content,
                'filename' => $filename
            ];

        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }

    /**
     * Get workflow details
     */
    private function getWorkflow(int $workflowId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT id, name, user_id, output_storage_enabled, output_folder
             FROM agent_workflows WHERE id = ?"
        );
        $stmt->execute([$workflowId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    /**
     * Get storage configuration for user/workflow
     * Workflow-specific folder overrides user's global folder
     */
    private function getStorageConfig(int $userId, array $workflow): array
    {
        // Get user's global storage settings
        $stmt = $this->db->prepare(
            "SELECT storage_provider, storage_folder FROM users WHERE id = ?"
        );
        $stmt->execute([$userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        $provider = $user['storage_provider'] ?? 'local';
        $folder = $user['storage_folder'] ?? '';

        // Workflow-specific folder overrides global
        if (!empty($workflow['output_folder'])) {
            $folder = $workflow['output_folder'];
        }

        return [
            'provider' => $provider,
            'folder' => $folder
        ];
    }

    /**
     * Generate filename from workflow name + timestamp
     * Format: Workflow_Name_2026-03-31_19-45-30.json
     */
    private function generateFilename(string $workflowName): string
    {
        $sanitized = $this->sanitizeFilename($workflowName);
        $timestamp = date('Y-m-d_H-i-s');
        return "{$sanitized}_{$timestamp}.json";
    }

    /**
     * Sanitize workflow name for use as filename
     * - Replace spaces with underscores
     * - Remove special characters
     */
    private function sanitizeFilename(string $name): string
    {
        // Replace spaces with underscores
        $name = str_replace(' ', '_', $name);
        // Remove special characters except - and _
        $name = preg_replace('/[^a-zA-Z0-9_\-]/', '', $name);
        // Remove consecutive underscores
        $name = preg_replace('/_+/', '_', $name);
        // Trim underscores from start/end
        $name = trim($name, '_');
        return $name ?: 'workflow';
    }

    /**
     * Save content to storage via universalFS
     */
    private function saveToStorage(string $provider, string $path, string $content, int $userId): array
    {
        // Initialize universalFS client if needed
        $client = $this->getUniversalFSClient($userId);

        if (!$client) {
            // Fallback to local storage if universalFS not available
            return $this->saveToLocalFallback($path, $content, $userId);
        }

        try {
            $client->connect($provider);
            $uri = "{$provider}://{$path}";
            $client->write($uri, $content);

            return ['success' => true];
        } catch (\Exception $e) {
            error_log("[WorkflowOutputStorage] universalFS write error: " . $e->getMessage());
            return ['success' => false, 'error' => $e->getMessage()];
        }
    }

    /**
     * List files from storage via universalFS
     */
    private function listFromStorage(string $provider, string $folder, string $pattern, int $userId): array
    {
        $client = $this->getUniversalFSClient($userId);

        if (!$client) {
            return $this->listFromLocalFallback($folder, $pattern, $userId);
        }

        try {
            $client->connect($provider);
            $uri = "{$provider}://{$folder}";
            $result = $client->ls($uri);

            // Filter files matching the pattern
            $files = [];
            foreach ($result->items as $item) {
                if ($item->type === 'file' && str_starts_with($item->name, $pattern)) {
                    $files[] = [
                        'name' => $item->name,
                        'size' => $item->size ?? 0,
                        'modified' => $item->modifiedTime ?? null,
                        'path' => $folder . '/' . $item->name
                    ];
                }
            }

            // Sort by modified date descending (newest first)
            usort($files, fn($a, $b) => ($b['modified'] ?? '') <=> ($a['modified'] ?? ''));

            return $files;
        } catch (\Exception $e) {
            error_log("[WorkflowOutputStorage] universalFS list error: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Read file from storage via universalFS
     */
    private function readFromStorage(string $provider, string $path, int $userId): string
    {
        $client = $this->getUniversalFSClient($userId);

        if (!$client) {
            return $this->readFromLocalFallback($path, $userId);
        }

        try {
            $client->connect($provider);
            $uri = "{$provider}://{$path}";
            return $client->read($uri);
        } catch (\Exception $e) {
            throw new \RuntimeException("Failed to read file: " . $e->getMessage());
        }
    }

    /**
     * Get universalFS client instance
     */
    private function getUniversalFSClient(int $userId): ?object
    {
        if ($this->universalFSClient !== null) {
            return $this->universalFSClient;
        }

        $bootstrapPath = self::UNIVERSALFS_PATH . '/bootstrap.php';

        if (!file_exists($bootstrapPath)) {
            error_log("[WorkflowOutputStorage] universalFS not found at: " . $bootstrapPath);
            return null;
        }

        try {
            require_once $bootstrapPath;

            // Get user's universalFS API key or use a service account
            $apiKey = $this->getUserUniversalFSApiKey($userId);

            if ($apiKey && function_exists('getUniversalFSClientWithApiKey')) {
                $this->universalFSClient = getUniversalFSClientWithApiKey($apiKey);
                return $this->universalFSClient;
            }

            error_log("[WorkflowOutputStorage] No universalFS API key configured for user {$userId}");
            return null;

        } catch (\Exception $e) {
            error_log("[WorkflowOutputStorage] Failed to initialize universalFS: " . $e->getMessage());
            return null;
        }
    }

    /**
     * Get user's universalFS API key
     * TODO: Add universalfs_api_key column to users table if needed
     */
    private function getUserUniversalFSApiKey(int $userId): ?string
    {
        // For now, check if there's a global API key in config
        return $this->config['universalfs']['api_key'] ?? null;
    }

    // =========================================
    // Local Fallback Methods
    // =========================================

    /**
     * Fallback: Save to local filesystem
     */
    private function saveToLocalFallback(string $path, string $content, int $userId): array
    {
        $basePath = $this->config['workflow_outputs_path']
            ?? __DIR__ . '/../../../../storage/workflow_outputs';

        $fullPath = $basePath . '/' . $userId . '/' . $path;
        $dir = dirname($fullPath);

        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        if (file_put_contents($fullPath, $content) !== false) {
            return ['success' => true];
        }

        return ['success' => false, 'error' => 'Failed to write file'];
    }

    /**
     * Fallback: List from local filesystem
     */
    private function listFromLocalFallback(string $folder, string $pattern, int $userId): array
    {
        $basePath = $this->config['workflow_outputs_path']
            ?? __DIR__ . '/../../../../storage/workflow_outputs';

        $fullPath = $basePath . '/' . $userId . '/' . $folder;

        if (!is_dir($fullPath)) {
            return [];
        }

        $files = [];
        foreach (scandir($fullPath) as $file) {
            if ($file === '.' || $file === '..') continue;
            if (!str_starts_with($file, $pattern)) continue;

            $filePath = $fullPath . '/' . $file;
            $files[] = [
                'name' => $file,
                'size' => filesize($filePath),
                'modified' => date('Y-m-d H:i:s', filemtime($filePath)),
                'path' => $folder . '/' . $file
            ];
        }

        usort($files, fn($a, $b) => $b['modified'] <=> $a['modified']);

        return $files;
    }

    /**
     * Fallback: Read from local filesystem
     */
    private function readFromLocalFallback(string $path, int $userId): string
    {
        $basePath = $this->config['workflow_outputs_path']
            ?? __DIR__ . '/../../../../storage/workflow_outputs';

        $fullPath = $basePath . '/' . $userId . '/' . $path;

        if (!file_exists($fullPath)) {
            throw new \RuntimeException("File not found: {$path}");
        }

        return file_get_contents($fullPath);
    }
}
