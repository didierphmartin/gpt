<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Functions;

use PDO;

/**
 * Watchlist-related LLM functions
 */
class WatchlistFunctions
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
            'get_user_watchlist' => [
                'handler' => [$this, 'getUserWatchlist'],
                'schema' => [
                    'description' => 'Get the user watchlist of tracked assets (NOT owned, just tracked for monitoring)',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => new \stdClass(),
                        'required' => [],
                    ],
                ],
            ],
            'get_watchlist_with_market_data' => [
                'handler' => [$this, 'getWatchlistWithMarketData'],
                'schema' => [
                    'description' => 'Get watchlist with current market prices, changes, and performance metrics',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => new \stdClass(),
                        'required' => [],
                    ],
                ],
            ],
            'add_to_watchlist' => [
                'handler' => [$this, 'addToWatchlist'],
                'schema' => [
                    'description' => 'Add an asset to the user watchlist',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol' => [
                                'type' => 'string',
                                'description' => 'Asset symbol (e.g., AAPL, BTC)',
                            ],
                            'name' => [
                                'type' => 'string',
                                'description' => 'Asset name',
                            ],
                            'type' => [
                                'type' => 'string',
                                'description' => 'Asset type (stock, crypto, etf, etc.)',
                            ],
                            'exchange' => [
                                'type' => 'string',
                                'description' => 'Exchange where the asset is traded',
                            ],
                            'currency' => [
                                'type' => 'string',
                                'description' => 'Currency (default: USD)',
                            ],
                        ],
                        'required' => ['symbol', 'name', 'type'],
                    ],
                ],
            ],
            'remove_from_watchlist' => [
                'handler' => [$this, 'removeFromWatchlist'],
                'schema' => [
                    'description' => 'Remove an asset from the user watchlist',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol' => [
                                'type' => 'string',
                                'description' => 'Asset symbol to remove',
                            ],
                        ],
                        'required' => ['symbol'],
                    ],
                ],
            ],
        ];
    }

    /**
     * Get user watchlist
     */
    public function getUserWatchlist(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $stmt = $this->pdo->prepare(
                "SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency
                 FROM watchlist w
                 JOIN assets a ON w.asset_id = a.id
                 WHERE w.user_id = ?
                 ORDER BY w.created_at DESC"
            );
            $stmt->execute([$userId]);
            $items = $stmt->fetchAll(PDO::FETCH_ASSOC);

            return [
                'success' => true,
                'watchlist' => $items,
                'count' => count($items),
            ];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }

    /**
     * Get watchlist with current market data
     */
    public function getWatchlistWithMarketData(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $stmt = $this->pdo->prepare(
                "SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency,
                        ap.price as current_price, ap.change_24h, ap.change_percent_24h,
                        ap.volume_24h, ap.market_cap, ap.updated_at as price_updated_at
                 FROM watchlist w
                 JOIN assets a ON w.asset_id = a.id
                 LEFT JOIN asset_prices ap ON a.id = ap.asset_id
                 WHERE w.user_id = ?
                 ORDER BY w.created_at DESC"
            );
            $stmt->execute([$userId]);
            $items = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Calculate alert price status
            foreach ($items as &$item) {
                $item['alert_triggered'] = false;
                if ($item['alert_price_above'] && $item['current_price'] >= $item['alert_price_above']) {
                    $item['alert_triggered'] = true;
                    $item['alert_type'] = 'above';
                }
                if ($item['alert_price_below'] && $item['current_price'] <= $item['alert_price_below']) {
                    $item['alert_triggered'] = true;
                    $item['alert_type'] = 'below';
                }
            }

            return [
                'success' => true,
                'watchlist' => $items,
                'count' => count($items),
            ];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }

    /**
     * Add asset to watchlist
     */
    public function addToWatchlist(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $symbol = strtoupper($params['symbol'] ?? '');
            $name = $params['name'] ?? $symbol;
            $type = $params['type'] ?? 'stock';
            $exchange = $params['exchange'] ?? null;
            $currency = $params['currency'] ?? 'USD';

            if (empty($symbol)) {
                return ['error' => 'Symbol is required'];
            }

            // Find or create asset
            $stmt = $this->pdo->prepare("SELECT id FROM assets WHERE symbol = ?");
            $stmt->execute([$symbol]);
            $asset = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$asset) {
                $stmt = $this->pdo->prepare(
                    "INSERT INTO assets (symbol, name, type, exchange, currency, created_at)
                     VALUES (?, ?, ?, ?, ?, NOW())"
                );
                $stmt->execute([$symbol, $name, $type, $exchange, $currency]);
                $assetId = $this->pdo->lastInsertId();
            } else {
                $assetId = $asset['id'];
            }

            // Check if already in watchlist
            $stmt = $this->pdo->prepare(
                "SELECT id FROM watchlist WHERE user_id = ? AND asset_id = ?"
            );
            $stmt->execute([$userId, $assetId]);

            if ($stmt->fetch()) {
                return [
                    'success' => false,
                    'message' => "{$symbol} is already in your watchlist",
                ];
            }

            // Add to watchlist
            $stmt = $this->pdo->prepare(
                "INSERT INTO watchlist (user_id, asset_id, created_at) VALUES (?, ?, NOW())"
            );
            $stmt->execute([$userId, $assetId]);

            return [
                'success' => true,
                'message' => "{$symbol} ({$name}) added to watchlist",
                'watchlist_id' => $this->pdo->lastInsertId(),
            ];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }

    /**
     * Remove asset from watchlist
     */
    public function removeFromWatchlist(array $params, mixed $userId): array
    {
        if (!$this->pdo || !$userId) {
            return ['error' => 'Database connection or user ID not available'];
        }

        try {
            $symbol = strtoupper($params['symbol'] ?? '');

            if (empty($symbol)) {
                return ['error' => 'Symbol is required'];
            }

            $stmt = $this->pdo->prepare(
                "DELETE w FROM watchlist w
                 JOIN assets a ON w.asset_id = a.id
                 WHERE w.user_id = ? AND a.symbol = ?"
            );
            $stmt->execute([$userId, $symbol]);

            if ($stmt->rowCount() > 0) {
                return [
                    'success' => true,
                    'message' => "{$symbol} removed from watchlist",
                ];
            }

            return [
                'success' => false,
                'message' => "{$symbol} was not found in your watchlist",
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
