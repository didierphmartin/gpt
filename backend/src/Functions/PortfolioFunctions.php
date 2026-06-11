<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Functions;

use PDO;

/**
 * Portfolio-related LLM functions
 *
 * These functions are designed to be registered with the ToolsManager
 * and called by Claude during conversations.
 */
class PortfolioFunctions
{
    private ?PDO $pdo;

    public function __construct(?PDO $pdo = null)
    {
        $this->pdo = $pdo;
    }

    /**
     * Get all functions with their handlers and schemas
     */
    public function getAllFunctions(): array
    {
        return [
            'get_portfolios' => [
                'handler' => [$this, 'getPortfolios'],
                'schema' => [
                    'description' => 'Get all portfolios for the current user',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => new \stdClass(),
                        'required' => [],
                    ],
                ],
            ],
            'get_portfolio_assets_with_discovery' => [
                'handler' => [$this, 'getPortfolioAssetsWithDiscovery'],
                'schema' => [
                    'description' => 'PRIMARY FUNCTION FOR PORTFOLIO ANALYSIS - Get comprehensive portfolio holdings with current prices, values, and performance metrics. Automatically discovers the default portfolio.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'portfolio_id' => [
                                'type' => 'integer',
                                'description' => 'Optional specific portfolio ID. If not provided, uses default portfolio.',
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],
            'get_portfolio_diversification' => [
                'handler' => [$this, 'getPortfolioDiversification'],
                'schema' => [
                    'description' => 'Get portfolio diversification breakdown by asset type, sector, and currency',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'portfolio_id' => [
                                'type' => 'integer',
                                'description' => 'Portfolio ID to analyze',
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],
            'get_all_transactions' => [
                'handler' => [$this, 'getAllTransactions'],
                'schema' => [
                    'description' => 'Get all transactions for the user with pagination',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'page' => [
                                'type' => 'integer',
                                'description' => 'Page number (default: 1)',
                            ],
                            'limit' => [
                                'type' => 'integer',
                                'description' => 'Items per page (default: 50)',
                            ],
                            'sort' => [
                                'type' => 'string',
                                'description' => 'Sort field (default: date)',
                            ],
                            'order' => [
                                'type' => 'string',
                                'description' => 'Sort order: asc or desc (default: desc)',
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],
        ];
    }

    /**
     * Get all portfolios for a user
     */
    public function getPortfolios(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $stmt = $this->pdo->prepare(
                "SELECT id, name, description, is_default, currency, created_at
                 FROM portfolios WHERE user_id = ? ORDER BY is_default DESC, name ASC"
            );
            $stmt->execute([$userId]);
            $portfolios = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return [
                'success' => true,
                'portfolios' => $portfolios,
                'count' => count($portfolios),
            ];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }

    /**
     * Get portfolio assets with auto-discovery of default portfolio
     */
    public function getPortfolioAssetsWithDiscovery(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $portfolioId = $params['portfolio_id'] ?? null;

            // Auto-discover default portfolio if not specified
            if (!$portfolioId) {
                $stmt = $this->pdo->prepare(
                    "SELECT id FROM portfolios WHERE user_id = ? AND is_default = 1 LIMIT 1"
                );
                $stmt->execute([$userId]);
                $default = $stmt->fetch(PDO::FETCH_ASSOC);
                $portfolioId = $default['id'] ?? null;

                if (!$portfolioId) {
                    // Get first portfolio
                    $stmt = $this->pdo->prepare(
                        "SELECT id FROM portfolios WHERE user_id = ? ORDER BY id ASC LIMIT 1"
                    );
                    $stmt->execute([$userId]);
                    $first = $stmt->fetch(PDO::FETCH_ASSOC);
                    $portfolioId = $first['id'] ?? null;
                }
            }

            if (!$portfolioId) {
                return [
                    'success' => false,
                    'message' => 'No portfolio found for user',
                    'assets' => [],
                ];
            }

            // Get portfolio assets
            $stmt = $this->pdo->prepare(
                "SELECT pa.*, a.name as asset_name, a.symbol, a.type as asset_type,
                        a.exchange, a.currency
                 FROM portfolio_assets pa
                 JOIN assets a ON pa.asset_id = a.id
                 WHERE pa.portfolio_id = ?
                 ORDER BY pa.current_value DESC"
            );
            $stmt->execute([$portfolioId]);
            $assets = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate totals
            $totalValue = 0;
            $totalCost = 0;
            foreach ($assets as &$asset) {
                $totalValue += (float) ($asset['current_value'] ?? 0);
                $totalCost += (float) ($asset['total_cost'] ?? 0);

                // Calculate gain/loss
                $currentValue = (float) ($asset['current_value'] ?? 0);
                $cost = (float) ($asset['total_cost'] ?? 0);
                $asset['gain_loss'] = $currentValue - $cost;
                $asset['gain_loss_percent'] = $cost > 0 ? (($currentValue - $cost) / $cost) * 100 : 0;
            }

            return [
                'success' => true,
                'portfolio_id' => $portfolioId,
                'assets' => $assets,
                'summary' => [
                    'total_value' => $totalValue,
                    'total_cost' => $totalCost,
                    'total_gain_loss' => $totalValue - $totalCost,
                    'total_gain_loss_percent' => $totalCost > 0 ? (($totalValue - $totalCost) / $totalCost) * 100 : 0,
                    'asset_count' => count($assets),
                ],
            ];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }

    /**
     * Get portfolio diversification analysis
     */
    public function getPortfolioDiversification(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $portfolioId = $params['portfolio_id'] ?? null;

            // Auto-discover if not provided
            if (!$portfolioId) {
                $result = $this->getPortfolioAssetsWithDiscovery([], $userId);
                $portfolioId = $result['portfolio_id'] ?? null;
            }

            if (!$portfolioId) {
                return ['error' => 'No portfolio found'];
            }

            // Get diversification by asset type
            $stmt = $this->pdo->prepare(
                "SELECT a.type as asset_type,
                        SUM(pa.current_value) as total_value,
                        COUNT(*) as asset_count
                 FROM portfolio_assets pa
                 JOIN assets a ON pa.asset_id = a.id
                 WHERE pa.portfolio_id = ?
                 GROUP BY a.type
                 ORDER BY total_value DESC"
            );
            $stmt->execute([$portfolioId]);
            $byType = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Get total for percentages
            $total = array_sum(array_column($byType, 'total_value'));

            foreach ($byType as &$item) {
                $item['percentage'] = $total > 0 ? ($item['total_value'] / $total) * 100 : 0;
            }

            return [
                'success' => true,
                'portfolio_id' => $portfolioId,
                'by_asset_type' => $byType,
                'total_value' => $total,
            ];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }

    /**
     * Get all transactions with pagination
     */
    public function getAllTransactions(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $page = max(1, (int) ($params['page'] ?? 1));
            $limit = min(100, max(1, (int) ($params['limit'] ?? 50)));
            $offset = ($page - 1) * $limit;
            $sort = in_array($params['sort'] ?? 'date', ['date', 'amount', 'type']) ? $params['sort'] : 'date';
            $order = strtoupper($params['order'] ?? 'DESC') === 'ASC' ? 'ASC' : 'DESC';

            // Get transactions
            $stmt = $this->pdo->prepare(
                "SELECT t.*, a.name as asset_name, a.symbol
                 FROM transactions t
                 JOIN assets a ON t.asset_id = a.id
                 JOIN portfolios p ON t.portfolio_id = p.id
                 WHERE p.user_id = ?
                 ORDER BY t.{$sort} {$order}
                 LIMIT ? OFFSET ?"
            );
            $stmt->execute([$userId, $limit, $offset]);
            $transactions = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Get total count
            $stmt = $this->pdo->prepare(
                "SELECT COUNT(*) FROM transactions t
                 JOIN portfolios p ON t.portfolio_id = p.id
                 WHERE p.user_id = ?"
            );
            $stmt->execute([$userId]);
            $totalCount = (int) $stmt->fetchColumn();

            return [
                'success' => true,
                'transactions' => $transactions,
                'pagination' => [
                    'page' => $page,
                    'limit' => $limit,
                    'total' => $totalCount,
                    'total_pages' => ceil($totalCount / $limit),
                ],
            ];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }

    /**
     * Set PDO connection
     */
    public function setPDO(PDO $pdo): self
    {
        $this->pdo = $pdo;
        return $this;
    }
}
