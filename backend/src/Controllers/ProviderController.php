<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\PackageResolver;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use AgentTeam\Functions\AgentDelegationFunctions;
use PDO;
use Exception;

/**
 * Provider Controller
 *
 * Handles AI provider listing and switching.
 */
class ProviderController
{
    private PDO $db;
    private array $config;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * List all available AI providers
     *
     * If user is authenticated and has custom API keys,
     * marks those providers as user-enabled.
     * Otherwise, returns all system-available providers.
     */
    public function list(array $request): array
    {
        try {
            // Apply DB-backed LLM provider settings (system_llm_settings is the
            // source of truth post-cutover; ai_config.php no longer carries
            // provider blocks). Without this, the assistant has no providers.
            $config = LLMProviderResolver::applyDbSettings($this->db, $this->config);
            $assistant = new AIPortfolioAssistant($config);

            // First try to load providers from database (system_llm_settings)
            $allProviders = $this->getProvidersFromDatabase();
            $currentProvider = null;

            if (empty($allProviders)) {
                // Fallback to config file for providers
                $allProviders = $assistant->getAllProviders();
            }

            // Package-based allowlist: keep only providers that the caller's
            // role-based package has enabled. Guests / unauthenticated callers
            // fall through to the guest package via PackageResolver.
            $userIdForPackage = $request['user_id'] ?? null;
            $allowedProviders = $this->resolvePackageAllowedProviders(
                is_numeric($userIdForPackage) ? (int)$userIdForPackage : null
            );
            if ($allowedProviders !== null) {
                $allProviders = array_values(array_filter(
                    $allProviders,
                    fn(array $p) => in_array($p['name'] ?? '', $allowedProviders, true)
                ));
            }

            // Note: there is no longer a "current/default" provider concept.
            // Callers must specify provider explicitly; missing provider is a bug.

            // Get registered functions (built-in)
            $functions = $assistant->getToolsManager()->getRegisteredFunctions();

            // Load MCP tools and merge with built-in functions.
            // The package-based allowlist limits tools to servers the caller's
            // role is permitted to see.
            try {
                $mcpLoader = new MCPToolsLoader($this->db);
                $mcpAllowlist = (new PackageResolver($this->db))->allowedMcpServers(
                    is_numeric($userIdForPackage) ? (int)$userIdForPackage : null
                );
                $mcpLoader->loadToolsForUser(null, $mcpAllowlist);
                if ($mcpLoader->hasTools()) {
                    $mcpTools = $mcpLoader->getTools();
                    foreach ($mcpTools as $toolName => $toolInfo) {
                        $functions[] = $toolName;
                    }
                }
            } catch (Exception $e) {
                // Log but don't fail if MCP loading fails
                error_log("ProviderController: Failed to load MCP tools: " . $e->getMessage());
            }

            // Add delegation tools (for agent teams feature)
            $delegationTools = AgentDelegationFunctions::getToolNames();
            foreach ($delegationTools as $toolName) {
                $functions[] = $toolName;
            }

            // Check if user has custom API keys
            $userId = $request['user_id'] ?? null;
            $userHasCustomKeys = false;
            $userEnabledProviders = [];

            if ($userId) {
                // Get user's custom API keys
                $sql = "SELECT provider FROM user_api_keys WHERE user_id = :user_id AND api_key IS NOT NULL AND api_key != ''";
                $stmt = $this->db->prepare($sql);
                $stmt->execute([':user_id' => $userId]);
                $userKeys = $stmt->fetchAll(PDO::FETCH_COLUMN);

                if (!empty($userKeys)) {
                    $userHasCustomKeys = true;
                    $userEnabledProviders = $userKeys;
                }
            }

            // If user has custom keys, mark which providers they have enabled
            // All system providers remain available, but user-enabled ones are marked
            foreach ($allProviders as &$provider) {
                $provider['user_has_key'] = in_array($provider['name'], $userEnabledProviders);
                // Provider is available if: system has it configured OR user has their own key
                if ($userHasCustomKeys) {
                    // When user has custom keys, only show as available if they have a key for it
                    // OR if it's a system default provider
                    $provider['available'] = $provider['available'] || $provider['user_has_key'];
                }
            }

            return [
                'success' => true,
                'providers' => $allProviders,
                'current_provider' => $currentProvider,
                'user_has_custom_keys' => $userHasCustomKeys,
                'user_enabled_providers' => $userEnabledProviders,
                'functions' => $functions,
                'function_count' => count($functions),
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * Switch to a different AI provider
     */
    public function switch(array $request): array
    {
        $newProvider = $request['body']['provider'] ?? null;

        if (!$newProvider) {
            return [
                'success' => false,
                'error' => 'Provider name is required',
                'status_code' => 400
            ];
        }

        try {
            $config = LLMProviderResolver::applyDbSettings($this->db, $this->config);
            $assistant = new AIPortfolioAssistant($config);
            $assistant->setProvider($newProvider);

            return [
                'success' => true,
                'message' => "Switched to provider: {$newProvider}",
                'current_provider' => $newProvider,
                'status_code' => 200
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 400
            ];
        }
    }

    /**
     * Resolve the caller's role-based package and return the list of provider
     * names it allows (providers[name].enabled === true). Returns null when
     * the package has no providers entry so the caller can fall back to
     * "show everything" instead of "hide everything".
     */
    private function resolvePackageAllowedProviders(?int $userId): ?array
    {
        try {
            $resolver = new PackageResolver($this->db);
            $package = $resolver->resolveForUser($userId);
            $providers = $package['capabilities']['providers'] ?? null;

            if (!is_array($providers)) {
                return null;
            }

            $allowed = [];
            foreach ($providers as $name => $cfg) {
                if (is_array($cfg) && !empty($cfg['enabled'])) {
                    $allowed[] = $name;
                }
            }
            return $allowed;
        } catch (Exception $e) {
            error_log("[ProviderController] Package allowlist resolution failed: " . $e->getMessage());
            return null;
        }
    }

    /**
     * Load providers from database (system_llm_settings table)
     */
    private function getProvidersFromDatabase(): array
    {
        try {
            $sql = "SELECT * FROM system_llm_settings WHERE enabled = 1 ORDER BY sort_order ASC, display_name ASC";
            $stmt = $this->db->query($sql);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            if (empty($rows)) {
                return [];
            }

            $providers = [];
            foreach ($rows as $row) {
                $providers[] = [
                    'name' => $row['provider_key'],
                    'display_name' => $row['display_name'],
                    'model' => $row['model'],
                    'available' => true,
                    'supported_models' => json_decode($row['supported_models'] ?? '[]', true),
                    'max_tokens' => (int)$row['max_tokens'],
                    'api_format' => $row['api_format'],
                ];
            }

            return $providers;
        } catch (Exception $e) {
            error_log("[ProviderController] Error loading providers from DB: " . $e->getMessage());
            return [];
        }
    }
}
