<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Functions;

use GuzzleHttp\Client;
use Quantis\AIPortfolioAssistant\Config\Configuration;

/**
 * Metals News functions
 * Integrates with the Metals News Service API for accessing precious and base metals news
 */
class MetalsNewsFunctions
{
    private Configuration $config;
    private Client $httpClient;
    private string $metalsNewsServiceUrl;

    public function __construct(Configuration $config)
    {
        $this->config = $config;
        $this->httpClient = new Client(['timeout' => 30]);
        $this->metalsNewsServiceUrl = $config->get('metals_news.service_url', 'http://localhost/metals/public');
    }

    /**
     * Get all functions with their handlers and schemas
     */
    public function getAllFunctions(): array
    {
        return [
            'metals_news_get_all' => [
                'handler' => [$this, 'getAllMetalsNews'],
                'schema' => [
                    'description' => 'REQUIRED for precious metals news. Get latest news about gold, silver, platinum, palladium, copper, and other metals. Use this tool when user asks about: precious metals news, gold news, silver news, metal prices, mining news, bullion, commodities metals, or any metal-related market news.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'limit' => [
                                'type' => 'integer',
                                'description' => 'Maximum number of news articles to return (1-200, default: 20)',
                                'default' => 20,
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],
            'metals_news_search' => [
                'handler' => [$this, 'searchMetalsNews'],
                'schema' => [
                    'description' => 'Search precious metals news by keyword. Use when user asks about specific metal news (e.g., "gold price news", "silver market", "copper mining news"). Searches titles and descriptions from gold, silver, platinum, palladium, and copper news sources.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'keyword' => [
                                'type' => 'string',
                                'description' => 'Search keyword or phrase (e.g., "gold", "silver prices", "copper mining", "precious metals")',
                            ],
                            'limit' => [
                                'type' => 'integer',
                                'description' => 'Maximum number of matching articles to return (1-200, default: 20)',
                                'default' => 20,
                            ],
                        ],
                        'required' => ['keyword'],
                    ],
                ],
            ],
        ];
    }

    /**
     * Get all metals news
     */
    public function getAllMetalsNews(array $params, mixed $userId): array
    {
        try {
            $limit = min(200, max(1, (int) ($params['limit'] ?? 20)));

            $response = $this->httpClient->post("{$this->metalsNewsServiceUrl}/tools/execute", [
                'json' => [
                    'tool_name' => 'get_all_metals_news',
                    'arguments' => [
                        'limit' => $limit,
                    ],
                ],
                'headers' => [
                    'Content-Type' => 'application/json',
                ],
            ]);

            $data = json_decode($response->getBody()->getContents(), true);

            if (!($data['success'] ?? false)) {
                return ['error' => $data['error'] ?? 'Failed to fetch metals news'];
            }

            // Format results for LLM
            $formattedNews = [];
            foreach ($data['news'] ?? [] as $article) {
                $formattedNews[] = [
                    'title' => $article['title'],
                    'description' => $article['description'],
                    'source' => $article['source'],
                    'category' => $article['sourceCategory'] ?? 'general',
                    'date' => $this->formatDate($article['pubDate']),
                    'url' => $article['link'],
                ];
            }

            $count = count($formattedNews);

            return [
                'success' => true,
                'count' => $count,
                'news' => $formattedNews,
                'message' => "Retrieved {$count} metals news articles",
            ];
        } catch (\Exception $e) {
            return ['error' => 'Metals news error: ' . $e->getMessage()];
        }
    }

    /**
     * Search metals news by keyword
     */
    public function searchMetalsNews(array $params, mixed $userId): array
    {
        try {
            $keyword = $params['keyword'] ?? '';
            $limit = min(200, max(1, (int) ($params['limit'] ?? 20)));

            if (empty($keyword)) {
                return ['error' => 'Keyword parameter is required'];
            }

            $response = $this->httpClient->post("{$this->metalsNewsServiceUrl}/tools/execute", [
                'json' => [
                    'tool_name' => 'search_metals_news',
                    'arguments' => [
                        'keyword' => $keyword,
                        'limit' => $limit,
                    ],
                ],
                'headers' => [
                    'Content-Type' => 'application/json',
                ],
            ]);

            $data = json_decode($response->getBody()->getContents(), true);

            if (!($data['success'] ?? false)) {
                return ['error' => $data['error'] ?? 'Failed to search metals news'];
            }

            // Format results for LLM
            $formattedNews = [];
            foreach ($data['news'] ?? [] as $article) {
                $formattedNews[] = [
                    'title' => $article['title'],
                    'description' => $article['description'],
                    'source' => $article['source'],
                    'category' => $article['sourceCategory'] ?? 'general',
                    'date' => $this->formatDate($article['pubDate']),
                    'url' => $article['link'],
                ];
            }

            $count = count($formattedNews);

            return [
                'success' => true,
                'keyword' => $keyword,
                'count' => $count,
                'news' => $formattedNews,
                'message' => $count > 0
                    ? "Found {$count} articles matching '{$keyword}'"
                    : "No articles found matching '{$keyword}'",
            ];
        } catch (\Exception $e) {
            return ['error' => 'Metals news search error: ' . $e->getMessage()];
        }
    }

    /**
     * Format ISO date to readable format
     */
    private function formatDate(string $isoDate): string
    {
        try {
            $date = new \DateTime($isoDate);
            return $date->format('M j, Y');
        } catch (\Exception $e) {
            return $isoDate;
        }
    }
}
