<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use PDO;

/**
 * Synchronizes backend functions with Hume EVI Tools API
 *
 * This service automatically creates, updates, and manages tools in Hume EVI
 * based on the functions registered in ToolsManager.
 */
class HumeToolSyncService
{
    private Client $httpClient;
    private string $apiKey;
    private string $baseUrl;
    private ?PDO $pdo;
    private array $config;

    public function __construct(array $config, ?PDO $pdo = null)
    {
        $this->config = $config;
        $this->apiKey = $config['hume_evi']['api_key'] ?? '';
        $this->baseUrl = $config['hume_evi']['base_url'] ?? 'https://api.hume.ai/v0/evi';
        $this->pdo = $pdo;

        if (empty($this->apiKey)) {
            throw new \RuntimeException('Hume API key not configured');
        }

        $this->httpClient = new Client([
            'timeout' => 30,
            'headers' => [
                'X-Hume-Api-Key' => $this->apiKey,
                'Content-Type' => 'application/json',
            ]
        ]);
    }

    /**
     * Sync all backend tools to Hume EVI
     *
     * @param ToolsManager $toolsManager Backend tools manager
     * @return array Sync results with statistics
     */
    public function syncAllTools(ToolsManager $toolsManager): array
    {
        $localTools = $toolsManager->getToolDefinitions();
        $humeTools = $this->listHumeTools();

        $results = [
            'total_local' => count($localTools),
            'total_hume' => count($humeTools),
            'created' => [],
            'updated' => [],
            'unchanged' => [],
            'errors' => [],
            'tool_mapping' => []
        ];

        // Create mapping of Hume tools by name for quick lookup
        $humeToolsMap = [];
        foreach ($humeTools as $tool) {
            $humeToolsMap[$tool['name']] = $tool;
        }

        // Process each local tool
        foreach ($localTools as $localTool) {
            try {
                $toolName = $localTool['name'];

                if (isset($humeToolsMap[$toolName])) {
                    // Tool exists - check if update needed
                    $humeTool = $humeToolsMap[$toolName];

                    if ($this->toolNeedsUpdate($localTool, $humeTool)) {
                        $updated = $this->updateTool($humeTool['id'], $localTool);
                        $results['updated'][] = $toolName;
                        $results['tool_mapping'][$toolName] = $updated['tool_id'] ?? $updated['id'];
                    } else {
                        $results['unchanged'][] = $toolName;
                        $results['tool_mapping'][$toolName] = $humeTool['id'];
                    }
                } else {
                    // Tool doesn't exist - create it
                    $created = $this->createTool($localTool);
                    $results['created'][] = $toolName;
                    $results['tool_mapping'][$toolName] = $created['tool_id'] ?? $created['id'];
                }

                // Store mapping in database if available
                if ($this->pdo && isset($results['tool_mapping'][$toolName])) {
                    $this->storeToolMapping(
                        $toolName,
                        $results['tool_mapping'][$toolName],
                        $localTool
                    );
                }

            } catch (\Throwable $e) {
                $results['errors'][] = [
                    'tool' => $localTool['name'] ?? 'unknown',
                    'error' => $e->getMessage()
                ];
            }
        }

        // Optionally cleanup orphaned tools
        if ($this->config['hume_evi']['cleanup_orphaned_tools'] ?? false) {
            $results['deleted'] = $this->cleanupOrphanedTools($localTools, $humeTools);
        }

        return $results;
    }

    /**
     * Get synchronization status (compare local vs Hume)
     */
    public function getSyncStatus(ToolsManager $toolsManager): array
    {
        $localTools = $toolsManager->getToolDefinitions();
        $humeTools = $this->listHumeTools();

        $localNames = array_column($localTools, 'name');
        $humeNames = array_column($humeTools, 'name');

        return [
            'local_count' => count($localTools),
            'hume_count' => count($humeTools),
            'missing_in_hume' => array_values(array_diff($localNames, $humeNames)),
            'missing_in_local' => array_values(array_diff($humeNames, $localNames)),
            'needs_sync' => !empty(array_diff($localNames, $humeNames)),
            'local_tools' => $localNames,
            'hume_tools' => $humeNames
        ];
    }

    /**
     * List all tools from Hume API
     */
    public function listHumeTools(): array
    {
        try {
            $response = $this->httpClient->get("{$this->baseUrl}/tools", [
                'query' => [
                    'page_size' => 100,
                    'restrict_to_most_recent' => true
                ]
            ]);

            $data = json_decode($response->getBody()->getContents(), true);
            return $data['tools_page'] ?? [];

        } catch (GuzzleException $e) {
            throw new \RuntimeException("Failed to list Hume tools: " . $e->getMessage());
        }
    }

    /**
     * Create a new tool in Hume
     */
    public function createTool(array $toolDefinition): array
    {
        try {
            // Remove 'default' fields from schema (Hume doesn't support them)
            $cleanedSchema = $this->removeDefaultFields($toolDefinition['input_schema']);

            $payload = [
                'name' => $toolDefinition['name'],
                'parameters' => json_encode($cleanedSchema),
                'description' => $toolDefinition['description'] ?? '',
                'version_description' => 'Auto-synced from backend'
            ];

            $response = $this->httpClient->post("{$this->baseUrl}/tools", [
                'json' => $payload
            ]);

            return json_decode($response->getBody()->getContents(), true);

        } catch (GuzzleException $e) {
            throw new \RuntimeException("Failed to create tool '{$toolDefinition['name']}': " . $e->getMessage());
        }
    }

    /**
     * Remove 'default' fields from schema (Hume doesn't support them)
     */
    private function removeDefaultFields(array $schema): array
    {
        foreach ($schema as $key => &$value) {
            if ($key === 'default') {
                unset($schema[$key]);
            } elseif (is_array($value)) {
                $value = $this->removeDefaultFields($value);
            }
        }
        return $schema;
    }

    /**
     * Update an existing tool in Hume
     * Note: Hume creates new versions, doesn't update in place
     */
    public function updateTool(string $toolId, array $toolDefinition): array
    {
        // Hume uses versioning - creating new version updates the tool
        return $this->createTool($toolDefinition);
    }

    /**
     * Delete a tool from Hume
     */
    public function deleteTool(string $toolId): bool
    {
        try {
            $this->httpClient->delete("{$this->baseUrl}/tools/{$toolId}");
            return true;
        } catch (GuzzleException $e) {
            throw new \RuntimeException("Failed to delete tool: " . $e->getMessage());
        }
    }

    /**
     * Link tools to an EVI configuration
     */
    public function linkToolsToConfig(string $configId, array $toolIds): array
    {
        try {
            $tools = array_map(function($toolId) {
                return ['id' => $toolId];
            }, $toolIds);

            $response = $this->httpClient->post("{$this->baseUrl}/configs/{$configId}", [
                'json' => [
                    'tools' => $tools
                ]
            ]);

            return json_decode($response->getBody()->getContents(), true);

        } catch (GuzzleException $e) {
            throw new \RuntimeException("Failed to link tools to config: " . $e->getMessage());
        }
    }

    /**
     * Check if tool needs update
     */
    private function toolNeedsUpdate(array $localTool, array $humeTool): bool
    {
        // Clean local params first (remove default fields before comparing)
        $cleanedLocalSchema = $this->removeDefaultFields($localTool['input_schema']);
        $localParams = json_encode($cleanedLocalSchema);
        $humeParams = $humeTool['parameters'] ?? '{}';

        if ($localParams !== $humeParams) {
            return true;
        }

        // Compare description
        $localDesc = $localTool['description'] ?? '';
        $humeDesc = $humeTool['description'] ?? '';

        return $localDesc !== $humeDesc;
    }

    /**
     * Cleanup tools that exist in Hume but not in backend
     */
    private function cleanupOrphanedTools(array $localTools, array $humeTools): array
    {
        $localNames = array_column($localTools, 'name');
        $deleted = [];

        foreach ($humeTools as $humeTool) {
            if (!in_array($humeTool['name'], $localNames)) {
                try {
                    $this->deleteTool($humeTool['tool_id']);
                    $deleted[] = $humeTool['name'];
                } catch (\Throwable $e) {
                    // Log error but continue
                    error_log("Failed to delete orphaned tool {$humeTool['name']}: " . $e->getMessage());
                }
            }
        }

        return $deleted;
    }

    /**
     * Store tool mapping in database
     */
    private function storeToolMapping(string $toolName, string $humeToolId, array $definition): void
    {
        if (!$this->pdo) {
            return;
        }

        try {
            $definitionHash = md5(json_encode($definition));

            $stmt = $this->pdo->prepare(
                "INSERT INTO hume_tool_mapping (tool_name, hume_tool_id, definition_hash, last_synced)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    hume_tool_id = VALUES(hume_tool_id),
                    definition_hash = VALUES(definition_hash),
                    last_synced = NOW()"
            );

            $stmt->execute([$toolName, $humeToolId, $definitionHash]);

        } catch (\PDOException $e) {
            // Table might not exist yet, that's okay
            error_log("Could not store tool mapping: " . $e->getMessage());
        }
    }

    /**
     * Get stored tool mappings from database
     */
    public function getStoredMappings(): array
    {
        if (!$this->pdo) {
            return [];
        }

        try {
            $stmt = $this->pdo->query("SELECT * FROM hume_tool_mapping ORDER BY tool_name");
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (\PDOException $e) {
            return [];
        }
    }

    /**
     * Test connection to Hume API
     */
    public function testConnection(): array
    {
        try {
            $tools = $this->listHumeTools();

            return [
                'success' => true,
                'message' => 'Connected to Hume API successfully',
                'tools_count' => count($tools)
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'message' => 'Failed to connect: ' . $e->getMessage()
            ];
        }
    }
}
