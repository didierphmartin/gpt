"""Port of Functions/SearchFunctions.php.

Web search and external data LLM functions.
"""
from __future__ import annotations

import httpx

from app.config_.configuration import Configuration
from app.providers._http import SHARED_SSL_CONTEXT
from app.support.phpcompat import is_numeric, php_empty, php_intval


class SearchFunctions:
    """Web search and external data LLM functions."""

    def __init__(self, config: Configuration):
        self.config = config
        self.httpClient = httpx.Client(timeout=30, verify=SHARED_SSL_CONTEXT)

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Releases this instance's httpx connection pool."""
        self.httpClient.close()

    def getAllFunctions(self) -> dict:
        """Get all functions with their handlers and schemas."""
        return {
            'serpapi_search': {
                'handler': self.serpApiSearch,
                'schema': {
                    'description': 'Search the web using SerpAPI (Google search). Use for current events, company info, product research, software tools.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'query': {
                                'type': 'string',
                                'description': 'Search query',
                            },
                            'count': {
                                'type': 'integer',
                                'description': 'Number of results (default: 10)',
                            },
                            'location': {
                                'type': 'string',
                                'description': 'Search location (default: United States)',
                            },
                        },
                        'required': ['query'],
                    },
                },
            },
            'brave_search': {
                'handler': self.braveSearch,
                'schema': {
                    'description': 'Search the web using Brave Search API. Fallback search option.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'query': {
                                'type': 'string',
                                'description': 'Search query',
                            },
                            'count': {
                                'type': 'integer',
                                'description': 'Number of results (default: 10)',
                            },
                        },
                        'required': ['query'],
                    },
                },
            },
            'search_assets': {
                'handler': self.searchAssets,
                'schema': {
                    'description': 'Search for assets (stocks, crypto, ETFs) by name or symbol',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'query': {
                                'type': 'string',
                                'description': 'Search query (name or symbol)',
                            },
                        },
                        'required': ['query'],
                    },
                },
            },
            'get_trending_assets': {
                'handler': self.getTrendingAssets,
                'schema': {
                    'description': 'Get trending/popular assets',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'limit': {
                                'type': 'integer',
                                'description': 'Number of results (default: 10)',
                            },
                        },
                        'required': [],
                    },
                },
            },
            'get_top_gainers': {
                'handler': self.getTopGainers,
                'schema': {
                    'description': 'Get top gaining assets by percentage',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'limit': {
                                'type': 'integer',
                                'description': 'Number of results (default: 10)',
                            },
                        },
                        'required': [],
                    },
                },
            },
            'get_top_losers': {
                'handler': self.getTopLosers,
                'schema': {
                    'description': 'Get top losing assets by percentage',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'limit': {
                                'type': 'integer',
                                'description': 'Number of results (default: 10)',
                            },
                        },
                        'required': [],
                    },
                },
            },
            'get_sec_filings': {
                'handler': self.getSecFilings,
                'schema': {
                    'description': 'Get SEC EDGAR filings and financial data for US public companies. Returns company facts, financial statements, and filing information.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol_or_cik': {
                                'type': 'string',
                                'description': 'Stock ticker symbol (e.g., AAPL) or SEC CIK number',
                            },
                            'data_type': {
                                'type': 'string',
                                'description': 'Type of data: facts (company facts), submissions (filings list), or companyconcept (specific concept). Default: facts',
                            },
                            'concept': {
                                'type': 'string',
                                'description': 'XBRL concept for companyconcept data_type (e.g., us-gaap:Revenue, dei:EntityCommonStockSharesOutstanding)',
                            },
                        },
                        'required': ['symbol_or_cik'],
                    },
                },
            },
            'get_sec_filing_document': {
                'handler': self.getSecFilingDocument,
                'schema': {
                    'description': 'Get specific SEC filing document content (10-K, 10-Q, 8-K, etc.)',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'accession_number': {
                                'type': 'string',
                                'description': 'SEC accession number (format: 0000000000-00-000000)',
                            },
                            'primary_document': {
                                'type': 'string',
                                'description': 'Primary document filename (optional, auto-detected if not provided)',
                            },
                            'format': {
                                'type': 'string',
                                'description': 'Response format: summary (AI-processed summary) or raw (full HTML). Default: summary',
                            },
                        },
                        'required': ['accession_number'],
                    },
                },
            },
        }

    def serpApiSearch(self, params: dict, userId) -> dict:
        """Search using SerpAPI."""
        apiKey = self.config.get('search.serpapi.api_key')
        if php_empty(apiKey):
            return {'error': 'SerpAPI key not configured'}

        try:
            query = params.get('query') if params.get('query') is not None else ''
            count = min(20, max(1, php_intval(params.get('count') if params.get('count') is not None else 10)))
            location = params.get('location') if params.get('location') is not None else 'United States'

            response = self.httpClient.get('https://serpapi.com/search', params={
                'api_key': apiKey,
                'q': query,
                'num': count,
                'location': location,
                'engine': 'google',
            })
            response.raise_for_status()

            data = response.json()

            results = []
            for result in (data.get('organic_results') or []):
                results.append({
                    'title': result.get('title') if result.get('title') is not None else '',
                    'link': result.get('link') if result.get('link') is not None else '',
                    'snippet': result.get('snippet') if result.get('snippet') is not None else '',
                    'position': result.get('position') if result.get('position') is not None else 0,
                })

            return {
                'success': True,
                'query': query,
                'results': results,
                'count': len(results),
            }
        except Exception as e:
            return {'error': f'Search failed: {e}'}

    def braveSearch(self, params: dict, userId) -> dict:
        """Search using Brave Search API."""
        apiKey = self.config.get('search.brave.api_key')
        if php_empty(apiKey):
            return {'error': 'Brave Search API key not configured'}

        try:
            query = params.get('query') if params.get('query') is not None else ''
            count = min(20, max(1, php_intval(params.get('count') if params.get('count') is not None else 10)))

            response = self.httpClient.get('https://api.search.brave.com/res/v1/web/search', headers={
                'X-Subscription-Token': apiKey,
                'Accept': 'application/json',
            }, params={
                'q': query,
                'count': count,
            })
            response.raise_for_status()

            data = response.json()

            results = []
            for result in ((data.get('web') or {}).get('results') or []):
                results.append({
                    'title': result.get('title') if result.get('title') is not None else '',
                    'link': result.get('url') if result.get('url') is not None else '',
                    'snippet': result.get('description') if result.get('description') is not None else '',
                })

            return {
                'success': True,
                'query': query,
                'results': results,
                'count': len(results),
            }
        except Exception as e:
            return {'error': f'Search failed: {e}'}

    def searchAssets(self, params: dict, userId) -> dict:
        """Search for assets in database."""
        # This would typically query a database or external API
        # For now, return a placeholder
        return {
            'success': True,
            'message': 'Asset search requires database connection',
            'query': params.get('query') if params.get('query') is not None else '',
        }

    def getTrendingAssets(self, params: dict, userId) -> dict:
        """Get trending assets."""
        return {
            'success': True,
            'message': 'Trending assets requires market data API',
            'limit': params.get('limit') if params.get('limit') is not None else 10,
        }

    def getTopGainers(self, params: dict, userId) -> dict:
        """Get top gainers."""
        return {
            'success': True,
            'message': 'Top gainers requires market data API',
            'limit': params.get('limit') if params.get('limit') is not None else 10,
        }

    def getTopLosers(self, params: dict, userId) -> dict:
        """Get top losers."""
        return {
            'success': True,
            'message': 'Top losers requires market data API',
            'limit': params.get('limit') if params.get('limit') is not None else 10,
        }

    def getSecFilings(self, params: dict, userId) -> dict:
        """Get SEC EDGAR filings data."""
        symbolOrCik = params.get('symbol_or_cik') if params.get('symbol_or_cik') is not None else ''
        dataType = params.get('data_type') if params.get('data_type') is not None else 'facts'
        concept = params.get('concept') if params.get('concept') is not None else None

        if php_empty(symbolOrCik):
            return {'error': 'symbol_or_cik is required'}

        # Convert ticker to CIK if needed (simple approach - lookup via SEC submissions)
        cik = self._resolveToCik(symbolOrCik)
        if not cik:
            return {'error': f"Could not resolve symbol/CIK: {symbolOrCik}"}

        try:
            if dataType == 'facts':
                url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
            elif dataType == 'submissions':
                url = f"https://data.sec.gov/submissions/CIK{cik}.json"
            elif dataType == 'companyconcept':
                url = f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/{concept}.json" if concept else None
            else:
                url = None

            if not url:
                suffix = ' (concept required)' if dataType == 'companyconcept' and not concept else ''
                return {'error': f"Invalid data_type: {dataType}{suffix}"}

            response = self.httpClient.get(url, headers={
                'User-Agent': 'GPT Chatbot admin@company.com',  # Required by SEC
                'Accept': 'application/json',
            }, timeout=30)
            response.raise_for_status()

            data = response.json()

            return {
                'success': True,
                'data_type': dataType,
                'cik': cik,
                'data': data,
            }
        except Exception as e:
            return {'error': f'SEC EDGAR API error: {e}'}

    def getSecFilingDocument(self, params: dict, userId) -> dict:
        """Get SEC filing document."""
        accessionNumber = params.get('accession_number') if params.get('accession_number') is not None else ''
        primaryDocument = params.get('primary_document') if params.get('primary_document') is not None else None
        format_ = params.get('format') if params.get('format') is not None else 'summary'

        if php_empty(accessionNumber):
            return {'error': 'accession_number is required'}

        # Format accession number for URL (remove dashes)
        accessionPath = accessionNumber.replace('-', '')

        try:
            # If no primary document specified, fall back to a default name
            if not primaryDocument:
                primaryDocument = f"{accessionNumber}.txt"  # Default fallback

            docUrl = f"https://www.sec.gov/Archives/edgar/data/{accessionPath}/{primaryDocument}"

            response = self.httpClient.get(docUrl, headers={
                'User-Agent': 'GPT Chatbot admin@company.com',  # Required by SEC
            }, timeout=30)
            response.raise_for_status()

            content = response.text

            if format_ == 'summary':
                # Return a summary for AI processing
                summary = content[:5000]  # First 5000 chars
                return {
                    'success': True,
                    'accession_number': accessionNumber,
                    'document': primaryDocument,
                    'content_preview': summary,
                    'full_length': len(content),
                    'note': 'Showing first 5000 characters. Full document available at SEC EDGAR.',
                }
            else:
                # Return full content
                return {
                    'success': True,
                    'accession_number': accessionNumber,
                    'document': primaryDocument,
                    'content': content,
                }
        except Exception as e:
            return {'error': f'SEC filing document error: {e}'}

    def _resolveToCik(self, symbolOrCik: str) -> str | None:
        """Resolve ticker symbol or CIK to padded CIK number."""
        # If already looks like a CIK (numeric), pad it
        if is_numeric(symbolOrCik):
            return str(symbolOrCik).rjust(10, '0')

        # Try to resolve ticker to CIK via SEC company tickers JSON
        try:
            response = self.httpClient.get('https://www.sec.gov/files/company_tickers.json', headers={
                'User-Agent': 'GPT Chatbot admin@company.com',
            }, timeout=10)
            response.raise_for_status()

            tickers = response.json()
            symbolUpper = symbolOrCik.upper()

            items = tickers.values() if isinstance(tickers, dict) else (tickers or [])
            for company in items:
                if isinstance(company, dict) and company.get('ticker') is not None and str(company['ticker']).upper() == symbolUpper:
                    return str(company['cik_str']).rjust(10, '0')
        except Exception:
            # If ticker lookup fails, return None
            pass

        return None
