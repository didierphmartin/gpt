<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * File Storage Controller
 *
 * Provides API endpoints for browsing and reading files from universalFS.
 */
class FileStorageController
{
    private PDO $db;
    private array $config;
    private ?object $adapterFactory = null;
    private ?object $credentialStore = null;

    private const UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs';
    private const ROOT_FOLDER = 'synergyaichatroot';
    private const UNIVERSALFS_USER_ID = 'Synergyaichat'; // universalFS credential user

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
     * Ensure storage columns exist in users table
     */
    private function ensureStorageColumnsExist(): void
    {
        try {
            $this->db->query("SELECT storage_provider, storage_folder FROM users LIMIT 1");
        } catch (\PDOException $e) {
            try {
                $this->db->exec("ALTER TABLE users ADD COLUMN storage_provider VARCHAR(50) DEFAULT 'local'");
            } catch (\PDOException $e2) { /* already exists */ }

            try {
                $this->db->exec("ALTER TABLE users ADD COLUMN storage_folder VARCHAR(255) DEFAULT ''");
            } catch (\PDOException $e2) { /* already exists */ }
        }
    }

    /**
     * Get user's storage configuration
     */
    private function getUserStorageConfig(int $userId): array
    {
        $this->ensureStorageColumnsExist();

        $stmt = $this->db->prepare(
            "SELECT storage_provider, storage_folder FROM users WHERE id = ?"
        );
        $stmt->execute([$userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        return [
            'provider' => $user['storage_provider'] ?? 'local',
            'folder' => $user['storage_folder'] ?? ''
        ];
    }

    /**
     * Get available storage providers for the user
     */
    public function getProviders(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required'];
        }

        try {
            $client = $this->getUniversalFSClient($userId);

            if (!$client) {
                // Return default providers if universalFS not available
                return [
                    'success' => true,
                    'providers' => [
                        ['id' => 'local', 'name' => 'Local Storage', 'icon' => 'folder', 'connected' => true]
                    ]
                ];
            }

            $availableProviders = $client->getAvailableProviders();
            $providers = [];

            $providerInfo = [
                'local' => ['name' => 'Local Storage', 'icon' => 'folder'],
                'gdrive' => ['name' => 'Google Drive', 'icon' => 'cloud'],
                's3' => ['name' => 'Amazon S3', 'icon' => 'database'],
                'onedrive' => ['name' => 'OneDrive', 'icon' => 'cloud'],
            ];

            foreach ($availableProviders as $provider) {
                $info = $providerInfo[$provider] ?? ['name' => ucfirst($provider), 'icon' => 'folder'];
                $providers[] = [
                    'id' => $provider,
                    'name' => $info['name'],
                    'icon' => $info['icon'],
                    'connected' => true
                ];
            }

            // Always include local as fallback
            if (!in_array('local', $availableProviders)) {
                array_unshift($providers, [
                    'id' => 'local',
                    'name' => 'Local Storage',
                    'icon' => 'folder',
                    'connected' => true
                ]);
            }

            return ['success' => true, 'providers' => $providers];

        } catch (\Exception $e) {
            error_log("[FileStorageController] getProviders error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'providers' => []
            ];
        }
    }

    /**
     * List files and folders at a given path
     */
    public function listFiles(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required'];
        }

        // Get parameters from query string
        $query = $request['query'] ?? [];
        $relativePath = $query['path'] ?? ''; // Path relative to user's folder

        // Get user's storage config
        $storageConfig = $this->getUserStorageConfig($userId);
        $provider = $storageConfig['provider'];
        $userFolder = $storageConfig['folder'];

        // Check if storage folder is configured
        if (empty($userFolder)) {
            return [
                'success' => true,
                'provider' => $provider,
                'userFolder' => '',
                'path' => '',
                'fullPath' => '',
                'items' => [],
                'message' => 'No storage folder configured. Please configure your storage folder in Settings.'
            ];
        }

        // Build full path: synergyaichatroot/{user_folder}/{relative_path}
        $fullPath = $this->buildFullPath($userFolder, $relativePath);

        try {
            // Get universalFS adapter for the provider
            $adapter = $this->getUniversalFSAdapter($provider);

            if (!$adapter) {
                // No universalFS adapter available
                if ($provider !== 'local') {
                    return [
                        'success' => true,
                        'provider' => $provider,
                        'userFolder' => $userFolder,
                        'path' => $relativePath,
                        'fullPath' => $fullPath,
                        'items' => [],
                        'message' => 'Cloud storage is not yet configured. Please contact support or configure universalFS.'
                    ];
                }
                // Fallback to local storage
                return $this->listLocalFiles($userId, $fullPath);
            }

            // Use path directly (not URI format) - universalFS uses paths like '/' or '/folder'
            $listPath = '/' . $fullPath;

            error_log("[FileStorageController] Listing path: " . $listPath . " on provider: " . $provider);

            // Try to list the folder
            try {
                $result = $adapter->ls($listPath);
            } catch (\Exception $e) {
                // Folder might not exist, try to create it
                error_log("[FileStorageController] Folder not found, attempting to create: " . $listPath . " - Error: " . $e->getMessage());

                try {
                    // Create the folder structure using paths (not URIs)
                    $rootPath = '/' . self::ROOT_FOLDER;
                    $userPath = '/' . self::ROOT_FOLDER . '/' . $userFolder;

                    try { $adapter->mkdir($rootPath); } catch (\Exception $e2) { /* might exist */ }
                    try { $adapter->mkdir($userPath); } catch (\Exception $e2) { /* might exist */ }

                    // Try listing again
                    $result = $adapter->ls($listPath);
                } catch (\Exception $e2) {
                    // Return empty folder if we still can't list
                    error_log("[FileStorageController] Could not create/list folder: " . $e2->getMessage());
                    return [
                        'success' => true,
                        'provider' => $provider,
                        'userFolder' => $userFolder,
                        'path' => $relativePath,
                        'fullPath' => $fullPath,
                        'items' => [],
                        'message' => 'Folder is empty or was just created.'
                    ];
                }
            }

            $items = [];
            foreach ($result->items as $item) {
                $items[] = [
                    'id' => $item->path ?? $item->extra['id'] ?? md5($item->name ?? ''),
                    'name' => $item->extra['name'] ?? $item->name ?? basename($item->path ?? ''),
                    'path' => $item->path ?? '',
                    'type' => $item->isDir ? 'folder' : 'file',
                    'size' => $item->size ?? 0,
                    'modified' => $item->mtime ? date('Y-m-d H:i:s', $item->mtime) : null,
                    'mimeType' => $item->extra['mimeType'] ?? $this->guessMimeType($item->name ?? ''),
                ];
            }

            // Sort: folders first, then by name
            usort($items, function($a, $b) {
                if ($a['type'] !== $b['type']) {
                    return $a['type'] === 'folder' ? -1 : 1;
                }
                return strcasecmp($a['name'], $b['name']);
            });

            return [
                'success' => true,
                'provider' => $provider,
                'userFolder' => $userFolder,
                'path' => $relativePath, // Relative path for frontend navigation
                'fullPath' => $fullPath,  // Full path including synergyaichatroot
                'items' => $items
            ];

        } catch (\Exception $e) {
            error_log("[FileStorageController] listFiles error: " . $e->getMessage() . " - URI: " . ($uri ?? 'not set'));
            return [
                'success' => false,
                'error' => 'Unable to connect to storage. Please check your settings.',
                'items' => []
            ];
        }
    }

    /**
     * Read file content
     */
    public function readFile(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required'];
        }

        // Get parameters from query string
        $query = $request['query'] ?? [];
        $fileId = $query['fileId'] ?? $query['file_id'] ?? '';

        if (!$fileId) {
            return ['success' => false, 'error' => 'File ID is required'];
        }

        // Get user's storage config (provider is set in Settings)
        $storageConfig = $this->getUserStorageConfig($userId);
        $provider = $storageConfig['provider'];

        try {
            $adapter = $this->getUniversalFSAdapter($provider);

            if (!$adapter) {
                return $this->readLocalFile($userId, $fileId);
            }

            // Use path directly (fileId contains the path)
            $filePath = '/' . ltrim($fileId, '/');

            error_log("[FileStorageController] Reading file: " . $filePath);

            // Get file info first
            $info = $adapter->stat($filePath);
            $mimeType = $info->extra['mimeType'] ?? $this->guessMimeType($info->name ?? basename($filePath));

            // Read content
            $stream = $adapter->readStream($filePath);
            $content = stream_get_contents($stream);
            fclose($stream);

            // Check if binary
            $isBinary = $this->isBinaryContent($content, $mimeType);

            return [
                'success' => true,
                'name' => $info->extra['name'] ?? $info->name ?? basename($fileId),
                'size' => $info->size ?? strlen($content),
                'mimeType' => $mimeType,
                'isBinary' => $isBinary,
                'content' => $isBinary ? base64_encode($content) : $content,
                'encoding' => $isBinary ? 'base64' : 'utf-8'
            ];

        } catch (\Exception $e) {
            error_log("[FileStorageController] readFile error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }

    /**
     * Get universalFS adapter for the given provider
     * Uses AdapterFactory with PdoCredentialStore (same pattern as test_s3.php)
     */
    private function getUniversalFSAdapter(string $provider): ?object
    {
        $autoloadPath = self::UNIVERSALFS_PATH . '/vendor/autoload.php';

        if (!file_exists($autoloadPath)) {
            error_log("[FileStorageController] universalFS not found at: " . $autoloadPath);
            return null;
        }

        try {
            require_once $autoloadPath;

            // Initialize factory if not done yet
            if ($this->adapterFactory === null) {
                // Load universalFS .env for database credentials (same as test_s3.php)
                $dotenv = \Dotenv\Dotenv::createImmutable(self::UNIVERSALFS_PATH);
                $dotenv->load();

                // Connect to universalFS database
                $pdo = new \PDO(
                    sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $_ENV['DB_HOST'], $_ENV['DB_NAME']),
                    $_ENV['DB_USER'],
                    $_ENV['DB_PASS'],
                    [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]
                );

                $this->credentialStore = new \UniversalFS\Credential\PdoCredentialStore($pdo);
                $this->adapterFactory = new \UniversalFS\Factory\AdapterFactory($this->credentialStore);
            }

            // Connect using the universalFS user ID (configured in universalFS credentials table)
            $adapter = $this->adapterFactory->connect(self::UNIVERSALFS_USER_ID, $provider);

            return $adapter;

        } catch (\Exception $e) {
            error_log("[FileStorageController] universalFS adapter error: " . $e->getMessage());
            return null;
        }
    }

    /**
     * List local files (fallback)
     * Uses the same structure: storage/{ROOT_FOLDER}/{user_folder}/{path}
     */
    private function listLocalFiles(int $userId, string $path): array
    {
        $basePath = $this->config['storage_path'] ?? __DIR__ . '/../../../../storage';
        $fullPath = $basePath . '/' . ltrim($path, '/');

        if (!is_dir($fullPath)) {
            // Create the directory structure if it doesn't exist
            if (mkdir($fullPath, 0755, true)) {
                error_log("[FileStorageController] Created local folder: " . $fullPath);
            }
            return [
                'success' => true,
                'provider' => 'local',
                'path' => $path,
                'fullPath' => $fullPath,
                'items' => [],
                'message' => 'Folder is empty or was just created.'
            ];
        }

        $items = [];
        foreach (scandir($fullPath) as $name) {
            if ($name === '.' || $name === '..') continue;

            $itemPath = $fullPath . '/' . $name;
            $relativePath = trim($path . '/' . $name, '/');

            $items[] = [
                'id' => $relativePath,
                'name' => $name,
                'path' => $relativePath,
                'type' => is_dir($itemPath) ? 'folder' : 'file',
                'size' => is_file($itemPath) ? filesize($itemPath) : 0,
                'modified' => date('Y-m-d H:i:s', filemtime($itemPath)),
                'mimeType' => is_file($itemPath) ? $this->guessMimeType($name) : 'inode/directory',
            ];
        }

        // Sort: folders first, then by name
        usort($items, function($a, $b) {
            if ($a['type'] !== $b['type']) {
                return $a['type'] === 'folder' ? -1 : 1;
            }
            return strcasecmp($a['name'], $b['name']);
        });

        return [
            'success' => true,
            'provider' => 'local',
            'path' => $path,
            'fullPath' => $fullPath,
            'items' => $items
        ];
    }

    /**
     * Read local file (fallback)
     */
    private function readLocalFile(int $userId, string $filePath): array
    {
        $basePath = $this->config['storage_path'] ?? __DIR__ . '/../../../../storage';
        $fullPath = $basePath . '/user_' . $userId . '/' . ltrim($filePath, '/');

        if (!file_exists($fullPath) || !is_file($fullPath)) {
            return ['success' => false, 'error' => 'File not found'];
        }

        $content = file_get_contents($fullPath);
        $mimeType = $this->guessMimeType(basename($fullPath));
        $isBinary = $this->isBinaryContent($content, $mimeType);

        return [
            'success' => true,
            'name' => basename($fullPath),
            'size' => filesize($fullPath),
            'mimeType' => $mimeType,
            'isBinary' => $isBinary,
            'content' => $isBinary ? base64_encode($content) : $content,
            'encoding' => $isBinary ? 'base64' : 'utf-8'
        ];
    }

    /**
     * Guess MIME type from filename
     */
    private function guessMimeType(string $filename): string
    {
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

        return match ($ext) {
            'txt' => 'text/plain',
            'html', 'htm' => 'text/html',
            'css' => 'text/css',
            'js' => 'application/javascript',
            'json' => 'application/json',
            'xml' => 'application/xml',
            'pdf' => 'application/pdf',
            'zip' => 'application/zip',
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'svg' => 'image/svg+xml',
            'md' => 'text/markdown',
            'csv' => 'text/csv',
            'php' => 'application/x-php',
            'py' => 'text/x-python',
            'java' => 'text/x-java',
            'c', 'cpp', 'h' => 'text/x-c',
            'sql' => 'application/sql',
            'yaml', 'yml' => 'text/yaml',
            default => 'application/octet-stream',
        };
    }

    /**
     * Check if content is binary
     */
    private function isBinaryContent(string $content, string $mimeType): bool
    {
        // Check MIME type first
        $textTypes = ['text/', 'application/json', 'application/javascript',
                      'application/xml', 'application/sql', 'application/x-php'];

        foreach ($textTypes as $type) {
            if (str_starts_with($mimeType, $type)) {
                return false;
            }
        }

        // Check for binary content (null bytes or high percentage of non-printable chars)
        if (strpos($content, "\0") !== false) {
            return true;
        }

        // Sample first 1KB
        $sample = substr($content, 0, 1024);
        $nonPrintable = 0;
        for ($i = 0; $i < strlen($sample); $i++) {
            $ord = ord($sample[$i]);
            if ($ord < 32 && !in_array($ord, [9, 10, 13])) { // Allow tab, newline, carriage return
                $nonPrintable++;
            }
        }

        return ($nonPrintable / max(1, strlen($sample))) > 0.1;
    }
}
