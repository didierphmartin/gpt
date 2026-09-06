"""Port of Functions/PortfolioFunctions.php.

Portfolio-related LLM functions.

These functions are designed to be registered with the ToolsManager
and called by Claude during conversations.
"""
from __future__ import annotations

import math

from app.support.phpcompat import php_intval


class PortfolioFunctions:
    """Portfolio-related LLM functions."""

    def __init__(self, pdo=None):
        self.pdo = pdo

    def getAllFunctions(self) -> dict:
        """Get all functions with their handlers and schemas."""
        return {
            'get_portfolios': {
                'handler': self.getPortfolios,
                'schema': {
                    'description': 'Get all portfolios for the current user',
                    'input_schema': {
                        'type': 'object',
                        'properties': {},
                        'required': [],
                    },
                },
            },
            'get_portfolio_assets_with_discovery': {
                'handler': self.getPortfolioAssetsWithDiscovery,
                'schema': {
                    'description': 'PRIMARY FUNCTION FOR PORTFOLIO ANALYSIS - Get comprehensive portfolio holdings with current prices, values, and performance metrics. Automatically discovers the default portfolio.',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'portfolio_id': {
                                'type': 'integer',
                                'description': 'Optional specific portfolio ID. If not provided, uses default portfolio.',
                            },
                        },
                        'required': [],
                    },
                },
            },
            'get_portfolio_diversification': {
                'handler': self.getPortfolioDiversification,
                'schema': {
                    'description': 'Get portfolio diversification breakdown by asset type, sector, and currency',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'portfolio_id': {
                                'type': 'integer',
                                'description': 'Portfolio ID to analyze',
                            },
                        },
                        'required': [],
                    },
                },
            },
            'get_all_transactions': {
                'handler': self.getAllTransactions,
                'schema': {
                    'description': 'Get all transactions for the user with pagination',
                    'input_schema': {
                        'type': 'object',
                        'properties': {
                            'page': {
                                'type': 'integer',
                                'description': 'Page number (default: 1)',
                            },
                            'limit': {
                                'type': 'integer',
                                'description': 'Items per page (default: 50)',
                            },
                            'sort': {
                                'type': 'string',
                                'description': 'Sort field (default: date)',
                            },
                            'order': {
                                'type': 'string',
                                'description': 'Sort order: asc or desc (default: desc)',
                            },
                        },
                        'required': [],
                    },
                },
            },
        }

    def getPortfolios(self, params: dict, userId) -> dict:
        """Get all portfolios for a user."""
        if not self.pdo or not userId:
            return {'error': 'Database connection or user ID not available'}

        try:
            portfolios = self.pdo.fetch_all(
                "SELECT id, name, description, is_default, currency, created_at\n"
                "                 FROM portfolios WHERE user_id = ? ORDER BY is_default DESC, name ASC",
                [userId],
            )

            return {
                'success': True,
                'portfolios': portfolios,
                'count': len(portfolios),
            }
        except Exception as e:
            return {'error': str(e)}

    def getPortfolioAssetsWithDiscovery(self, params: dict, userId) -> dict:
        """Get portfolio assets with auto-discovery of default portfolio."""
        if not self.pdo or not userId:
            return {'error': 'Database connection or user ID not available'}

        try:
            portfolioId = params.get('portfolio_id') if params.get('portfolio_id') is not None else None

            # Auto-discover default portfolio if not specified
            if not portfolioId:
                default = self.pdo.fetch_one(
                    "SELECT id FROM portfolios WHERE user_id = ? AND is_default = 1 LIMIT 1",
                    [userId],
                )
                portfolioId = default.get('id') if default is not None else None

                if not portfolioId:
                    # Get first portfolio
                    first = self.pdo.fetch_one(
                        "SELECT id FROM portfolios WHERE user_id = ? ORDER BY id ASC LIMIT 1",
                        [userId],
                    )
                    portfolioId = first.get('id') if first is not None else None

            if not portfolioId:
                return {
                    'success': False,
                    'message': 'No portfolio found for user',
                    'assets': [],
                }

            # Get portfolio assets
            assets = self.pdo.fetch_all(
                "SELECT pa.*, a.name as asset_name, a.symbol, a.type as asset_type,\n"
                "                        a.exchange, a.currency\n"
                "                 FROM portfolio_assets pa\n"
                "                 JOIN assets a ON pa.asset_id = a.id\n"
                "                 WHERE pa.portfolio_id = ?\n"
                "                 ORDER BY pa.current_value DESC",
                [portfolioId],
            )

            # Calculate totals
            totalValue = 0
            totalCost = 0
            for asset in assets:
                totalValue += float(asset.get('current_value') if asset.get('current_value') is not None else 0)
                totalCost += float(asset.get('total_cost') if asset.get('total_cost') is not None else 0)

                # Calculate gain/loss
                currentValue = float(asset.get('current_value') if asset.get('current_value') is not None else 0)
                cost = float(asset.get('total_cost') if asset.get('total_cost') is not None else 0)
                asset['gain_loss'] = currentValue - cost
                asset['gain_loss_percent'] = ((currentValue - cost) / cost) * 100 if cost > 0 else 0

            return {
                'success': True,
                'portfolio_id': portfolioId,
                'assets': assets,
                'summary': {
                    'total_value': totalValue,
                    'total_cost': totalCost,
                    'total_gain_loss': totalValue - totalCost,
                    'total_gain_loss_percent': ((totalValue - totalCost) / totalCost) * 100 if totalCost > 0 else 0,
                    'asset_count': len(assets),
                },
            }
        except Exception as e:
            return {'error': str(e)}

    def getPortfolioDiversification(self, params: dict, userId) -> dict:
        """Get portfolio diversification analysis."""
        if not self.pdo or not userId:
            return {'error': 'Database connection or user ID not available'}

        try:
            portfolioId = params.get('portfolio_id') if params.get('portfolio_id') is not None else None

            # Auto-discover if not provided
            if not portfolioId:
                result = self.getPortfolioAssetsWithDiscovery({}, userId)
                portfolioId = result.get('portfolio_id') if result.get('portfolio_id') is not None else None

            if not portfolioId:
                return {'error': 'No portfolio found'}

            # Get diversification by asset type
            byType = self.pdo.fetch_all(
                "SELECT a.type as asset_type,\n"
                "                        SUM(pa.current_value) as total_value,\n"
                "                        COUNT(*) as asset_count\n"
                "                 FROM portfolio_assets pa\n"
                "                 JOIN assets a ON pa.asset_id = a.id\n"
                "                 WHERE pa.portfolio_id = ?\n"
                "                 GROUP BY a.type\n"
                "                 ORDER BY total_value DESC",
                [portfolioId],
            )

            # Get total for percentages
            total = sum(
                (float(item['total_value']) if item.get('total_value') is not None else 0)
                for item in byType
            )

            for item in byType:
                itemValue = float(item['total_value']) if item.get('total_value') is not None else 0
                item['percentage'] = (itemValue / total) * 100 if total > 0 else 0

            return {
                'success': True,
                'portfolio_id': portfolioId,
                'by_asset_type': byType,
                'total_value': total,
            }
        except Exception as e:
            return {'error': str(e)}

    def getAllTransactions(self, params: dict, userId) -> dict:
        """Get all transactions with pagination."""
        if not self.pdo or not userId:
            return {'error': 'Database connection or user ID not available'}

        try:
            page = max(1, php_intval(params.get('page') if params.get('page') is not None else 1))
            limit = min(100, max(1, php_intval(params.get('limit') if params.get('limit') is not None else 50)))
            offset = (page - 1) * limit
            sortCandidate = params.get('sort') if params.get('sort') is not None else 'date'
            sort = sortCandidate if sortCandidate in ['date', 'amount', 'type'] else 'date'
            order = 'ASC' if (params.get('order') if params.get('order') is not None else 'DESC').upper() == 'ASC' else 'DESC'

            # Get transactions
            transactions = self.pdo.fetch_all(
                "SELECT t.*, a.name as asset_name, a.symbol\n"
                "                 FROM transactions t\n"
                "                 JOIN assets a ON t.asset_id = a.id\n"
                "                 JOIN portfolios p ON t.portfolio_id = p.id\n"
                "                 WHERE p.user_id = ?\n"
                f"                 ORDER BY t.{sort} {order}\n"
                "                 LIMIT ? OFFSET ?",
                [userId, limit, offset],
            )

            # Get total count
            countRow = self.pdo.fetch_one(
                "SELECT COUNT(*) FROM transactions t\n"
                "                 JOIN portfolios p ON t.portfolio_id = p.id\n"
                "                 WHERE p.user_id = ?",
                [userId],
            )
            totalCount = php_intval(countRow[next(iter(countRow))] if countRow else 0)

            return {
                'success': True,
                'transactions': transactions,
                'pagination': {
                    'page': page,
                    'limit': limit,
                    'total': totalCount,
                    'total_pages': math.ceil(totalCount / limit),
                },
            }
        except Exception as e:
            return {'error': str(e)}

    def setPDO(self, pdo) -> 'PortfolioFunctions':
        """Set PDO connection."""
        self.pdo = pdo
        return self
