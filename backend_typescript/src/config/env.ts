import dotenv from 'dotenv';
import path from 'path';

// .env lives at the project root (one level above src/ in dev, above dist/ when built).
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key} (copy .env.example to .env and fill it in)`);
  return v;
}

function intEnv(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export const config = {
  port: intEnv('PORT', 3001),

  // Main app DB (PHP env DB_*).
  database: {
    host: required('DB_HOST'),
    port: intEnv('DB_PORT', 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASS'),
  } as DbConfig,

  // Contexts DB (PHP env CTX_DB_*). PHP controllers receive THIS connection as their PDO
  // ($config['contexts_database'] ?? $config['database']), so the slice's user/prompt
  // queries run against it.
  contextsDatabase: {
    host: required('CTX_DB_HOST'),
    port: intEnv('CTX_DB_PORT', 3306),
    database: required('CTX_DB_NAME'),
    user: required('CTX_DB_USER'),
    password: required('CTX_DB_PASS'),
  } as DbConfig,

  auth: {
    jwtSecret: required('JWT_SECRET'),
    jwtExpiry: 28800, // 8h access TTL (matches PHP auth.jwt_expiry / expires_in)
    refreshExpiry: 604800, // 7d refresh TTL
    appKeySecret: process.env.APP_KEY_SECRET ?? '', // unused in this slice (no app-key auth yet)
  },

  // Scheduler cron token (PHP config['scheduler']['token']). Guards POST /api/v1/scheduler/run for
  // unauthenticated cron/external callers.
  scheduler: {
    token: process.env.SCHEDULER_TOKEN ?? '',
  },

  corsAllowOrigin: process.env.CORS_ALLOW_ORIGIN ?? '*',

  firebase: {
    // Public project id used as the ID-token `aud`/`iss` audience. Default matches the
    // frontend's firebase config (projectId: "transledgersite").
    projectId: process.env.FIREBASE_PROJECT_ID ?? 'transledgersite',
  },

  modelCatalogPath:
    process.env.MODEL_CATALOG_PATH ?? path.resolve(__dirname, '../../resources/model_catalog.json'),

  // Grok Voice (xAI Realtime API) — used for secure ephemeral token generation, keeps the API key
  // server-side. Mirrors config/ai_config.php 'grok_voice' (lines 117-124). PHP hardcodes base_url;
  // GROK_VOICE_BASE_URL is an optional override that defaults to the same value.
  grok_voice: {
    api_key: process.env.GROK_VOICE_API_KEY ?? '',
    base_url: process.env.GROK_VOICE_BASE_URL ?? 'https://api.x.ai',
    client_secrets_endpoint: '/v1/realtime/client_secrets',
    default_voice: 'Eve',
  },

  // Gemini Voice (Google Live API) — Gemini connects direct to Google; the backend only brokers the
  // key via /voice/config. Mirrors config/ai_config.php 'gemini_voice' (lines 127-131).
  gemini_voice: {
    api_key: process.env.GEMINI_VOICE_API_KEY ?? '',
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    default_voice: 'Zephyr',
  },
};
