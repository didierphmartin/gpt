"""Port of Controllers/UsageController.php.

Usage Controller

Provides access to LLM usage statistics and tracking.
"""
from __future__ import annotations

from app.services.usage_logger import UsageLogger
from app.support.phpcompat import php_intval


class UsageController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.usageLogger = UsageLogger(db, True)

    def getBalance(self, request) -> dict:
        """Get usage balance/ledger for current user."""
        userId = request['user_id']
        query = request['query']
        provider = query['provider'] if query.get('provider') is not None else None

        balance = self.usageLogger.getBalance(userId, provider)

        return {
            'success': True,
            'data': balance,
            'status_code': 200,
        }

    def getTransactions(self, request) -> dict:
        """Get transaction history for current user."""
        userId = request['user_id']
        query = request['query']

        # Parse query parameters
        filters = {}
        if 'provider' in query:
            filters['provider'] = query['provider']
        if 'date_from' in query:
            filters['date_from'] = query['date_from']
        if 'date_to' in query:
            filters['date_to'] = query['date_to']
        if 'status' in query:
            filters['status'] = query['status']

        limit = php_intval(query['limit']) if 'limit' in query else 100
        offset = php_intval(query['offset']) if 'offset' in query else 0

        # Validate limit
        if limit < 1 or limit > 1000:
            limit = 100

        transactions = self.usageLogger.getTransactions(userId, filters, limit, offset)

        return {
            'success': True,
            'data': transactions,
            'pagination': {
                'limit': limit,
                'offset': offset,
                'count': len(transactions),
            },
            'status_code': 200,
        }

    def getStats(self, request) -> dict:
        """Get aggregated statistics for current user."""
        userId = request['user_id']
        query = request['query']

        period = query['period'] if query.get('period') is not None else 'month'
        provider = query['provider'] if query.get('provider') is not None else None

        # Validate period
        if period not in ('day', 'week', 'month', 'year', 'all'):
            period = 'month'

        stats = self.usageLogger.getStats(userId, period, provider)

        return {
            'success': True,
            'data': stats,
            'period': period,
            'provider': provider,
            'status_code': 200,
        }
