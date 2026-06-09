<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\Services\UsageLogger;
use PDO;
use Exception;

/**
 * Usage Controller
 *
 * Provides access to LLM usage statistics and tracking.
 */
class UsageController
{
    private PDO $db;
    private array $config;
    private UsageLogger $usageLogger;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->usageLogger = new UsageLogger($db, true);
    }

    /**
     * Get usage balance/ledger for current user
     */
    public function getBalance(array $request): array
    {
        $userId = $request['user_id'];
        $provider = $request['query']['provider'] ?? null;

        $balance = $this->usageLogger->getBalance($userId, $provider);

        return [
            'success' => true,
            'data' => $balance,
            'status_code' => 200
        ];
    }

    /**
     * Get transaction history for current user
     */
    public function getTransactions(array $request): array
    {
        $userId = $request['user_id'];

        // Parse query parameters
        $filters = [];
        if (isset($request['query']['provider'])) {
            $filters['provider'] = $request['query']['provider'];
        }
        if (isset($request['query']['date_from'])) {
            $filters['date_from'] = $request['query']['date_from'];
        }
        if (isset($request['query']['date_to'])) {
            $filters['date_to'] = $request['query']['date_to'];
        }
        if (isset($request['query']['status'])) {
            $filters['status'] = $request['query']['status'];
        }

        $limit = isset($request['query']['limit']) ? (int)$request['query']['limit'] : 100;
        $offset = isset($request['query']['offset']) ? (int)$request['query']['offset'] : 0;

        // Validate limit
        if ($limit < 1 || $limit > 1000) {
            $limit = 100;
        }

        $transactions = $this->usageLogger->getTransactions($userId, $filters, $limit, $offset);

        return [
            'success' => true,
            'data' => $transactions,
            'pagination' => [
                'limit' => $limit,
                'offset' => $offset,
                'count' => count($transactions)
            ],
            'status_code' => 200
        ];
    }

    /**
     * Get aggregated statistics for current user
     */
    public function getStats(array $request): array
    {
        $userId = $request['user_id'];

        $period = $request['query']['period'] ?? 'month';
        $provider = $request['query']['provider'] ?? null;

        // Validate period
        if (!in_array($period, ['day', 'week', 'month', 'year', 'all'])) {
            $period = 'month';
        }

        $stats = $this->usageLogger->getStats($userId, $period, $provider);

        return [
            'success' => true,
            'data' => $stats,
            'period' => $period,
            'provider' => $provider,
            'status_code' => 200
        ];
    }
}
