"""Port of Functions/AnalysisFunctions.php.

Financial analysis LLM functions.
"""
from __future__ import annotations

import httpx

from app.config_.configuration import Configuration
from app.providers._http import SHARED_SSL_CONTEXT
from app.support.phpcompat import php_empty, php_strval


def _php_first_or_empty(data):
    """PHP `$data[0] ?? []`: a non-empty list yields its first element;
    anything else — empty list, a decoded JSON object (e.g. FMP's
    `{"Error Message": ...}`), or `None` from invalid JSON — yields `[]`.
    PHP's `[]` always JSON-encodes as `[]`, never `{}`, regardless of why
    the index was missing."""
    return data[0] if isinstance(data, list) and data else []


def _php_array_slice_10(data):
    """PHP `array_slice($data, 0, 10)`: a list keeps its first 10 elements;
    a string-keyed array (dict) keeps its first 10 items with keys intact
    (PHP `array_slice` preserves string keys); anything else — `None` from
    invalid JSON — collapses to `[]`."""
    if isinstance(data, list):
        return data[:10]
    if isinstance(data, dict):
        return dict(list(data.items())[:10])
    return []


class AnalysisFunctions:
    """Financial analysis LLM functions."""

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
            'get_analyst_ratings': {
                'handler': self.getAnalystRatings,
                'schema': {
                    'description': 'Get analyst ratings and recommendations for a stock',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol': {
                                'type': 'string',
                                'description': 'Stock symbol (e.g., AAPL)',
                            },
                        },
                        'required': ['symbol'],
                    },
                },
            },
            'get_financial_ratios': {
                'handler': self.getFinancialRatios,
                'schema': {
                    'description': 'Get financial ratios for a company (P/E, P/B, ROE, etc.)',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol': {
                                'type': 'string',
                                'description': 'Stock symbol',
                            },
                        },
                        'required': ['symbol'],
                    },
                },
            },
            'get_price_targets': {
                'handler': self.getPriceTargets,
                'schema': {
                    'description': 'Get analyst price targets for a stock',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol': {
                                'type': 'string',
                                'description': 'Stock symbol',
                            },
                        },
                        'required': ['symbol'],
                    },
                },
            },
            'get_company_profile': {
                'handler': self.getCompanyProfile,
                'schema': {
                    'description': 'Get company profile and basic information',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol': {
                                'type': 'string',
                                'description': 'Stock symbol',
                            },
                        },
                        'required': ['symbol'],
                    },
                },
            },
            'get_asset_sentiment': {
                'handler': self.getAssetSentiment,
                'schema': {
                    'description': 'Get market sentiment for an asset based on news and social media',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol': {
                                'type': 'string',
                                'description': 'Asset symbol',
                            },
                        },
                        'required': ['symbol'],
                    },
                },
            },
        }

    def getAnalystRatings(self, params: dict, userId) -> dict:
        """Get analyst ratings from Financial Modeling Prep API."""
        apiKey = self.config.get('financial.fmp.api_key')
        if php_empty(apiKey):
            return {'error': 'FMP API key not configured'}

        try:
            symbol = php_strval(params.get('symbol') if params.get('symbol') is not None else '').upper()
            if php_empty(symbol):
                return {'error': 'Symbol is required'}

            response = self.httpClient.get(
                f'https://financialmodelingprep.com/api/v3/grade/{symbol}',
                params={'apikey': apiKey},
            )
            response.raise_for_status()

            try:
                data = response.json()
            except ValueError:
                data = None

            return {
                'success': True,
                'symbol': symbol,
                'ratings': _php_array_slice_10(data),  # Last 10 ratings
            }
        except Exception as e:
            return {'error': f'Failed to fetch analyst ratings: {e}'}

    def getFinancialRatios(self, params: dict, userId) -> dict:
        """Get financial ratios."""
        apiKey = self.config.get('financial.fmp.api_key')
        if php_empty(apiKey):
            return {'error': 'FMP API key not configured'}

        try:
            symbol = php_strval(params.get('symbol') if params.get('symbol') is not None else '').upper()
            if php_empty(symbol):
                return {'error': 'Symbol is required'}

            response = self.httpClient.get(
                f'https://financialmodelingprep.com/api/v3/ratios/{symbol}',
                params={'apikey': apiKey, 'limit': 1},
            )
            response.raise_for_status()

            try:
                data = response.json()
            except ValueError:
                data = None

            return {
                'success': True,
                'symbol': symbol,
                'ratios': _php_first_or_empty(data),
            }
        except Exception as e:
            return {'error': f'Failed to fetch financial ratios: {e}'}

    def getPriceTargets(self, params: dict, userId) -> dict:
        """Get price targets."""
        apiKey = self.config.get('financial.fmp.api_key')
        if php_empty(apiKey):
            return {'error': 'FMP API key not configured'}

        try:
            symbol = php_strval(params.get('symbol') if params.get('symbol') is not None else '').upper()
            if php_empty(symbol):
                return {'error': 'Symbol is required'}

            response = self.httpClient.get(
                'https://financialmodelingprep.com/api/v4/price-target',
                params={'apikey': apiKey, 'symbol': symbol},
            )
            response.raise_for_status()

            try:
                data = response.json()
            except ValueError:
                data = None

            return {
                'success': True,
                'symbol': symbol,
                'price_targets': _php_array_slice_10(data),
            }
        except Exception as e:
            return {'error': f'Failed to fetch price targets: {e}'}

    def getCompanyProfile(self, params: dict, userId) -> dict:
        """Get company profile."""
        apiKey = self.config.get('financial.fmp.api_key')
        if php_empty(apiKey):
            return {'error': 'FMP API key not configured'}

        try:
            symbol = php_strval(params.get('symbol') if params.get('symbol') is not None else '').upper()
            if php_empty(symbol):
                return {'error': 'Symbol is required'}

            response = self.httpClient.get(
                f'https://financialmodelingprep.com/api/v3/profile/{symbol}',
                params={'apikey': apiKey},
            )
            response.raise_for_status()

            try:
                data = response.json()
            except ValueError:
                data = None

            return {
                'success': True,
                'symbol': symbol,
                'profile': _php_first_or_empty(data),
            }
        except Exception as e:
            return {'error': f'Failed to fetch company profile: {e}'}

    def getAssetSentiment(self, params: dict, userId) -> dict:
        """Get asset sentiment (placeholder - would integrate with sentiment API)."""
        symbol = php_strval(params.get('symbol') if params.get('symbol') is not None else '').upper()

        return {
            'success': True,
            'symbol': symbol,
            'message': 'Sentiment analysis requires integration with news/social APIs',
        }
