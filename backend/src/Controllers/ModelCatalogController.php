<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * Model Catalog Controller
 *
 * Serves the single source of truth for available LLM models per provider.
 * The catalog is stored in backend/resources/model_catalog.json and consumed
 * by both gpt (user Settings > LLM API Keys) and gpt_admin (Packages editor
 * and Global Settings > LLM providers).
 *
 * Intentionally public: the gpt user Settings page fetches this before the
 * user sends their first request, and gpt_admin's login screen may need it
 * to render the LLM settings tab right after authentication.
 */
class ModelCatalogController
{
    public function __construct(PDO $_db, array $_config)
    {
        // db + config not needed — file-based resource. Signature matches the
        // FastRoute dispatcher's constructor convention in index.php.
    }

    /**
     * GET /api/v1/models/catalog
     */
    public function get(array $_request): array
    {
        $path = __DIR__ . '/../../resources/model_catalog.json';
        if (!is_file($path) || !is_readable($path)) {
            return [
                'success' => false,
                'error' => 'Model catalog file not found',
                'status_code' => 500,
            ];
        }

        $raw = file_get_contents($path);
        if ($raw === false) {
            return [
                'success' => false,
                'error' => 'Failed to read model catalog',
                'status_code' => 500,
            ];
        }

        $data = json_decode($raw, true);
        if (!is_array($data) || !isset($data['providers']) || !is_array($data['providers'])) {
            return [
                'success' => false,
                'error' => 'Model catalog is malformed',
                'status_code' => 500,
            ];
        }

        return [
            'success' => true,
            'providers' => $data['providers'],
            'updated' => $data['_updated'] ?? null,
        ];
    }
}
