"""Port of Services/UsageTracker.php.

Tracks LLM usage and costs.
"""
from __future__ import annotations

from app.contracts.usage_tracker import UsageTrackerInterface
from app.exceptions import PricingUnavailableException
from app.services.pricing_resolver import PricingResolver
from app.support.logger import error_log
from app.support.phpcompat import php_date
from app.support.phpjson import dumps


class UsageTracker(UsageTrackerInterface):
    def __init__(self, pdo=None, enabled: bool = True):
        self.pdo = pdo
        self.enabled = enabled and pdo is not None
        self._pricingResolver: PricingResolver | None = None

    def trackRequest(self, data: dict) -> None:
        """Track an API request."""
        if not self.enabled:
            return

        try:
            # Check if connection is still alive
            self.pdo.fetch_one('SELECT 1')
        except Exception:
            # Connection lost - skip tracking to avoid crashing the request
            error_log("[UsageTracker] DB connection lost, skipping usage tracking")
            return

        try:
            sql = """INSERT INTO llm_usage_transactions (
                user_id, session_id, provider, model, prompt_tokens, completion_tokens,
                total_tokens, cost_usd, response_time_ms, function_calls_count,
                status, error_message, request_metadata, created_at
            ) VALUES (
                :user_id, :session_id, :provider, :model, :prompt_tokens, :completion_tokens,
                :total_tokens, :cost_usd, :response_time_ms, :function_calls_count,
                :status, :error_message, :request_metadata, NOW()
            )"""

            inputTokens = data.get('input_tokens') if data.get('input_tokens') is not None else 0
            outputTokens = data.get('output_tokens') if data.get('output_tokens') is not None else 0
            provider = data.get('provider') if data.get('provider') is not None else 'claude'
            model = data.get('model') if data.get('model') is not None else 'claude-sonnet-4-5-20250929'

            costError = None
            try:
                costUsd = self.calculateCost(provider, model, inputTokens, outputTokens)
            except PricingUnavailableException as e:
                costUsd = None
                costError = str(e)
                error_log('❌ [UsageTracker] PRICING_ERROR: ' + costError)

            self.pdo.execute(sql, {
                ':user_id': data.get('user_id'),
                ':session_id': data.get('session_id'),
                ':provider': provider,
                ':model': model,
                ':prompt_tokens': inputTokens,
                ':completion_tokens': outputTokens,
                ':total_tokens': inputTokens + outputTokens,
                ':cost_usd': costUsd,
                ':response_time_ms': data.get('response_time_ms') if data.get('response_time_ms') is not None else 0,
                ':function_calls_count': data.get('function_calls_count') if data.get('function_calls_count') is not None else 0,
                ':status': data.get('status') if data.get('status') is not None else 'success',
                ':error_message': (
                    ((data.get('error_message') or '') + ' | PRICING_ERROR: ' + costError).strip()
                    if costError is not None
                    else data.get('error_message')
                ),
                ':request_metadata': dumps({'request_type': data.get('request_type') if data.get('request_type') is not None else 'chat'}),
            })
        except Exception as e:
            # Log but don't crash - usage tracking is not critical
            error_log("[UsageTracker] Failed to track usage: " + str(e))

    def trackFunctionCall(
        self,
        function_name: str,
        provider: str,
        execution_time_ms: int,
        success: bool,
        user_id: str | None = None,
    ) -> None:
        """Track a function call."""
        if not self.enabled:
            return

        date = php_date('Y-m-d')

        # Try to update existing record
        sql = """UPDATE llm_function_usage_stats SET
            call_count = call_count + 1,
            success_count = success_count + :success,
            error_count = error_count + :error,
            avg_execution_time_ms = (avg_execution_time_ms * call_count + :exec_time) / (call_count + 1),
            min_execution_time_ms = LEAST(min_execution_time_ms, :exec_time_min),
            max_execution_time_ms = GREATEST(max_execution_time_ms, :exec_time_max),
            last_called_at = NOW()
            WHERE user_id = :user_id AND function_name = :function_name AND date = :date"""

        rowcount = self.pdo.execute(sql, {
            ':success': 1 if success else 0,
            ':error': 0 if success else 1,
            ':exec_time': execution_time_ms,
            ':exec_time_min': execution_time_ms,
            ':exec_time_max': execution_time_ms,
            ':user_id': user_id,
            ':function_name': function_name,
            ':date': date,
        })

        # If no row was updated, insert a new one
        if rowcount == 0:
            sql = """INSERT INTO llm_function_usage_stats (
                user_id, function_name, provider, date, call_count, success_count,
                error_count, avg_execution_time_ms, min_execution_time_ms,
                max_execution_time_ms, last_called_at
            ) VALUES (
                :user_id, :function_name, :provider, :date, 1, :success,
                :error, :exec_time, :exec_time, :exec_time, NOW()
            )"""

            self.pdo.execute(sql, {
                ':user_id': user_id,
                ':function_name': function_name,
                ':provider': provider,
                ':date': date,
                ':success': 1 if success else 0,
                ':error': 0 if success else 1,
                ':exec_time': execution_time_ms,
            })

    def getUserStats(self, user_id: str, period: str | None = 'day') -> dict:
        """Get usage statistics for a user."""
        if not self.enabled:
            return {}

        dateCondition = self._getDateCondition(period)

        sql = f"""SELECT
            COUNT(*) as total_requests,
            SUM(prompt_tokens) as total_input_tokens,
            SUM(completion_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost,
            AVG(response_time_ms) as avg_response_time,
            SUM(function_calls_count) as total_function_calls
            FROM llm_usage_transactions
            WHERE user_id = :user_id {dateCondition}"""

        return self.pdo.fetch_one(sql, {':user_id': user_id}) or {}

    def getStats(self, period: str | None = 'day') -> dict:
        """Get overall usage statistics."""
        if not self.enabled:
            return {}

        dateCondition = self._getDateCondition(period)

        sql = f"""SELECT
            COUNT(*) as total_requests,
            SUM(prompt_tokens) as total_input_tokens,
            SUM(completion_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost,
            AVG(response_time_ms) as avg_response_time,
            SUM(function_calls_count) as total_function_calls,
            COUNT(DISTINCT user_id) as unique_users
            FROM llm_usage_transactions
            WHERE 1=1 {dateCondition}"""

        return self.pdo.fetch_one(sql) or {}

    def calculateCost(self, provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
        """Calculate estimated cost for tokens."""
        if self._pricingResolver is None:
            self._pricingResolver = PricingResolver(self.pdo)
        inPer1M, outPer1M = self._pricingResolver.resolve(provider)
        inputCost = (input_tokens / 1_000_000) * inPer1M
        outputCost = (output_tokens / 1_000_000) * outPer1M
        return round(inputCost + outputCost, 6)

    def _getDateCondition(self, period: str) -> str:
        """Get date condition for SQL queries."""
        return {
            'day': "AND DATE(created_at) = CURDATE()",
            'week': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
            'month': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
            'year': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)",
        }.get(period, "")
