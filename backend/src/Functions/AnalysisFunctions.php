<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Functions;

use GuzzleHttp\Client;
use Quantis\AIPortfolioAssistant\Config\Configuration;

/**
 * Financial analysis LLM functions
 */
class AnalysisFunctions
{
    private Configuration $config;
    private Client $httpClient;

    public function __construct(Configuration $config)
    {
        $this->config = $config;
        $this->httpClient = new Client(['timeout' => 30]);
    }

    /**
     * Get all functions with their handlers and schemas
     */
    public function getAllFunctions(): array
    {
        return [
            'get_analyst_ratings' => [
                'handler' => [$this, 'getAnalystRatings'],
                'schema' => [
                    'description' => 'Get analyst ratings and recommendations for a stock',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol' => [
                                'type' => 'string',
                                'description' => 'Stock symbol (e.g., AAPL)',
                            ],
                        ],
                        'required' => ['symbol'],
                    ],
                ],
            ],
            'get_financial_ratios' => [
                'handler' => [$this, 'getFinancialRatios'],
                'schema' => [
                    'description' => 'Get financial ratios for a company (P/E, P/B, ROE, etc.)',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol' => [
                                'type' => 'string',
                                'description' => 'Stock symbol',
                            ],
                        ],
                        'required' => ['symbol'],
                    ],
                ],
            ],
            'get_price_targets' => [
                'handler' => [$this, 'getPriceTargets'],
                'schema' => [
                    'description' => 'Get analyst price targets for a stock',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol' => [
                                'type' => 'string',
                                'description' => 'Stock symbol',
                            ],
                        ],
                        'required' => ['symbol'],
                    ],
                ],
            ],
            'get_company_profile' => [
                'handler' => [$this, 'getCompanyProfile'],
                'schema' => [
                    'description' => 'Get company profile and basic information',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol' => [
                                'type' => 'string',
                                'description' => 'Stock symbol',
                            ],
                        ],
                        'required' => ['symbol'],
                    ],
                ],
            ],
            'get_asset_sentiment' => [
                'handler' => [$this, 'getAssetSentiment'],
                'schema' => [
                    'description' => 'Get market sentiment for an asset based on news and social media',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol' => [
                                'type' => 'string',
                                'description' => 'Asset symbol',
                            ],
                        ],
                        'required' => ['symbol'],
                    ],
                ],
            ],
        ];
    }

    /**
     * Get analyst ratings from Financial Modeling Prep API
     */
    public function getAnalystRatings(array $params, mixed $userId): array
    {
        $apiKey = $this->config->get('financial.fmp.api_key');
        if (empty($apiKey)) {
            return ['error' => 'FMP API key not configured'];
        }

        try {
            $symbol = strtoupper($params['symbol'] ?? '');
            if (empty($symbol)) {
                return ['error' => 'Symbol is required'];
            }

            $response = $this->httpClient->get(
                "https://financialmodelingprep.com/api/v3/grade/{$symbol}",
                ['query' => ['apikey' => $apiKey]]
            );

            $data = json_decode($response->getBody()->getContents(), true);

            return [
                'success' => true,
                'symbol' => $symbol,
                'ratings' => array_slice($data, 0, 10), // Last 10 ratings
            ];
        } catch (\Throwable $e) {
            return ['error' => 'Failed to fetch analyst ratings: ' . $e->getMessage()];
        }
    }

    /**
     * Get financial ratios
     */
    public function getFinancialRatios(array $params, mixed $userId): array
    {
        $apiKey = $this->config->get('financial.fmp.api_key');
        if (empty($apiKey)) {
            return ['error' => 'FMP API key not configured'];
        }

        try {
            $symbol = strtoupper($params['symbol'] ?? '');
            if (empty($symbol)) {
                return ['error' => 'Symbol is required'];
            }

            $response = $this->httpClient->get(
                "https://financialmodelingprep.com/api/v3/ratios/{$symbol}",
                ['query' => ['apikey' => $apiKey, 'limit' => 1]]
            );

            $data = json_decode($response->getBody()->getContents(), true);

            return [
                'success' => true,
                'symbol' => $symbol,
                'ratios' => $data[0] ?? [],
            ];
        } catch (\Throwable $e) {
            return ['error' => 'Failed to fetch financial ratios: ' . $e->getMessage()];
        }
    }

    /**
     * Get price targets
     */
    public function getPriceTargets(array $params, mixed $userId): array
    {
        $apiKey = $this->config->get('financial.fmp.api_key');
        if (empty($apiKey)) {
            return ['error' => 'FMP API key not configured'];
        }

        try {
            $symbol = strtoupper($params['symbol'] ?? '');
            if (empty($symbol)) {
                return ['error' => 'Symbol is required'];
            }

            $response = $this->httpClient->get(
                "https://financialmodelingprep.com/api/v4/price-target",
                ['query' => ['apikey' => $apiKey, 'symbol' => $symbol]]
            );

            $data = json_decode($response->getBody()->getContents(), true);

            return [
                'success' => true,
                'symbol' => $symbol,
                'price_targets' => array_slice($data, 0, 10),
            ];
        } catch (\Throwable $e) {
            return ['error' => 'Failed to fetch price targets: ' . $e->getMessage()];
        }
    }

    /**
     * Get company profile
     */
    public function getCompanyProfile(array $params, mixed $userId): array
    {
        $apiKey = $this->config->get('financial.fmp.api_key');
        if (empty($apiKey)) {
            return ['error' => 'FMP API key not configured'];
        }

        try {
            $symbol = strtoupper($params['symbol'] ?? '');
            if (empty($symbol)) {
                return ['error' => 'Symbol is required'];
            }

            $response = $this->httpClient->get(
                "https://financialmodelingprep.com/api/v3/profile/{$symbol}",
                ['query' => ['apikey' => $apiKey]]
            );

            $data = json_decode($response->getBody()->getContents(), true);

            return [
                'success' => true,
                'symbol' => $symbol,
                'profile' => $data[0] ?? [],
            ];
        } catch (\Throwable $e) {
            return ['error' => 'Failed to fetch company profile: ' . $e->getMessage()];
        }
    }

    /**
     * Get asset sentiment (placeholder - would integrate with sentiment API)
     */
    public function getAssetSentiment(array $params, mixed $userId): array
    {
        $symbol = strtoupper($params['symbol'] ?? '');

        return [
            'success' => true,
            'symbol' => $symbol,
            'message' => 'Sentiment analysis requires integration with news/social APIs',
        ];
    }
}
