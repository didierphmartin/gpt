"""Port of Services/GeminiVoiceKey.php.

The Gemini key a user's voice sessions use, found like every other provider key: the user's own key, else
the package's default key, else the admin's (system_llm_settings), else the server's GEMINI_VOICE_API_KEY --
and none when the user's package does not allow Gemini. It stays on the server: the browser only ever gets
a single-use Live token minted with it.
"""
from __future__ import annotations

from app.services.decision_key_resolver import NOT_ALLOWED, DecisionKeyResolver, secret
from app.services.llm_provider_resolver import LLMProviderResolver
from app.support.phpcompat import php_strval, php_trim


class GeminiVoiceKey:
    @staticmethod
    def resolve(db, config: dict, userId: int | None) -> str:
        package = DecisionKeyResolver.packageEntry(db, userId, 'gemini')
        if package is NOT_ALLOWED:
            return ''

        if userId is not None and userId > 0:
            userKey, _ = DecisionKeyResolver.userRow(db, secret(config), userId, 'gemini')
            if userKey != '':
                return userKey

        packageKey = php_trim(php_strval(package.get('default_api_key')))
        if packageKey != '':
            return packageKey

        providers = LLMProviderResolver.applyDbSettings(db, {}).get('providers') or {}
        adminKey = php_trim(php_strval((providers.get('gemini') or {}).get('api_key')))
        if adminKey != '':
            return adminKey

        gemini = config.get('gemini_voice') if isinstance(config.get('gemini_voice'), dict) else {}
        return php_trim(php_strval(gemini.get('api_key')))
