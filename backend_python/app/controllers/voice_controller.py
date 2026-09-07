"""Port of Controllers/VoiceController.php (18-463).

Voice Controller

Handles voice usage tracking for Grok and Gemini Live API sessions.
Frontend clients report voice session usage to this endpoint.
Also provides secure ephemeral token generation for client-side voice
connections.
"""
from __future__ import annotations

import httpx

from app.providers._http import SHARED_SSL_CONTEXT
from app.services.usage_logger import UsageLogger
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_floatval, php_intval, php_round, php_strval, php_values
from app.support.phpjson import php_json_encode


class VoiceController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        contextsDb = config.get('contexts_database') if config.get('contexts_database') is not None \
            else config.get('database')
        self.usageLogger = UsageLogger(db, True, contextsDb)
        self._httpClient: httpx.Client | None = None

    # ─── getHttpClient (PHP 36-45) ──────────────────────────────────────────

    def getHttpClient(self) -> httpx.Client:
        """Lazy init, like PHP's cached Guzzle client. A fresh VoiceController
        is instantiated per HTTP request (main.py), so caching for the
        lifetime of one request and closing right after use (see
        generateGrokEphemeralToken) keeps every httpx.Client scoped + closed
        (constraints.md) while still matching PHP's structure."""
        if self._httpClient is None:
            self._httpClient = httpx.Client(timeout=30.0, verify=SHARED_SSL_CONTEXT)
        return self._httpClient

    # ─── logUsage (PHP 61-142) ──────────────────────────────────────────────

    def logUsage(self, request) -> dict:
        try:
            body = request['body'] if request.get('body') is not None else {}
            userId = request.get('user_id')

            if not userId:
                return {'success': False, 'error': 'Authentication required', 'status_code': 401}

            provider = body.get('provider')
            if not provider or provider not in ('gemini', 'grok'):
                return {
                    'success': False,
                    'error': 'Invalid or missing provider. Must be "gemini" or "grok".',
                    'status_code': 400,
                }

            audioInputSeconds = php_floatval(body['audio_input_seconds'] if body.get('audio_input_seconds') is not None else 0)
            audioOutputSeconds = php_floatval(body['audio_output_seconds'] if body.get('audio_output_seconds') is not None else 0)

            if audioInputSeconds <= 0 and audioOutputSeconds <= 0:
                return {
                    'success': False,
                    'error': 'At least one of audio_input_seconds or audio_output_seconds must be > 0',
                    'status_code': 400,
                }

            model = body['model'] if body.get('model') is not None else self.getDefaultVoiceModel(provider)

            transactionId = self.usageLogger.logTransaction({
                'user_id': userId,
                'provider': provider,
                'model': model,
                'session_id': body.get('session_id'),
                'prompt_tokens': 0,
                'completion_tokens': 0,
                'status': body['status'] if body.get('status') is not None else 'success',
                'error_message': body.get('error_message'),
                'is_voice_request': True,
                'audio_input_seconds': audioInputSeconds,
                'audio_output_seconds': audioOutputSeconds,
                'request_metadata': {
                    'voice_session': True,
                    'input_sample_rate': body['input_sample_rate'] if body.get('input_sample_rate') is not None else 16000,
                    'output_sample_rate': body['output_sample_rate'] if body.get('output_sample_rate') is not None else 24000,
                },
            })

            cost = self.usageLogger.calculateVoiceCost(provider, audioInputSeconds, audioOutputSeconds)

            return {
                'success': True,
                'transaction_id': transactionId,
                'provider': provider,
                'model': model,
                'audio_duration_seconds': audioInputSeconds + audioOutputSeconds,
                'audio_input_seconds': audioInputSeconds,
                'audio_output_seconds': audioOutputSeconds,
                'cost_usd': cost,
                'status_code': 200,
            }

        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            error_log(f"❌ [VoiceController] Error logging voice usage: {e}")
            return {'success': False, 'error': f'Failed to log voice usage: {e}', 'status_code': 500}

    # ─── getStats (PHP 147-235) ─────────────────────────────────────────────

    def getStats(self, request) -> dict:
        try:
            userId = request.get('user_id')

            if not userId:
                return {'success': False, 'error': 'Authentication required', 'status_code': 401}

            query = request['query'] if request.get('query') is not None else {}
            period = query['period'] if query.get('period') is not None else 'month'
            provider = query.get('provider')

            dateCondition = self.getDateCondition(period)

            sql = (
                "SELECT\n"
                "                COUNT(*) as total_voice_requests,\n"
                "                COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,\n"
                "                COALESCE(SUM(audio_input_seconds), 0) as total_input_seconds,\n"
                "                COALESCE(SUM(audio_output_seconds), 0) as total_output_seconds,\n"
                "                COALESCE(SUM(cost_usd), 0) as total_cost,\n"
                "                COALESCE(AVG(audio_duration_seconds), 0) as avg_session_seconds\n"
                "            FROM llm_usage_transactions\n"
                "            WHERE user_id = :user_id\n"
                "                AND is_voice_request = 1\n"
                f"                {dateCondition}"
            )

            params = {':user_id': userId}

            if provider:
                sql += " AND provider = :provider"
                params[':provider'] = provider

            stats = self.db.fetch_one(sql, params) or {}

            breakdownSql = (
                "SELECT\n"
                "                provider,\n"
                "                COUNT(*) as requests,\n"
                "                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,\n"
                "                COALESCE(SUM(cost_usd), 0) as cost\n"
                "            FROM llm_usage_transactions\n"
                "            WHERE user_id = :user_id\n"
                "                AND is_voice_request = 1\n"
                f"                {dateCondition}\n"
                "            GROUP BY provider"
            )

            byProvider = self.db.fetch_all(breakdownSql, {':user_id': userId}) or []

            return {
                'success': True,
                'period': period,
                'stats': {
                    'total_voice_requests': php_intval(stats['total_voice_requests'] if stats.get('total_voice_requests') is not None else 0),
                    'total_audio_seconds': php_round(php_floatval(stats['total_audio_seconds'] if stats.get('total_audio_seconds') is not None else 0), 2),
                    'total_input_seconds': php_round(php_floatval(stats['total_input_seconds'] if stats.get('total_input_seconds') is not None else 0), 2),
                    'total_output_seconds': php_round(php_floatval(stats['total_output_seconds'] if stats.get('total_output_seconds') is not None else 0), 2),
                    'total_cost': php_round(php_floatval(stats['total_cost'] if stats.get('total_cost') is not None else 0), 6),
                    'avg_session_seconds': php_round(php_floatval(stats['avg_session_seconds'] if stats.get('avg_session_seconds') is not None else 0), 2),
                },
                'by_provider': [
                    {
                        'provider': p['provider'],
                        'requests': php_intval(p['requests']),
                        'audio_seconds': php_round(php_floatval(p['audio_seconds']), 2),
                        'cost': php_round(php_floatval(p['cost']), 6),
                    }
                    for p in byProvider
                ],
                'status_code': 200,
            }

        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            error_log(f"❌ [VoiceController] Error getting voice stats: {e}")
            return {'success': False, 'error': f'Failed to get voice stats: {e}', 'status_code': 500}

    # ─── getDefaultVoiceModel (PHP 240-247) ─────────────────────────────────

    def getDefaultVoiceModel(self, provider: str) -> str:
        return {
            'gemini': 'gemini-2.5-flash-native-audio-preview',
            'grok': 'grok-2-voice',
        }.get(provider, provider + '-voice')

    # ─── getDateCondition (PHP 252-262) ─────────────────────────────────────

    def getDateCondition(self, period: str) -> str:
        return {
            'day': "AND DATE(created_at) = CURDATE()",
            'week': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
            'month': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
            'year': "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)",
            'all': "",
        }.get(period, "AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)")

    # ─── getEphemeralToken (PHP 282-312) ────────────────────────────────────

    def getEphemeralToken(self, request) -> dict:
        try:
            body = request['body'] if request.get('body') is not None else {}
            userId = request.get('user_id')

            # Authentication is optional for voice token generation, but we
            # log the user ID if available for tracking.
            provider = body['provider'] if body.get('provider') is not None else 'grok'

            if provider != 'grok':
                return {
                    'success': False,
                    'error': 'Ephemeral tokens are currently only supported for Grok provider',
                    'status_code': 400,
                }

            return self.generateGrokEphemeralToken(php_strval(userId) if userId is not None else None)

        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            error_log(f"❌ [VoiceController] Error generating ephemeral token: {e}")
            return {'success': False, 'error': f'Failed to generate ephemeral token: {e}', 'status_code': 500}

    # ─── generateGrokEphemeralToken (PHP 317-398) ───────────────────────────

    def generateGrokEphemeralToken(self, userId: str | None) -> dict:
        grokVoiceConfig = self.config.get('grok_voice') if isinstance(self.config.get('grok_voice'), dict) else {}
        apiKey = grokVoiceConfig['api_key'] if grokVoiceConfig.get('api_key') is not None else ''

        if php_empty(apiKey):
            error_log("❌ [VoiceController] Grok voice API key not configured")
            return {'success': False, 'error': 'Grok voice API key not configured on server', 'status_code': 500}

        baseUrl = grokVoiceConfig['base_url'] if grokVoiceConfig.get('base_url') is not None else 'https://api.x.ai'
        endpoint = grokVoiceConfig['client_secrets_endpoint'] if grokVoiceConfig.get('client_secrets_endpoint') is not None \
            else '/v1/realtime/client_secrets'

        client = self.getHttpClient()
        try:
            try:
                response = client.post(
                    baseUrl + endpoint,
                    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey},
                    json={},  # empty JSON object, as per xAI docs
                )
            except httpx.RequestError as e:
                error_log(f"❌ [VoiceController] HTTP error calling xAI API: {e}")
                return {'success': False, 'error': 'Network error while obtaining ephemeral token', 'status_code': 503}

            statusCode = response.status_code
            try:
                responseBody = response.json()
            except ValueError:
                responseBody = None
            if not isinstance(responseBody, dict):
                responseBody = {}

            if statusCode != 200:
                errorObj = responseBody.get('error')
                if isinstance(errorObj, dict) and errorObj.get('message') is not None:
                    errorMessage = errorObj['message']
                elif errorObj is not None:
                    errorMessage = errorObj
                else:
                    errorMessage = 'Unknown error'
                error_log(f"❌ [VoiceController] xAI API error: {statusCode} - {errorMessage}")
                return {
                    'success': False,
                    'error': f'Failed to obtain ephemeral token: {errorMessage}',
                    'status_code': statusCode,
                }

            # xAI returns { "value": "...", "expires_at": ... } or nested
            # { "client_secret": { "secret": "...", "expires_at": "..." } }.
            clientSecret = responseBody['client_secret'] if responseBody.get('client_secret') is not None else responseBody
            if isinstance(clientSecret, dict):
                secret = clientSecret['value'] if clientSecret.get('value') is not None else (
                    clientSecret['secret'] if clientSecret.get('secret') is not None else (
                        clientSecret['client_secret'] if clientSecret.get('client_secret') is not None else None
                    )
                )
                expiresAt = clientSecret.get('expires_at')
            else:
                secret = None
                expiresAt = None

            if php_empty(secret):
                error_log(f"❌ [VoiceController] No secret in xAI response: {php_json_encode(responseBody)}")
                return {'success': False, 'error': 'Invalid response from xAI API - no secret returned', 'status_code': 500}

            if userId:
                error_log(f"✅ [VoiceController] Generated Grok ephemeral token for user {userId}")
            else:
                error_log("✅ [VoiceController] Generated Grok ephemeral token (anonymous)")

            return {
                'success': True,
                'provider': 'grok',
                'client_secret': secret,
                'expires_at': expiresAt,
                'voice': grokVoiceConfig['default_voice'] if grokVoiceConfig.get('default_voice') is not None else 'Aria',
                'status_code': 200,
            }
        finally:
            client.close()
            self._httpClient = None

    # ─── getConfig (PHP 406-462) ─────────────────────────────────────────────

    def getConfig(self, request) -> dict:
        query = request['query'] if request.get('query') is not None else {}
        provider = query['provider'] if query.get('provider') is not None else 'grok'

        configs = {
            'grok': {
                'provider': 'grok',
                'name': 'Grok Voice',
                'voices': ['Eve', 'Ara', 'Rex', 'Sal', 'Leo'],
                'voice_descriptions': {
                    'Eve': 'Female, energetic and upbeat (default)',
                    'Ara': 'Female, warm and friendly',
                    'Rex': 'Male, confident and clear',
                    'Sal': 'Neutral, smooth and balanced',
                    'Leo': 'Male, authoritative and strong',
                },
                'default_voice': (
                    self.config['grok_voice']['default_voice']
                    if isinstance(self.config.get('grok_voice'), dict) and self.config['grok_voice'].get('default_voice') is not None
                    else 'Eve'
                ),
                'supports_ephemeral_token': True,
                'websocket_url': 'wss://api.x.ai/v1/realtime',
            },
            'gemini': {
                'provider': 'gemini',
                'name': 'Gemini Voice',
                'voices': ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'],
                'default_voice': (
                    self.config['gemini_voice']['default_voice']
                    if isinstance(self.config.get('gemini_voice'), dict) and self.config['gemini_voice'].get('default_voice') is not None
                    else 'Zephyr'
                ),
                'model': (
                    self.config['gemini_voice']['model']
                    if isinstance(self.config.get('gemini_voice'), dict) and self.config['gemini_voice'].get('model') is not None
                    else 'gemini-2.5-flash-native-audio-preview'
                ),
                'supports_ephemeral_token': False,  # Gemini uses different auth
            },
        }

        if provider not in configs:
            return {'success': False, 'error': 'Unknown voice provider', 'status_code': 400}

        # Gemini has no ephemeral-token endpoint, so a browser client needs the
        # raw key to open a Live session. Only expose it to JWT users or to app
        # keys that explicitly carry the 'voice:config' scope (interim brokering
        # until per-user provider keys / login are in place).
        if provider == 'gemini':
            authType = request.get('auth_type')
            rawScopes = request.get('app_key_scopes')
            if rawScopes is None:
                scopes = []
            elif isinstance(rawScopes, dict):
                scopes = php_values(rawScopes)
            elif isinstance(rawScopes, list):
                scopes = rawScopes
            else:
                scopes = [rawScopes]
            mayReadKey = (authType != 'app_key') or ('voice:config' in scopes)
            if mayReadKey:
                gemini = self.config.get('gemini_voice')
                configs['gemini']['api_key'] = gemini.get('api_key') if isinstance(gemini, dict) else None

        return {'success': True, 'config': configs[provider], 'status_code': 200}
