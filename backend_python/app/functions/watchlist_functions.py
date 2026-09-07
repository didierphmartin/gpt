"""Port of Functions/WatchlistFunctions.php.

Watchlist-related LLM functions.
"""
from __future__ import annotations

from app.support.phpcompat import php_empty, php_loose_cmp as _php_loose_cmp, php_strval


def _php_ge(a, b) -> bool:
    return _php_loose_cmp(a, b) >= 0


def _php_le(a, b) -> bool:
    return _php_loose_cmp(a, b) <= 0


class WatchlistFunctions:
    """Watchlist-related LLM functions."""

    def __init__(self, pdo=None):
        self.pdo = pdo

    def getAllFunctions(self) -> dict:
        """Get all functions with their handlers and schemas."""
        return {
            'get_user_watchlist': {
                'handler': self.getUserWatchlist,
                'schema': {
                    'description': 'Get the user watchlist of tracked assets (NOT owned, just tracked for monitoring)',
                    'input_schema': {
                        'type': 'object',
                        'properties': {},
                        'required': [],
                    },
                },
            },
            'get_watchlist_with_market_data': {
                'handler': self.getWatchlistWithMarketData,
                'schema': {
                    'description': 'Get watchlist with current market prices, changes, and performance metrics',
                    'input_schema': {
                        'type': 'object',
                        'properties': {},
                        'required': [],
                    },
                },
            },
            'add_to_watchlist': {
                'handler': self.addToWatchlist,
                'schema': {
                    'description': 'Add an asset to the user watchlist',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol': {
                                'type': 'string',
                                'description': 'Asset symbol (e.g., AAPL, BTC)',
                            },
                            'name': {
                                'type': 'string',
                                'description': 'Asset name',
                            },
                            'type': {
                                'type': 'string',
                                'description': 'Asset type (stock, crypto, etf, etc.)',
                            },
                            'exchange': {
                                'type': 'string',
                                'description': 'Exchange where the asset is traded',
                            },
                            'currency': {
                                'type': 'string',
                                'description': 'Currency (default: USD)',
                            },
                        },
                        'required': ['symbol', 'name', 'type'],
                    },
                },
            },
            'remove_from_watchlist': {
                'handler': self.removeFromWatchlist,
                'schema': {
                    'description': 'Remove an asset from the user watchlist',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'symbol': {
                                'type': 'string',
                                'description': 'Asset symbol to remove',
                            },
                        },
                        'required': ['symbol'],
                    },
                },
            },
        }

    def getUserWatchlist(self, params: dict, userId) -> dict:
        """Get user watchlist."""
        if not self.pdo or php_empty(userId):
            return {'error': 'Database connection or user ID not available'}

        try:
            items = self.pdo.fetch_all(
                "SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency\n"
                "                 FROM watchlist w\n"
                "                 JOIN assets a ON w.asset_id = a.id\n"
                "                 WHERE w.user_id = ?\n"
                "                 ORDER BY w.created_at DESC",
                [userId],
            )

            return {
                'success': True,
                'watchlist': items,
                'count': len(items),
            }
        except Exception as e:
            return {'error': str(e)}

    def getWatchlistWithMarketData(self, params: dict, userId) -> dict:
        """Get watchlist with current market data."""
        if not self.pdo or php_empty(userId):
            return {'error': 'Database connection or user ID not available'}

        try:
            items = self.pdo.fetch_all(
                "SELECT w.*, a.name, a.symbol, a.type, a.exchange, a.currency,\n"
                "                        ap.price as current_price, ap.change_24h, ap.change_percent_24h,\n"
                "                        ap.volume_24h, ap.market_cap, ap.updated_at as price_updated_at\n"
                "                 FROM watchlist w\n"
                "                 JOIN assets a ON w.asset_id = a.id\n"
                "                 LEFT JOIN asset_prices ap ON a.id = ap.asset_id\n"
                "                 WHERE w.user_id = ?\n"
                "                 ORDER BY w.created_at DESC",
                [userId],
            )

            # Calculate alert price status. Comparisons use PHP loose-comparison
            # semantics (WatchlistFunctions.php:24/28) because current_price and
            # the alert_price_* columns are DECIMAL-as-string or None here, not
            # native Python numbers — see _php_loose_cmp above.
            for item in items:
                item['alert_triggered'] = False
                if not php_empty(item.get('alert_price_above')) and _php_ge(item.get('current_price'), item.get('alert_price_above')):
                    item['alert_triggered'] = True
                    item['alert_type'] = 'above'
                if not php_empty(item.get('alert_price_below')) and _php_le(item.get('current_price'), item.get('alert_price_below')):
                    item['alert_triggered'] = True
                    item['alert_type'] = 'below'

            return {
                'success': True,
                'watchlist': items,
                'count': len(items),
            }
        except Exception as e:
            return {'error': str(e)}

    def addToWatchlist(self, params: dict, userId) -> dict:
        """Add asset to watchlist."""
        if not self.pdo or php_empty(userId):
            return {'error': 'Database connection or user ID not available'}

        try:
            symbol = php_strval(params.get('symbol') if params.get('symbol') is not None else '').upper()
            name = params.get('name') if params.get('name') is not None else symbol
            type_ = params.get('type') if params.get('type') is not None else 'stock'
            exchange = params.get('exchange') if params.get('exchange') is not None else None
            currency = params.get('currency') if params.get('currency') is not None else 'USD'

            if php_empty(symbol):
                return {'error': 'Symbol is required'}

            # Find or create asset
            asset = self.pdo.fetch_one("SELECT id FROM assets WHERE symbol = ?", [symbol])

            if not asset:
                assetId = self.pdo.insert(
                    "INSERT INTO assets (symbol, name, type, exchange, currency, created_at)\n"
                    "                     VALUES (?, ?, ?, ?, ?, NOW())",
                    [symbol, name, type_, exchange, currency],
                )
            else:
                assetId = asset['id']

            # Check if already in watchlist
            existing = self.pdo.fetch_one(
                "SELECT id FROM watchlist WHERE user_id = ? AND asset_id = ?",
                [userId, assetId],
            )

            if existing:
                return {
                    'success': False,
                    'message': f"{symbol} is already in your watchlist",
                }

            # Add to watchlist
            watchlistId = self.pdo.insert(
                "INSERT INTO watchlist (user_id, asset_id, created_at) VALUES (?, ?, NOW())",
                [userId, assetId],
            )

            return {
                'success': True,
                'message': f"{symbol} ({name}) added to watchlist",
                'watchlist_id': watchlistId,
            }
        except Exception as e:
            return {'error': str(e)}

    def removeFromWatchlist(self, params: dict, userId) -> dict:
        """Remove asset from watchlist."""
        if not self.pdo or php_empty(userId):
            return {'error': 'Database connection or user ID not available'}

        try:
            symbol = php_strval(params.get('symbol') if params.get('symbol') is not None else '').upper()

            if php_empty(symbol):
                return {'error': 'Symbol is required'}

            rowCount = self.pdo.execute(
                "DELETE w FROM watchlist w\n"
                "                 JOIN assets a ON w.asset_id = a.id\n"
                "                 WHERE w.user_id = ? AND a.symbol = ?",
                [userId, symbol],
            )

            if rowCount > 0:
                return {
                    'success': True,
                    'message': f"{symbol} removed from watchlist",
                }

            return {
                'success': False,
                'message': f"{symbol} was not found in your watchlist",
            }
        except Exception as e:
            return {'error': str(e)}

    def setPDO(self, pdo) -> 'WatchlistFunctions':
        """Set PDO connection."""
        self.pdo = pdo
        return self
