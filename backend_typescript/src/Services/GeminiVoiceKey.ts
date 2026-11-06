import { config } from '../config/env';
import { DecisionKeyResolver } from './DecisionKeyResolver';
import { LLMProviderResolver } from './LLMProviderResolver';

/**
 * The Gemini key a user's voice sessions use, found like every other provider key: the user's own
 * key, else the package's default key, else the admin's (system_llm_settings), else the server's
 * GEMINI_VOICE_API_KEY -- and none when the user's package does not allow Gemini. It stays on the
 * server: the browser only ever gets a single-use Live token minted with it.
 * Mirrors backend/src/Services/GeminiVoiceKey.php.
 */
export interface GeminiVoiceKeyConfig {
  auth: { jwtSecret: string };
  gemini_voice?: { api_key?: string };
}

export const GeminiVoiceKey = {
  async resolve(userId: number | null, cfg: GeminiVoiceKeyConfig = config): Promise<string> {
    const pkg = await DecisionKeyResolver.packageEntry(userId, 'gemini');
    if (pkg === false) return '';

    if (userId !== null && userId > 0) {
      const [userKey] = await DecisionKeyResolver.userRow(cfg.auth.jwtSecret, userId, 'gemini');
      if (userKey !== '') return userKey;
    }

    const packageKey = String(pkg.default_api_key ?? '').trim();
    if (packageKey !== '') return packageKey;

    let adminKey = '';
    try {
      adminKey = String((await LLMProviderResolver.getProviderConfig('gemini'))?.api_key ?? '').trim();
    } catch (e: any) {
      console.error('[GeminiVoiceKey] admin key lookup failed: ' + (e?.message ?? e));
    }
    if (adminKey !== '') return adminKey;

    return String(cfg.gemini_voice?.api_key ?? '').trim();
  },
};
