"""Mirror of backend/config/load_env.php + backend/config/ai_config.php.

Env resolution: backend_python/.env if present, else ../backend/.env. Real
environment variables always win (dotenv does not override).
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent            # backend_python/
PHP_BACKEND = ROOT.parent / 'backend'                    # ../backend

REQUIRED = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS',
            'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS',
            'JWT_SECRET', 'APP_KEY_SECRET']


class ConfigError(RuntimeError):
    pass


def default_env_file() -> str | None:
    own = ROOT / '.env'
    if own.is_file():
        return str(own)
    php = PHP_BACKEND / '.env'
    return str(php) if php.is_file() else None


def load_env(env_file: str | None) -> None:
    if env_file:
        load_dotenv(env_file, override=False)
    missing = [k for k in REQUIRED if os.environ.get(k, '') == '']
    if missing:
        raise ConfigError(
            'Missing required env vars: ' + ', '.join(missing)
            + '. Copy backend/.env.example to backend/.env and fill it in.'
        )


def _e(key: str, default: str = '') -> str:
    return os.environ.get(key, default)


def _db(prefix: str) -> dict:
    return {
        'host': _e(f'{prefix}_HOST'),
        'database': _e(f'{prefix}_NAME'),
        'username': _e(f'{prefix}_USER'),
        'password': _e(f'{prefix}_PASS'),
        'charset': 'utf8mb4',
    }


def load_config(env_file: str | None = '__default__') -> dict:
    """Build the config dict. env_file=None skips dotenv (tests); default picks .env."""
    load_env(default_env_file() if env_file == '__default__' else env_file)
    return {
        'parallel_skill_timeout_ms': 300000,
        'search': {
            'serpapi': {'api_key': _e('SERPAPI_KEY'), 'base_url': 'https://serpapi.com/search',
                        'engine': 'google', 'max_results': 20},
            'scrapingdog': {'api_key': _e('SCRAPINGDOG_KEY'), 'base_url': 'https://api.scrapingdog.com/google'},
            'brave': {'api_key': _e('BRAVE_KEY'), 'base_url': 'https://api.search.brave.com/res/v1',
                      'max_results': 20},
        },
        'metals_news': {'service_url': 'http://localhost/metals/public'},
        'financial': {'fmp': {'api_key': _e('FMP_KEY'),
                              'base_url': 'https://financialmodelingprep.com/api/v3'}},
        'sse': {'enabled': True, 'hub_url': None},
        'tracking': {'enabled': True, 'track_costs': True},
        'debug': False,
        'default_provider': 'kimi',
        'max_recursion_depth': 10,
        'database': _db('DB'),
        'login_db': {
            'host': _e('LOGIN_DB_HOST') or _e('DB_HOST'),
            'database': _e('LOGIN_DB_NAME') or 'netfo587_login',
            'username': _e('LOGIN_DB_USER'),
            'password': _e('LOGIN_DB_PASS'),
        },
        'contexts_database': _db('CTX_DB'),
        'video_editor_database': _db('VE_DB'),
        'login_database': _db('LOGIN_DB'),
        'auth': {
            'jwt_secret': _e('JWT_SECRET'),
            'jwt_expiry': 28800,
            'refresh_expiry': 604800,
            'app_key_secret': _e('APP_KEY_SECRET'),
            'login_jwt_secret': _e('LOGIN_JWT_SECRET'),
        },
        'hume_evi': {
            'api_key': _e('HUME_API_KEY'), 'base_url': 'https://api.hume.ai/v0/evi',
            'config_id': '0d9df320-ec1d-4e08-8c2e-300e4e8de3b1',
            'auto_sync_on_changes': False, 'cleanup_orphaned_tools': False,
        },
        'grok_voice': {
            'api_key': _e('GROK_VOICE_API_KEY'), 'base_url': 'https://api.x.ai',
            'realtime_endpoint': '/v1/realtime', 'client_secrets_endpoint': '/v1/realtime/client_secrets',
            'default_voice': 'Eve', 'token_expiry_minutes': 5,
        },
        'gemini_voice': {
            'api_key': _e('GEMINI_VOICE_API_KEY'),
            'model': 'gemini-2.5-flash-native-audio-preview-12-2025', 'default_voice': 'Zephyr',
        },
        'scheduler': {'token': _e('SCHEDULER_TOKEN'), 'max_concurrent': 5, 'timeout_minutes': 30},
        'storage': {'default_provider': 's3'},
        # Python-only additions (not in ai_config.php):
        'port': int(_e('PORT', '3002')),
        'firebase': {'project_id': _e('FIREBASE_PROJECT_ID', 'transledgersite')},
    }
