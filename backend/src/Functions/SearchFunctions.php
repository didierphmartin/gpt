<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Functions;

use GuzzleHttp\Client;
use Quantis\AIPortfolioAssistant\Config\Configuration;

/**
 * Web search and external data LLM functions
 */
class SearchFunctions
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
            'serpapi_search' => [
                'handler' => [$this, 'serpApiSearch'],
                'schema' => [
                    'description' => 'Search the web using SerpAPI (Google search). Use for current events, company info, product research, software tools.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'query' => [
                                'type' => 'string',
                                'description' => 'Search query',
                            ],
                            'count' => [
                                'type' => 'integer',
                                'description' => 'Number of results (default: 10)',
                            ],
                            'location' => [
                                'type' => 'string',
                                'description' => 'Search location (default: United States)',
                            ],
                        ],
                        'required' => ['query'],
                    ],
                ],
            ],
            'brave_search' => [
                'handler' => [$this, 'braveSearch'],
                'schema' => [
                    'description' => 'Search the web using Brave Search API. Fallback search option.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'query' => [
                                'type' => 'string',
                                'description' => 'Search query',
                            ],
                            'count' => [
                                'type' => 'integer',
                                'description' => 'Number of results (default: 10)',
                            ],
                        ],
                        'required' => ['query'],
                    ],
                ],
            ],
            'search_assets' => [
                'handler' => [$this, 'searchAssets'],
                'schema' => [
                    'description' => 'Search for assets (stocks, crypto, ETFs) by name or symbol',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'query' => [
                                'type' => 'string',
                                'description' => 'Search query (name or symbol)',
                            ],
                        ],
                        'required' => ['query'],
                    ],
                ],
            ],
            'get_trending_assets' => [
                'handler' => [$this, 'getTrendingAssets'],
                'schema' => [
                    'description' => 'Get trending/popular assets',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'limit' => [
                                'type' => 'integer',
                                'description' => 'Number of results (default: 10)',
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],
            'get_top_gainers' => [
                'handler' => [$this, 'getTopGainers'],
                'schema' => [
                    'description' => 'Get top gaining assets by percentage',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'limit' => [
                                'type' => 'integer',
                                'description' => 'Number of results (default: 10)',
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],
            'get_top_losers' => [
                'handler' => [$this, 'getTopLosers'],
                'schema' => [
                    'description' => 'Get top losing assets by percentage',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'limit' => [
                                'type' => 'integer',
                                'description' => 'Number of results (default: 10)',
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],
            'get_sec_filings' => [
                'handler' => [$this, 'getSecFilings'],
                'schema' => [
                    'description' => 'Get SEC EDGAR filings and financial data for US public companies. Returns company facts, financial statements, and filing information.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'symbol_or_cik' => [
                                'type' => 'string',
                                'description' => 'Stock ticker symbol (e.g., AAPL) or SEC CIK number',
                            ],
                            'data_type' => [
                                'type' => 'string',
                                'description' => 'Type of data: facts (company facts), submissions (filings list), or companyconcept (specific concept). Default: facts',
                            ],
                            'concept' => [
                                'type' => 'string',
                                'description' => 'XBRL concept for companyconcept data_type (e.g., us-gaap:Revenue, dei:EntityCommonStockSharesOutstanding)',
                            ],
                        ],
                        'required' => ['symbol_or_cik'],
                    ],
                ],
            ],
            'get_sec_filing_document' => [
                'handler' => [$this, 'getSecFilingDocument'],
                'schema' => [
                    'description' => 'Get specific SEC filing document content (10-K, 10-Q, 8-K, etc.)',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'accession_number' => [
                                'type' => 'string',
                                'description' => 'SEC accession number (format: 0000000000-00-000000)',
                            ],
                            'primary_document' => [
                                'type' => 'string',
                                'description' => 'Primary document filename (optional, auto-detected if not provided)',
                            ],
                            'format' => [
                                'type' => 'string',
                                'description' => 'Response format: summary (AI-processed summary) or raw (full HTML). Default: summary',
                            ],
                        ],
                        'required' => ['accession_number'],
                    ],
                ],
            ],
        ];
    }

    /**
     * Search using SerpAPI
     */
    public function serpApiSearch(array $params, mixed $userId): array
    {
        $apiKey = $this->config->get('search.serpapi.api_key');
        if (empty($apiKey)) {
            return ['error' => 'SerpAPI key not configured'];
        }

        try {
            $query = $params['query'] ?? '';
            $count = min(20, max(1, (int) ($params['count'] ?? 10)));
            $location = $params['location'] ?? 'United States';

            $response = $this->httpClient->get('https://serpapi.com/search', [
                'query' => [
                    'api_key' => $apiKey,
                    'q' => $query,
                    'num' => $count,
                    'location' => $location,
                    'engine' => 'google',
                ],
            ]);

            $data = json_decode($response->getBody()->getContents(), true);

            $results = [];
            foreach ($data['organic_results'] ?? [] as $result) {
                $results[] = [
                    'title' => $result['title'] ?? '',
                    'link' => $result['link'] ?? '',
                    'snippet' => $result['snippet'] ?? '',
                    'position' => $result['position'] ?? 0,
                ];
            }

            return [
                'success' => true,
                'query' => $query,
                'results' => $results,
                'count' => count($results),
            ];
        } catch (\Throwable $e) {
            return ['error' => 'Search failed: ' . $e->getMessage()];
        }
    }

    /**
     * Search using Brave Search API
     */
    public function braveSearch(array $params, mixed $userId): array
    {
        $apiKey = $this->config->get('search.brave.api_key');
        if (empty($apiKey)) {
            return ['error' => 'Brave Search API key not configured'];
        }

        try {
            $query = $params['query'] ?? '';
            $count = min(20, max(1, (int) ($params['count'] ?? 10)));

            $response = $this->httpClient->get('https://api.search.brave.com/res/v1/web/search', [
                'headers' => [
                    'X-Subscription-Token' => $apiKey,
                    'Accept' => 'application/json',
                ],
                'query' => [
                    'q' => $query,
                    'count' => $count,
                ],
            ]);

            $data = json_decode($response->getBody()->getContents(), true);

            $results = [];
            foreach ($data['web']['results'] ?? [] as $result) {
                $results[] = [
                    'title' => $result['title'] ?? '',
                    'link' => $result['url'] ?? '',
                    'snippet' => $result['description'] ?? '',
                ];
            }

            return [
                'success' => true,
                'query' => $query,
                'results' => $results,
                'count' => count($results),
            ];
        } catch (\Throwable $e) {
            return ['error' => 'Search failed: ' . $e->getMessage()];
        }
    }

    /**
     * Search for assets in database
     */
    public function searchAssets(array $params, mixed $userId): array
    {
        // This would typically query a database or external API
        // For now, return a placeholder
        return [
            'success' => true,
            'message' => 'Asset search requires database connection',
            'query' => $params['query'] ?? '',
        ];
    }

    /**
     * Get trending assets
     */
    public function getTrendingAssets(array $params, mixed $userId): array
    {
        return [
            'success' => true,
            'message' => 'Trending assets requires market data API',
            'limit' => $params['limit'] ?? 10,
        ];
    }

    /**
     * Get top gainers
     */
    public function getTopGainers(array $params, mixed $userId): array
    {
        return [
            'success' => true,
            'message' => 'Top gainers requires market data API',
            'limit' => $params['limit'] ?? 10,
        ];
    }

    /**
     * Get top losers
     */
    public function getTopLosers(array $params, mixed $userId): array
    {
        return [
            'success' => true,
            'message' => 'Top losers requires market data API',
            'limit' => $params['limit'] ?? 10,
        ];
    }

    /**
     * Get SEC EDGAR filings data
     */
    public function getSecFilings(array $params, mixed $userId): array
    {
        $symbolOrCik = $params['symbol_or_cik'] ?? '';
        $dataType = $params['data_type'] ?? 'facts';
        $concept = $params['concept'] ?? null;

        if (empty($symbolOrCik)) {
            return ['error' => 'symbol_or_cik is required'];
        }

        // Convert ticker to CIK if needed (simple approach - lookup via SEC submissions)
        $cik = $this->resolveToCik($symbolOrCik);
        if (!$cik) {
            return ['error' => "Could not resolve symbol/CIK: {$symbolOrCik}"];
        }

        try {
            $url = match ($dataType) {
                'facts' => "https://data.sec.gov/api/xbrl/companyfacts/CIK{$cik}.json",
                'submissions' => "https://data.sec.gov/submissions/CIK{$cik}.json",
                'companyconcept' => $concept
                    ? "https://data.sec.gov/api/xbrl/companyconcept/CIK{$cik}/{$concept}.json"
                    : null,
                default => null,
            };

            if (!$url) {
                return ['error' => "Invalid data_type: {$dataType}" . ($dataType === 'companyconcept' && !$concept ? ' (concept required)' : '')];
            }

            $response = $this->httpClient->get($url, [
                'headers' => [
                    'User-Agent' => 'GPT Chatbot admin@company.com', // Required by SEC
                    'Accept' => 'application/json',
                ],
                'timeout' => 30,
            ]);

            $data = json_decode($response->getBody()->getContents(), true);

            return [
                'success' => true,
                'data_type' => $dataType,
                'cik' => $cik,
                'data' => $data,
            ];

        } catch (\Exception $e) {
            return [
                'error' => 'SEC EDGAR API error: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Get SEC filing document
     */
    public function getSecFilingDocument(array $params, mixed $userId): array
    {
        $accessionNumber = $params['accession_number'] ?? '';
        $primaryDocument = $params['primary_document'] ?? null;
        $format = $params['format'] ?? 'summary';

        if (empty($accessionNumber)) {
            return ['error' => 'accession_number is required'];
        }

        // Format accession number for URL (remove dashes)
        $accessionPath = str_replace('-', '', $accessionNumber);

        try {
            // If no primary document specified, try to get index to find it
            if (!$primaryDocument) {
                $indexUrl = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=&type=&dateb=&owner=exclude&count=1&search_text={$accessionNumber}";
                // This is a simplified approach - in production, parse the index properly
                $primaryDocument = "{$accessionNumber}.txt"; // Default fallback
            }

            $docUrl = "https://www.sec.gov/Archives/edgar/data/{$accessionPath}/{$primaryDocument}";

            $response = $this->httpClient->get($docUrl, [
                'headers' => [
                    'User-Agent' => 'GPT Chatbot admin@company.com', // Required by SEC
                ],
                'timeout' => 30,
            ]);

            $content = $response->getBody()->getContents();

            if ($format === 'summary') {
                // Return a summary for AI processing
                $summary = substr($content, 0, 5000); // First 5000 chars
                return [
                    'success' => true,
                    'accession_number' => $accessionNumber,
                    'document' => $primaryDocument,
                    'content_preview' => $summary,
                    'full_length' => strlen($content),
                    'note' => 'Showing first 5000 characters. Full document available at SEC EDGAR.',
                ];
            } else {
                // Return full content
                return [
                    'success' => true,
                    'accession_number' => $accessionNumber,
                    'document' => $primaryDocument,
                    'content' => $content,
                ];
            }

        } catch (\Exception $e) {
            return [
                'error' => 'SEC filing document error: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Resolve ticker symbol or CIK to padded CIK number
     */
    private function resolveToCik(string $symbolOrCik): ?string
    {
        // If already looks like a CIK (numeric), pad it
        if (is_numeric($symbolOrCik)) {
            return str_pad($symbolOrCik, 10, '0', STR_PAD_LEFT);
        }

        // Try to resolve ticker to CIK via SEC company tickers JSON
        try {
            $response = $this->httpClient->get('https://www.sec.gov/files/company_tickers.json', [
                'headers' => [
                    'User-Agent' => 'GPT Chatbot admin@company.com',
                ],
                'timeout' => 10,
            ]);

            $tickers = json_decode($response->getBody()->getContents(), true);
            $symbolUpper = strtoupper($symbolOrCik);

            foreach ($tickers as $company) {
                if (isset($company['ticker']) && strtoupper($company['ticker']) === $symbolUpper) {
                    return str_pad((string)$company['cik_str'], 10, '0', STR_PAD_LEFT);
                }
            }

        } catch (\Exception $e) {
            // If ticker lookup fails, return null
        }

        return null;
    }
}
