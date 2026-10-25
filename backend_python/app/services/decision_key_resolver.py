"""Port of Services/DecisionKeyResolver.php.

Which key and URL a decision provider uses for one user: the user's own key, else the package's default
key, else the row's (admin) key -- and only when the user's package allows that provider. The user's own
URL goes with the user's own key only, so an admin/package key is never sent to an address a user picked.
A key that names no enabled row with a registered protocol is 'unknown': it cannot route, and nothing
guesses another provider.

resolve() returns {source: 'user'|'package'|'global'|'none'|'not_allowed'|'unknown', key, url, row, protocol}.
"""
from __future__ import annotations

from app.services.api_key_crypto import ApiKeyCrypto
from app.services.decision_providers import DecisionProviders
from app.services.package_resolver import PackageResolver
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_strval, php_trim

# ApiKeyCrypto::FALLBACK_SECRET: what the controllers have always used when auth.jwt_secret is unset.
FALLBACK_SECRET = 'default-encryption-key-change-this'

_NOT_ALLOWED = object()   # PHP packageEntry()'s `false`


def _secret(config: dict) -> str:
    """ApiKeyCrypto::secret: `$config['auth']['jwt_secret'] ?? FALLBACK_SECRET`."""
    auth = config.get('auth') if isinstance(config.get('auth'), dict) else {}
    s = auth.get('jwt_secret')
    return s if s is not None else FALLBACK_SECRET


class DecisionKeyResolver:
    @staticmethod
    def resolve(db, config: dict, userId: int | None, providerKey: str) -> dict:
        row = DecisionProviders.row(db, providerKey)
        protocol = DecisionProviders.protocolOf(row) if row is not None else None
        base = {'key': '', 'url': '', 'row': row, 'protocol': protocol}
        if row is None or protocol is None:
            return {'source': 'unknown', **base}
        rowUrl = php_trim(php_strval(row.get('base_url') if row.get('base_url') is not None else ''))
        if php_empty(rowUrl):
            rowUrl = protocol['url']

        package = DecisionKeyResolver._packageEntry(db, userId, providerKey)
        if package is _NOT_ALLOWED:
            return {'source': 'not_allowed', **base, 'url': rowUrl}

        if userId is not None and userId > 0:
            userKey, userUrl = DecisionKeyResolver._userRow(db, _secret(config), userId, providerKey)
            if userKey != '':
                return {'source': 'user', **base, 'key': userKey, 'url': userUrl if userUrl != '' else rowUrl}

        packageKey = php_trim(php_strval(package.get('default_api_key') if isinstance(package, dict)
                                         and package.get('default_api_key') is not None else ''))
        if packageKey != '':
            return {'source': 'package', **base, 'key': packageKey, 'url': rowUrl}

        globalKey = php_trim(php_strval(row.get('api_key') if row.get('api_key') is not None else ''))
        if globalKey != '':
            return {'source': 'global', **base, 'key': globalKey, 'url': rowUrl}

        return {'source': 'none', **base, 'url': rowUrl}

    @staticmethod
    def defaultProvider(db, userId: int | None) -> str | None:
        """The provider an unset dispatcher uses: first usable row (admin order) the plan allows."""
        for row in DecisionProviders.rows(db):
            key = php_strval(row.get('provider_key'))
            if (DecisionProviders.protocolOf(row) is not None
                    and DecisionKeyResolver._packageEntry(db, userId, key) is not _NOT_ALLOWED):
                return key
        return None

    @staticmethod
    def allowed(db, userId: int | None, providerKey: str) -> bool:
        return DecisionKeyResolver._packageEntry(db, userId, providerKey) is not _NOT_ALLOWED

    @staticmethod
    def unavailableReason(resolved: dict, providerKey: str) -> str:
        """Why a resolved-empty key cannot route, in the words the user sees."""
        row = resolved.get('row') if isinstance(resolved.get('row'), dict) else {}
        label = php_trim(php_strval(row.get('display_name') if row.get('display_name') is not None else ''))
        if php_empty(label):
            label = providerKey
        source = resolved.get('source')
        if source == 'unknown':
            return f"'{providerKey}' is not an available decision provider"
        if source == 'not_allowed':
            return f'{label} is not enabled for your plan'
        return f'no {label} key'

    @staticmethod
    def _packageEntry(db, userId: int | None, providerKey: str):
        """The package's entry for this provider, {} when the package sets no provider allowlist,
        _NOT_ALLOWED when the role may not use it. Same rule as the LLM provider list."""
        try:
            caps = PackageResolver(db).resolveForUser(userId).get('capabilities')
            providers = caps.get('providers') if isinstance(caps, dict) else None
        except Exception as e:  # noqa: BLE001 -- mirrors PHP catch (Throwable $e)
            error_log('[DecisionKeyResolver] package lookup failed: ' + str(e))
            return {}
        if not isinstance(providers, (dict, list)):
            return {}
        entry = providers.get(providerKey) if isinstance(providers, dict) else None
        if not isinstance(entry, dict) or php_empty(entry.get('enabled')):
            return _NOT_ALLOWED
        return entry

    @staticmethod
    def _userRow(db, secret: str, userId: int, providerKey: str) -> tuple[str, str]:
        """The user's own (key, url); ('', '') when none."""
        try:
            row = db.fetch_one('SELECT * FROM user_api_keys WHERE user_id = :u AND provider = :p AND enabled = 1 LIMIT 1',
                               {':u': userId, ':p': providerKey})
        except Exception as e:  # noqa: BLE001
            error_log('[DecisionKeyResolver] user key lookup failed: ' + str(e))
            return '', ''
        if not isinstance(row, dict):
            return '', ''
        return (ApiKeyCrypto.reveal(php_strval(row.get('api_key') if row.get('api_key') is not None else ''), secret),
                php_trim(php_strval(row.get('base_url') if row.get('base_url') is not None else '')))
