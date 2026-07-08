import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * VoiceController — faithful TS mirror of src/Controllers/VoiceController.php.
 *
 * Handles voice usage tracking for Grok and Gemini Live API sessions, plus secure ephemeral-token
 * generation for client-side Grok voice connections. (The retired Hume/EVI path is NOT ported.)
 *
 *   POST /api/v1/voice/token  -> getEphemeralToken (Grok ephemeral client_secret from xAI)
 *   POST /api/v1/voice/usage  -> logUsage
 *   GET  /api/v1/voice/stats  -> getStats
 *   GET  /api/v1/voice/config -> getConfig
 *
 * Faithful-divergence notes:
 *  - The PHP getHttpClient() Guzzle factory (timeout 30, http_errors false) is replaced with Node
 *    `fetch` + an AbortController 30s timeout.
 *  - PHP delegates persistence to UsageLogger (logTransaction -> llm_usage_transactions +
 *    updateBalance -> llm_usage_balance). UsageLogger is not a standalone TS module, so the
 *    voice-only slice of it is inlined here (calculateVoiceCost / the INSERT / updateBalance /
 *    checkMonthReset), replicating PHP byte-for-byte for the voice path. There is NO `voice_usage`
 *    table in the PHP source — both tables above already exist (parity skip-DDL), so no runtime DDL
 *    or migration is created.
 */

/** PHP (float) cast semantics (bool->1/0; leading-numeric parse; NaN->0). */
function phpFloatVal(v: any): number {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

/** PHP (int) cast on a numeric-ish value (leading-integer parse; non-numeric -> 0). */
function phpIntval(v: any): number {
  if (typeof v === 'number') return Math.trunc(isNaN(v) ? 0 : v);
  const n = parseInt(String(v ?? ''), 10);
  return isNaN(n) ? 0 : n;
}

/** PHP empty(): treats null/undefined/false/0/''/'0' as empty. */
function phpEmpty(v: any): boolean {
  return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0';
}

/** PHP round($v, $precision) — half away from zero, with the pre-round-to-15-sig-digits fix. */
function phpRound(value: number, precision: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, precision);
  const scaled = parseFloat((value * f).toPrecision(15));
  return (scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)) / f;
}

// Voice pricing per second (input/output) in USD — mirrors UsageLogger::VOICE_PRICING.
const VOICE_PRICING: Record<string, { input: number; output: number }> = {
  gemini: { input: 0.00025, output: 0.0005 },
  grok: { input: 0.0004, output: 0.0008 },
};

export class VoiceController {
  /**
   * Log voice usage from frontend clients.
   * POST /api/v1/voice/usage
   */
  async logUsage(ctx: Ctx): Promise<ControllerResult> {
    try {
      const body = ctx.body ?? {};
      const userId = ctx.user_id ?? null;

      if (!userId) {
        return { success: false, error: 'Authentication required', status_code: 401 };
      }

      const provider = body.provider ?? null;
      if (!provider || !['gemini', 'grok'].includes(provider)) {
        return {
          success: false,
          error: 'Invalid or missing provider. Must be "gemini" or "grok".',
          status_code: 400,
        };
      }

      const audioInputSeconds = phpFloatVal(body.audio_input_seconds ?? 0);
      const audioOutputSeconds = phpFloatVal(body.audio_output_seconds ?? 0);

      if (audioInputSeconds <= 0 && audioOutputSeconds <= 0) {
        return {
          success: false,
          error: 'At least one of audio_input_seconds or audio_output_seconds must be > 0',
          status_code: 400,
        };
      }

      const model = body.model ?? this.getDefaultVoiceModel(provider);

      const transactionId = await this.logVoiceTransaction({
        user_id: userId,
        provider,
        model,
        session_id: body.session_id ?? null,
        status: body.status ?? 'success',
        error_message: body.error_message ?? null,
        audio_input_seconds: audioInputSeconds,
        audio_output_seconds: audioOutputSeconds,
        request_metadata: {
          voice_session: true,
          input_sample_rate: body.input_sample_rate ?? 16000,
          output_sample_rate: body.output_sample_rate ?? 24000,
        },
      });

      const cost = this.calculateVoiceCost(provider, audioInputSeconds, audioOutputSeconds);

      return {
        success: true,
        transaction_id: transactionId,
        provider,
        model,
        audio_duration_seconds: audioInputSeconds + audioOutputSeconds,
        audio_input_seconds: audioInputSeconds,
        audio_output_seconds: audioOutputSeconds,
        cost_usd: cost,
        status_code: 200,
      };
    } catch (e: any) {
      console.error('[VoiceController] Error logging voice usage: ' + (e?.message ?? e));
      return {
        success: false,
        error: 'Failed to log voice usage: ' + (e?.message ?? e),
        status_code: 500,
      };
    }
  }

  /**
   * Get voice usage statistics for the current user.
   * GET /api/v1/voice/stats
   */
  async getStats(ctx: Ctx): Promise<ControllerResult> {
    try {
      const userId = ctx.user_id ?? null;
      if (!userId) {
        return { success: false, error: 'Authentication required', status_code: 401 };
      }

      const period = (ctx.query?.period as string | undefined) ?? 'month';
      const provider = (ctx.query?.provider as string | undefined) ?? null;

      // Whitelisted SQL fragment (no user input) — safe to inject raw, mirroring PHP string interpolation.
      const dateCondition = sql.raw(this.getDateCondition(period));

      let stats: any;
      if (provider) {
        stats = (
          await sql<any>`SELECT
                COUNT(*) as total_voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,
                COALESCE(SUM(audio_input_seconds), 0) as total_input_seconds,
                COALESCE(SUM(audio_output_seconds), 0) as total_output_seconds,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(AVG(audio_duration_seconds), 0) as avg_session_seconds
            FROM llm_usage_transactions
            WHERE user_id = ${userId}
                AND is_voice_request = 1
                ${dateCondition} AND provider = ${provider}`.execute(db)
        ).rows[0];
      } else {
        stats = (
          await sql<any>`SELECT
                COUNT(*) as total_voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,
                COALESCE(SUM(audio_input_seconds), 0) as total_input_seconds,
                COALESCE(SUM(audio_output_seconds), 0) as total_output_seconds,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(AVG(audio_duration_seconds), 0) as avg_session_seconds
            FROM llm_usage_transactions
            WHERE user_id = ${userId}
                AND is_voice_request = 1
                ${dateCondition}`.execute(db)
        ).rows[0];
      }

      // Breakdown by provider — never provider-filtered (mirrors PHP: only :user_id is bound).
      const byProvider = (
        await sql<any>`SELECT
                provider,
                COUNT(*) as requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                COALESCE(SUM(cost_usd), 0) as cost
            FROM llm_usage_transactions
            WHERE user_id = ${userId}
                AND is_voice_request = 1
                ${dateCondition}
            GROUP BY provider`.execute(db)
      ).rows;

      return {
        success: true,
        period,
        stats: {
          total_voice_requests: phpIntval(stats?.total_voice_requests ?? 0),
          total_audio_seconds: phpRound(phpFloatVal(stats?.total_audio_seconds ?? 0), 2),
          total_input_seconds: phpRound(phpFloatVal(stats?.total_input_seconds ?? 0), 2),
          total_output_seconds: phpRound(phpFloatVal(stats?.total_output_seconds ?? 0), 2),
          total_cost: phpRound(phpFloatVal(stats?.total_cost ?? 0), 6),
          avg_session_seconds: phpRound(phpFloatVal(stats?.avg_session_seconds ?? 0), 2),
        },
        by_provider: byProvider.map((p: any) => ({
          provider: p.provider,
          requests: phpIntval(p.requests),
          audio_seconds: phpRound(phpFloatVal(p.audio_seconds), 2),
          cost: phpRound(phpFloatVal(p.cost), 6),
        })),
        status_code: 200,
      };
    } catch (e: any) {
      console.error('[VoiceController] Error getting voice stats: ' + (e?.message ?? e));
      return {
        success: false,
        error: 'Failed to get voice stats: ' + (e?.message ?? e),
        status_code: 500,
      };
    }
  }

  /** Get default voice model name for a provider — mirrors PHP getDefaultVoiceModel. */
  private getDefaultVoiceModel(provider: string): string {
    switch (provider) {
      case 'gemini':
        return 'gemini-2.5-flash-native-audio-preview';
      case 'grok':
        return 'grok-2-voice';
      default:
        return provider + '-voice';
    }
  }

  /** Get date condition for SQL queries — mirrors PHP getDateCondition. */
  private getDateCondition(period: string): string {
    switch (period) {
      case 'day':
        return 'AND DATE(created_at) = CURDATE()';
      case 'week':
        return 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
      case 'month':
        return 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
      case 'year':
        return 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)';
      case 'all':
        return '';
      default:
        return 'AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    }
  }

  /**
   * Generate ephemeral token for Grok Voice (xAI Realtime API).
   * POST /api/v1/voice/token — Body: { "provider": "grok" }
   */
  async getEphemeralToken(ctx: Ctx): Promise<ControllerResult> {
    try {
      const body = ctx.body ?? {};
      const userId = ctx.user_id ?? null;

      // Authentication is optional for voice token generation; the user ID is logged if available.
      const provider = body.provider ?? 'grok';

      // Currently only Grok supports ephemeral tokens.
      if (provider !== 'grok') {
        return {
          success: false,
          error: 'Ephemeral tokens are currently only supported for Grok provider',
          status_code: 400,
        };
      }

      return await this.generateGrokEphemeralToken(userId !== null ? String(userId) : null);
    } catch (e: any) {
      console.error('[VoiceController] Error generating ephemeral token: ' + (e?.message ?? e));
      return {
        success: false,
        error: 'Failed to generate ephemeral token: ' + (e?.message ?? e),
        status_code: 500,
      };
    }
  }

  /** Generate Grok ephemeral token by calling the xAI API — mirrors PHP generateGrokEphemeralToken. */
  private async generateGrokEphemeralToken(userId: string | null): Promise<ControllerResult> {
    const grokVoiceConfig: any = config.grok_voice ?? {};
    const apiKey = grokVoiceConfig.api_key ?? '';

    if (phpEmpty(apiKey)) {
      console.error('[VoiceController] Grok voice API key not configured');
      return {
        success: false,
        error: 'Grok voice API key not configured on server',
        status_code: 500,
      };
    }

    const baseUrl = grokVoiceConfig.base_url ?? 'https://api.x.ai';
    const endpoint = grokVoiceConfig.client_secrets_endpoint ?? '/v1/realtime/client_secrets';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch(baseUrl + endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({}), // Empty JSON object as per xAI docs
        signal: controller.signal,
      });
    } catch (e: any) {
      // Network / timeout error — mirrors PHP's GuzzleException branch.
      console.error('[VoiceController] HTTP error calling xAI API: ' + (e?.message ?? e));
      return {
        success: false,
        error: 'Network error while obtaining ephemeral token',
        status_code: 503,
      };
    } finally {
      clearTimeout(timer);
    }

    const statusCode = response.status;
    const text = await response.text();
    let responseBody: any = null;
    try {
      responseBody = text ? JSON.parse(text) : null;
    } catch {
      responseBody = null;
    }

    if (statusCode !== 200) {
      const errorMessage = responseBody?.error?.message ?? responseBody?.error ?? 'Unknown error';
      console.error(`[VoiceController] xAI API error: ${statusCode} - ${errorMessage}`);
      return {
        success: false,
        error: `Failed to obtain ephemeral token: ${errorMessage}`,
        status_code: statusCode,
      };
    }

    // Extract the client secret from the response.
    // xAI returns: { "value": "...", "expires_at": ... } or nested { "client_secret": { "secret": ... } }.
    const clientSecret: any = responseBody?.client_secret ?? responseBody;
    const secret =
      clientSecret?.value ?? clientSecret?.secret ?? clientSecret?.client_secret ?? null;
    const expiresAt = clientSecret?.expires_at ?? null;

    if (phpEmpty(secret)) {
      console.error('[VoiceController] No secret in xAI response: ' + JSON.stringify(responseBody));
      return {
        success: false,
        error: 'Invalid response from xAI API - no secret returned',
        status_code: 500,
      };
    }

    if (userId) {
      console.error(`[VoiceController] Generated Grok ephemeral token for user ${userId}`);
    } else {
      console.error('[VoiceController] Generated Grok ephemeral token (anonymous)');
    }

    return {
      success: true,
      provider: 'grok',
      client_secret: secret,
      expires_at: expiresAt,
      voice: grokVoiceConfig.default_voice ?? 'Aria',
      status_code: 200,
    };
  }

  /**
   * Get voice provider configuration (public info only, no API keys except gemini-brokered key).
   * GET /api/v1/voice/config — Query: ?provider=grok|gemini
   */
  async getConfig(ctx: Ctx): Promise<ControllerResult> {
    const provider = (ctx.query?.provider as string | undefined) ?? 'grok';

    const configs: Record<string, any> = {
      grok: {
        provider: 'grok',
        name: 'Grok Voice',
        voices: ['Eve', 'Ara', 'Rex', 'Sal', 'Leo'],
        voice_descriptions: {
          Eve: 'Female, energetic and upbeat (default)',
          Ara: 'Female, warm and friendly',
          Rex: 'Male, confident and clear',
          Sal: 'Neutral, smooth and balanced',
          Leo: 'Male, authoritative and strong',
        },
        default_voice: config.grok_voice?.default_voice ?? 'Eve',
        supports_ephemeral_token: true,
        websocket_url: 'wss://api.x.ai/v1/realtime',
      },
      gemini: {
        provider: 'gemini',
        name: 'Gemini Voice',
        voices: ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'],
        default_voice: config.gemini_voice?.default_voice ?? 'Zephyr',
        model: config.gemini_voice?.model ?? 'gemini-2.5-flash-native-audio-preview',
        supports_ephemeral_token: false, // Gemini uses different auth
      },
    };

    if (!(provider in configs)) {
      return { success: false, error: 'Unknown voice provider', status_code: 400 };
    }

    // Gemini has no ephemeral-token endpoint, so a browser client needs the raw key to open a Live
    // session. Only expose it to JWT users or to app keys carrying the 'voice:config' scope.
    if (provider === 'gemini') {
      const authType = ctx.auth_type ?? null;
      const scopes: any[] = (ctx as any).app_key_scopes ?? [];
      const mayReadKey = authType !== 'app_key' || (Array.isArray(scopes) && scopes.includes('voice:config'));
      if (mayReadKey) {
        configs.gemini.api_key = config.gemini_voice?.api_key ?? null;
      }
    }

    return {
      success: true,
      config: configs[provider],
      status_code: 200,
    };
  }

  // ─── internals (inlined UsageLogger voice slice) ───────────────────────────

  /** Calculate cost in USD for voice/audio usage — mirrors UsageLogger::calculateVoiceCost. */
  private calculateVoiceCost(provider: string, inputSeconds: number, outputSeconds: number): number {
    const pricing = VOICE_PRICING[provider] ?? VOICE_PRICING['gemini'] ?? { input: 0.00025, output: 0.0005 };
    const inputCost = inputSeconds * pricing.input;
    const outputCost = outputSeconds * pricing.output;
    return phpRound(inputCost + outputCost, 6);
  }

  /**
   * Insert a voice transaction into llm_usage_transactions + update the balance ledger.
   * Mirrors UsageLogger::logTransaction for the is_voice_request=true path (returns the new id, or
   * null on DB failure — matching PHP, where logUsage still returns success with transaction_id null).
   */
  private async logVoiceTransaction(data: {
    user_id: number | string;
    provider: string;
    model: string;
    session_id: string | null;
    status: string;
    error_message: string | null;
    audio_input_seconds: number;
    audio_output_seconds: number;
    request_metadata: Record<string, any>;
  }): Promise<number | null> {
    try {
      const provider = data.provider;
      const model = data.model;
      const audioInputSeconds = data.audio_input_seconds;
      const audioOutputSeconds = data.audio_output_seconds;
      const audioDurationSeconds = audioInputSeconds + audioOutputSeconds;

      const costUsd = this.calculateVoiceCost(provider, audioInputSeconds, audioOutputSeconds);
      const requestMetadata = JSON.stringify(data.request_metadata);
      const isSuccess = (data.status ?? 'success') === 'success';

      const res = await sql`INSERT INTO llm_usage_transactions (
                user_id, session_id, conversation_id, provider, model,
                prompt_tokens, completion_tokens, total_tokens, cost_usd,
                response_time_ms, status, error_message,
                function_calls_count, functions_called, mcp_calls_count, mcp_tools_called,
                request_metadata,
                is_voice_request, audio_duration_seconds, audio_input_seconds, audio_output_seconds
            ) VALUES (
                ${data.user_id}, ${data.session_id}, ${null}, ${provider}, ${model},
                ${0}, ${0}, ${0}, ${costUsd},
                ${null}, ${data.status ?? 'success'}, ${data.error_message},
                ${0}, ${null}, ${0}, ${null},
                ${requestMetadata},
                ${1}, ${audioDurationSeconds}, ${audioInputSeconds}, ${audioOutputSeconds}
            )`.execute(db);

      const transactionId = Number((res as any).insertId ?? 0);

      // Update balance ledger (own try/catch — a failure here does not affect the returned id).
      await this.updateBalance(data.user_id, provider, {
        tokens: 0,
        cost: costUsd,
        success: isSuccess,
        is_voice: true,
        audio_seconds: audioDurationSeconds,
        voice_cost: costUsd,
        function_calls: 0,
        mcp_calls: 0,
      });

      return transactionId;
    } catch (e: any) {
      console.error('[VoiceController] Failed to log transaction: ' + (e?.message ?? e));
      return null;
    }
  }

  /** Update the running balance ledger — mirrors UsageLogger::updateBalance. */
  private async updateBalance(
    userId: number | string,
    provider: string,
    d: {
      tokens: number;
      cost: number;
      success: boolean;
      is_voice: boolean;
      audio_seconds: number;
      voice_cost: number;
      function_calls: number;
      mcp_calls: number;
    }
  ): Promise<void> {
    if (!userId) return;
    try {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const tokens = d.tokens;
      const cost = d.cost;
      const success = d.success ? 1 : 0;
      const failure = d.success ? 0 : 1;
      const voiceReq = d.is_voice ? 1 : 0;
      const audioSeconds = d.audio_seconds;
      const voiceCost = d.voice_cost;
      const functionCalls = d.function_calls;
      const mcpCalls = d.mcp_calls;

      await this.checkMonthReset(userId, provider, currentMonth);

      await sql`INSERT INTO llm_usage_balance (
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
                ${userId}, ${provider},
                1, ${success}, ${failure},
                ${functionCalls}, ${mcpCalls},
                ${voiceReq}, ${audioSeconds}, ${voiceCost},
                ${tokens}, ${cost},
                1, ${tokens}, ${cost},
                ${functionCalls}, ${mcpCalls},
                ${voiceReq}, ${audioSeconds}, ${voiceCost},
                ${currentMonth}
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
                current_month = VALUES(current_month)`.execute(db);
    } catch (e: any) {
      console.error('[VoiceController] Failed to update balance: ' + (e?.message ?? e));
    }
  }

  /** Reset monthly counters if the stored month differs — mirrors UsageLogger::checkMonthReset. */
  private async checkMonthReset(userId: number | string, provider: string, currentMonth: string): Promise<void> {
    try {
      const row = (
        await sql<{ current_month: string | null }>`SELECT current_month FROM llm_usage_balance
                    WHERE user_id = ${userId} AND provider = ${provider}`.execute(db)
      ).rows[0];

      if (row && row.current_month !== currentMonth) {
        await sql`UPDATE llm_usage_balance SET
                    month_requests = 0,
                    month_tokens = 0,
                    month_cost_usd = 0.000000,
                    month_voice_requests = 0,
                    month_audio_seconds = 0.00,
                    month_voice_cost_usd = 0.000000,
                    current_month = ${currentMonth}
                    WHERE user_id = ${userId} AND provider = ${provider}`.execute(db);
      }
    } catch (e: any) {
      console.error('[VoiceController] Failed to check month reset: ' + (e?.message ?? e));
    }
  }
}
