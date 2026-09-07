"""Port of Services/UsageLogger.php.

UsageLogger - Logs LLM API usage to database.

Manages two tables:
1. llm_usage_transactions - Detailed log of every API call
2. llm_usage_balance - Running totals and quotas per user/provider
"""
from __future__ import annotations

from app.db import Db
from app.exceptions import PricingUnavailableException
from app.services.pricing_resolver import PricingResolver
from app.support.logger import error_log
from app.support.phpcompat import php_date, php_round
from app.support.phpjson import dumps

# Voice pricing per second (input/output) in USD. Rates as of March 2026.
VOICE_PRICING = {
    'gemini': {
        'input': 0.00025,   # $0.00025/sec = $0.90/hour
        'output': 0.0005,   # $0.0005/sec = $1.80/hour
    },
    'grok': {
        'input': 0.0004,    # $0.0004/sec = $1.44/hour
        'output': 0.0008,   # $0.0008/sec = $2.88/hour
    },
}


class UsageLogger:
    def __init__(self, pdo=None, enabled: bool = True, connectionConfig: dict | None = None):
        self.pdo = pdo
        self.enabled = enabled and pdo is not None
        self.connectionConfig = connectionConfig
        self._pricingResolver: PricingResolver | None = None

    def _ensureConnection(self) -> None:
        """Ensure database connection is alive, reconnect if needed."""
        if not self.pdo:
            return

        try:
            # Test connection with a simple query
            self.pdo.fetch_one('SELECT 1')
        except Exception:
            # Connection lost, try to reconnect if we have config
            if self.connectionConfig:
                error_log("🔄 [UsageLogger] Reconnecting to database...")
                self.pdo = Db.connect(self.connectionConfig)
                error_log("✅ [UsageLogger] Reconnected successfully")
            else:
                raise

    def logTransaction(self, data: dict) -> int | None:
        """Log a transaction to the database.

        data: Transaction data containing:
          - user_id (int, required)
          - provider (string, required)
          - model (string, required)
          - prompt_tokens (int)
          - completion_tokens (int)
          - session_id (string, optional)
          - conversation_id (int, optional)
          - response_time_ms (int, optional)
          - status (string: success|error|timeout|rate_limited)
          - error_message (string, optional)
          - function_calls_count (int, optional)
          - functions_called (array, optional)
          - request_metadata (array, optional)
          - is_voice_request (bool, optional) - Whether this is a voice/audio request
          - audio_input_seconds (float, optional) - Duration of input audio in seconds
          - audio_output_seconds (float, optional) - Duration of output audio in seconds

        Returns: Transaction ID if successful, None otherwise.
        """
        if not self.enabled:
            return None

        try:
            # Check if connection is still alive, reconnect if needed
            self._ensureConnection()
            # Extract and validate required fields
            userId = data.get('user_id')
            provider = data.get('provider') if data.get('provider') is not None else 'claude'
            model = data.get('model') if data.get('model') is not None else 'claude-sonnet-4-5'
            promptTokens = data.get('prompt_tokens') if data.get('prompt_tokens') is not None else 0
            completionTokens = data.get('completion_tokens') if data.get('completion_tokens') is not None else 0
            totalTokens = promptTokens + completionTokens

            if not userId:
                error_log('⚠️ [UsageLogger] Missing user_id, skipping transaction log')
                return None

            # Voice request fields
            isVoiceRequest = bool(data.get('is_voice_request') if data.get('is_voice_request') is not None else False)
            audioInputSeconds = data.get('audio_input_seconds')
            audioOutputSeconds = data.get('audio_output_seconds')
            audioDurationSeconds = None

            if isVoiceRequest and (audioInputSeconds is not None or audioOutputSeconds is not None):
                audioDurationSeconds = (audioInputSeconds if audioInputSeconds is not None else 0) + \
                    (audioOutputSeconds if audioOutputSeconds is not None else 0)

            # Calculate cost (voice or token-based)
            costError = None
            if isVoiceRequest:
                costUsd = self.calculateVoiceCost(provider, audioInputSeconds if audioInputSeconds is not None else 0,
                                                   audioOutputSeconds if audioOutputSeconds is not None else 0)
            else:
                try:
                    costUsd = self.calculateCost(provider, model, promptTokens, completionTokens)
                except PricingUnavailableException as e:
                    costUsd = None  # do NOT record a misleading $0
                    costError = str(e)
                    error_log('❌ [UsageLogger] PRICING_ERROR: ' + costError)

            # Prepare JSON fields
            functionsCalled = (
                dumps(data['functions_called'])
                if isinstance(data.get('functions_called'), (dict, list)) else None
            )

            mcpToolsCalled = (
                dumps(data['mcp_tools_called'])
                if isinstance(data.get('mcp_tools_called'), (dict, list)) else None
            )

            mcpCallsCount = data.get('mcp_calls_count') if data.get('mcp_calls_count') is not None else 0

            # Debug logging for tool calls
            if functionsCalled or mcpToolsCalled:
                error_log(
                    "🔧 [UsageLogger] Tool calls - functions_called: " + (functionsCalled or 'null')
                    + ", mcp_tools_called: " + (mcpToolsCalled or 'null')
                    + ", function_calls_count: " + str(data.get('function_calls_count') if data.get('function_calls_count') is not None else 0)
                )

            requestMetadata = (
                dumps(data['request_metadata'])
                if isinstance(data.get('request_metadata'), (dict, list)) else None
            )

            # Insert transaction
            sql = """INSERT INTO llm_usage_transactions (
                user_id, session_id, conversation_id, provider, model,
                prompt_tokens, completion_tokens, total_tokens, cost_usd,
                response_time_ms, status, error_message,
                function_calls_count, functions_called, mcp_calls_count, mcp_tools_called,
                request_metadata,
                is_voice_request, audio_duration_seconds, audio_input_seconds, audio_output_seconds
            ) VALUES (
                :user_id, :session_id, :conversation_id, :provider, :model,
                :prompt_tokens, :completion_tokens, :total_tokens, :cost_usd,
                :response_time_ms, :status, :error_message,
                :function_calls_count, :functions_called, :mcp_calls_count, :mcp_tools_called,
                :request_metadata,
                :is_voice_request, :audio_duration_seconds, :audio_input_seconds, :audio_output_seconds
            )"""

            transactionId = self.pdo.insert(sql, {
                ':user_id': userId,
                ':session_id': data.get('session_id'),
                ':conversation_id': data.get('conversation_id'),
                ':provider': provider,
                ':model': model,
                ':prompt_tokens': promptTokens,
                ':completion_tokens': completionTokens,
                ':total_tokens': totalTokens,
                ':cost_usd': costUsd,
                ':response_time_ms': data.get('response_time_ms'),
                ':status': data.get('status') if data.get('status') is not None else 'success',
                ':error_message': (
                    ((data.get('error_message') or '') + ' | PRICING_ERROR: ' + costError).strip()
                    if costError is not None
                    else data.get('error_message')
                ),
                ':function_calls_count': data.get('function_calls_count') if data.get('function_calls_count') is not None else 0,
                ':functions_called': functionsCalled,
                ':mcp_calls_count': mcpCallsCount,
                ':mcp_tools_called': mcpToolsCalled,
                ':request_metadata': requestMetadata,
                ':is_voice_request': 1 if isVoiceRequest else 0,
                ':audio_duration_seconds': audioDurationSeconds,
                ':audio_input_seconds': audioInputSeconds,
                ':audio_output_seconds': audioOutputSeconds,
            })

            # Update balance ledger
            self.updateBalance(userId, provider, {
                'tokens': totalTokens,
                'cost': costUsd if costUsd is not None else 0,
                'success': (data.get('status') if data.get('status') is not None else 'success') == 'success',
                'is_voice': isVoiceRequest,
                'audio_seconds': audioDurationSeconds if audioDurationSeconds is not None else 0,
                'voice_cost': costUsd if isVoiceRequest else 0,
                'function_calls': data.get('function_calls_count') if data.get('function_calls_count') is not None else 0,
                'mcp_calls': mcpCallsCount,
            })

            logMsg = f"✅ [UsageLogger] Transaction logged: ID={transactionId}, User={userId}, Provider={provider}"
            if isVoiceRequest:
                logMsg += ", Voice=true, AudioSec=" + f"{(audioDurationSeconds if audioDurationSeconds is not None else 0):.2f}"
            else:
                logMsg += f", Tokens={totalTokens}"
            logMsg += ", Cost=UNKNOWN (PRICING_ERROR)" if costUsd is None else ", Cost=$" + f"{costUsd:.6f}"
            error_log(logMsg)

            return transactionId

        except Exception as e:
            error_log("❌ [UsageLogger] Failed to log transaction: " + str(e))
            return None

    def updateBalance(self, userId, provider: str, data: dict) -> None:
        """Update balance ledger for a user/provider.

        data: Update data (tokens, cost, success, is_voice, audio_seconds, voice_cost, function_calls, mcp_calls)
        """
        if not self.enabled or not userId:
            return

        try:
            currentMonth = php_date('Y-m')
            tokens = data.get('tokens') if data.get('tokens') is not None else 0
            cost = data.get('cost') if data.get('cost') is not None else 0.0
            isSuccess = data.get('success') if data.get('success') is not None else True
            isVoice = data.get('is_voice') if data.get('is_voice') is not None else False
            audioSeconds = data.get('audio_seconds') if data.get('audio_seconds') is not None else 0
            voiceCost = data.get('voice_cost') if data.get('voice_cost') is not None else 0
            functionCalls = data.get('function_calls') if data.get('function_calls') is not None else 0
            mcpCalls = data.get('mcp_calls') if data.get('mcp_calls') is not None else 0

            # Check if month needs reset
            self._checkMonthReset(userId, provider, currentMonth)

            # Update balance (INSERT ... ON DUPLICATE KEY UPDATE)
            sql = """INSERT INTO llm_usage_balance (
                user_id, provider,
                total_requests, successful_requests, failed_requests,
                total_function_calls, total_mcp_calls,
                total_voice_requests, total_audio_seconds, total_voice_cost_usd,
                total_tokens, total_cost_usd,
                month_requests, month_tokens, month_cost_usd,
                month_function_calls, month_mcp_calls,
                month_voice_requests, month_audio_seconds, month_voice_cost_usd,
                current_month
            ) VALUES (
                :user_id, :provider,
                1, :success, :failure,
                :func_calls, :mcp_calls,
                :voice_req, :audio_sec, :voice_cost,
                :tokens, :cost,
                1, :month_tokens, :month_cost,
                :month_func_calls, :month_mcp_calls,
                :month_voice_req, :month_audio_sec, :month_voice_cost,
                :current_month
            ) ON DUPLICATE KEY UPDATE
                total_requests = total_requests + 1,
                successful_requests = successful_requests + VALUES(successful_requests),
                failed_requests = failed_requests + VALUES(failed_requests),
                total_function_calls = total_function_calls + VALUES(total_function_calls),
                total_mcp_calls = total_mcp_calls + VALUES(total_mcp_calls),
                total_voice_requests = total_voice_requests + VALUES(total_voice_requests),
                total_audio_seconds = total_audio_seconds + VALUES(total_audio_seconds),
                total_voice_cost_usd = total_voice_cost_usd + VALUES(total_voice_cost_usd),
                total_tokens = total_tokens + VALUES(total_tokens),
                total_cost_usd = total_cost_usd + VALUES(total_cost_usd),
                month_requests = month_requests + 1,
                month_tokens = month_tokens + VALUES(month_tokens),
                month_cost_usd = month_cost_usd + VALUES(month_cost_usd),
                month_function_calls = month_function_calls + VALUES(month_function_calls),
                month_mcp_calls = month_mcp_calls + VALUES(month_mcp_calls),
                month_voice_requests = month_voice_requests + VALUES(month_voice_requests),
                month_audio_seconds = month_audio_seconds + VALUES(month_audio_seconds),
                month_voice_cost_usd = month_voice_cost_usd + VALUES(month_voice_cost_usd),
                current_month = VALUES(current_month)"""

            self.pdo.execute(sql, {
                ':user_id': userId,
                ':provider': provider,
                ':success': 1 if isSuccess else 0,
                ':failure': 0 if isSuccess else 1,
                ':func_calls': functionCalls,
                ':mcp_calls': mcpCalls,
                ':voice_req': 1 if isVoice else 0,
                ':audio_sec': audioSeconds,
                ':voice_cost': voiceCost,
                ':tokens': tokens,
                ':cost': cost,
                ':month_tokens': tokens,
                ':month_cost': cost,
                ':month_func_calls': functionCalls,
                ':month_mcp_calls': mcpCalls,
                ':month_voice_req': 1 if isVoice else 0,
                ':month_audio_sec': audioSeconds,
                ':month_voice_cost': voiceCost,
                ':current_month': currentMonth,
            })

        except Exception as e:
            error_log("❌ [UsageLogger] Failed to update balance: " + str(e))

    def _checkMonthReset(self, userId, provider: str, currentMonth: str) -> None:
        """Check if monthly counters need to be reset."""
        try:
            # Check if record exists with different month
            sql = """SELECT current_month FROM llm_usage_balance
                    WHERE user_id = :user_id AND provider = :provider"""

            result = self.pdo.fetch_one(sql, {':user_id': userId, ':provider': provider})

            # If month changed, reset monthly counters
            if result and result['current_month'] != currentMonth:
                sql = """UPDATE llm_usage_balance SET
                    month_requests = 0,
                    month_tokens = 0,
                    month_cost_usd = 0.000000,
                    month_voice_requests = 0,
                    month_audio_seconds = 0.00,
                    month_voice_cost_usd = 0.000000,
                    current_month = :current_month
                    WHERE user_id = :user_id AND provider = :provider"""

                self.pdo.execute(sql, {
                    ':current_month': currentMonth,
                    ':user_id': userId,
                    ':provider': provider,
                })

                error_log(f"🔄 [UsageLogger] Monthly counters reset for user={userId}, provider={provider}")

        except Exception as e:
            error_log("⚠️ [UsageLogger] Failed to check month reset: " + str(e))

    def calculateCost(self, provider: str, model: str, promptTokens: int, completionTokens: int) -> float:
        """Calculate cost in USD for token usage."""
        if self._pricingResolver is None:
            self._pricingResolver = PricingResolver(self.pdo)
        inPer1M, outPer1M = self._pricingResolver.resolve(provider)
        cost = (promptTokens / 1_000_000) * inPer1M + (completionTokens / 1_000_000) * outPer1M
        return php_round(cost, 6)

    def calculateVoiceCost(self, provider: str, inputSeconds: float, outputSeconds: float) -> float:
        """Calculate cost in USD for voice/audio usage.

        provider: gemini or grok.
        """
        # Get voice pricing for provider, fallback to Gemini rates
        pricing = VOICE_PRICING.get(provider) or VOICE_PRICING.get('gemini') or {'input': 0.00025, 'output': 0.0005}

        inputCost = inputSeconds * pricing['input']
        outputCost = outputSeconds * pricing['output']

        return php_round(inputCost + outputCost, 6)

    def getBalance(self, userId, provider: str | None = None) -> list | dict:
        """Get usage balance for a user."""
        if not self.enabled:
            return []

        try:
            if provider:
                sql = """SELECT * FROM llm_usage_balance
                        WHERE user_id = :user_id AND provider = :provider"""
                return self.pdo.fetch_one(sql, {':user_id': userId, ':provider': provider}) or {}
            else:
                sql = "SELECT * FROM llm_usage_balance WHERE user_id = :user_id"
                return self.pdo.fetch_all(sql, {':user_id': userId}) or []
        except Exception as e:
            error_log("❌ [UsageLogger] Failed to get balance: " + str(e))
            return []

    def getTransactions(self, userId, filters: dict | None = None, limit: int = 100, offset: int = 0) -> list:
        """Get transaction history for a user.

        filters: Optional filters (provider, date_from, date_to, status)
        """
        if not self.enabled:
            return []

        filters = filters or {}

        try:
            sql = "SELECT * FROM llm_usage_transactions WHERE user_id = :user_id"
            params = {':user_id': userId}

            # Apply filters
            if filters.get('provider') is not None:
                sql += " AND provider = :provider"
                params[':provider'] = filters['provider']

            if filters.get('date_from') is not None:
                sql += " AND created_at >= :date_from"
                params[':date_from'] = filters['date_from']

            if filters.get('date_to') is not None:
                sql += " AND created_at < :date_to"
                params[':date_to'] = filters['date_to']

            if filters.get('status') is not None:
                sql += " AND status = :status"
                params[':status'] = filters['status']

            # PyMySQL cannot bind LIMIT/OFFSET; interpolate int()-cast values.
            sql += f" ORDER BY created_at DESC LIMIT {int(limit)} OFFSET {int(offset)}"

            return self.pdo.fetch_all(sql, params) or []

        except Exception as e:
            error_log("❌ [UsageLogger] Failed to get transactions: " + str(e))
            return []

    def getStats(self, userId, period: str = 'month', provider: str | None = None) -> dict:
        """Get aggregated statistics for a user.

        period: day, week, month, year, all.
        """
        if not self.enabled:
            return {}

        try:
            dateCondition = self._getDateCondition(period)

            sql = f"""SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failed_requests,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost_usd) as total_cost,
                AVG(response_time_ms) as avg_response_time,
                MIN(response_time_ms) as min_response_time,
                MAX(response_time_ms) as max_response_time,
                SUM(function_calls_count) as total_function_calls,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as total_voice_requests,
                SUM(COALESCE(audio_duration_seconds, 0)) as total_audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as total_voice_cost
                FROM llm_usage_transactions
                WHERE user_id = :user_id {dateCondition}"""

            params = {':user_id': userId}

            if provider:
                sql += " AND provider = :provider"
                params[':provider'] = provider

            return self.pdo.fetch_one(sql, params) or {}

        except Exception as e:
            error_log("❌ [UsageLogger] Failed to get stats: " + str(e))
            return {}

    def _getDateCondition(self, period: str) -> str:
        """Get date condition for SQL queries.

        period: day, week, month, year, all.
        """
        return {
            'day': "AND DATE(created_at) = CURDATE()",
            'week': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
            'month': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
            'year': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)",
            'all': "",
        }.get(period, "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)")
