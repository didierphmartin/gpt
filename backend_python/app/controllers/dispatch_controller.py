"""Port of Controllers/DispatchController.php.

Decision-model routing for the browser run path.

The canvas Run button executes workflows in the browser, which must never hold a decision provider's
key. It asks the server which providers exist (GET /dispatch/providers), whether one has a key
(GET /dispatch/{key}/status) and to route (POST /dispatch/route); the key is resolved here, per calling
user, and never returned. The /dispatch/jev URLs remain as aliases.
"""
from __future__ import annotations

from app.agent_team.services.jev_router import JevRouter
from app.services.decision_key_resolver import DecisionKeyResolver
from app.services.decision_providers import DecisionProviders
from app.services.decision_routers import DecisionRouters
from app.services.decision_usage import DecisionUsage
from app.services.usage_logger import UsageLogger
from app.support.phpcompat import is_numeric, php_empty, php_floatval, php_intval, php_strval, php_trim


class DispatchController:
    def __init__(self, db, config: dict | None = None, http=None, usage=None):
        self.db = db
        self.config = config or {}
        self.http = http
        self.usage = usage

    def providers(self, request: dict) -> dict:
        """GET /dispatch/providers: every decision provider and whether this user can route with it. Never a key."""
        userId = self._userId(request)
        lst = []
        for row in DecisionProviders.rows(self.db):
            key = php_strval(row.get('provider_key'))
            resolved = DecisionKeyResolver.resolve(self.db, self.config, userId, key)
            protocol = resolved['protocol']
            stem = DecisionProviders.envStem(key)
            routable = resolved['key'] != ''
            rowUrl = php_trim(php_strval(row.get('base_url') if row.get('base_url') is not None else ''))
            lst.append({
                'key': key,
                'label': key if php_empty(row.get('display_name')) else php_strval(row.get('display_name')),
                'protocol': row.get('protocol'),
                'model': php_strval(row.get('model') if row.get('model') is not None else ''),
                'default_url': (rowUrl if rowUrl not in ('', '0') else protocol['url']) if protocol is not None else '',
                'allowed': resolved['source'] not in ('not_allowed', 'unknown'),
                'has_key': routable,
                'source': resolved['source'],
                'routable': routable,
                'reason': None if routable else DecisionKeyResolver.unavailableReason(resolved, key),
                'key_env': stem + '_API_KEY',
                'url_env': stem + '_BASE_URL',
                'legacy_env': protocol.get('legacy_env') if protocol is not None else None,
                # This backend routes with decision models.
                'supported': True,
            })
        return {'success': True, 'default': DecisionKeyResolver.defaultProvider(self.db, userId),
                'providers': lst, 'status_code': 200}

    def status(self, request: dict, *routeParams) -> dict:
        """GET /dispatch/{key}/status"""
        params = request.get('params') if isinstance(request.get('params'), dict) else {}
        key = params.get('key')
        return self._statusOf(php_strval(key if key is not None else ''), request)

    def jevStatus(self, request: dict) -> dict:
        """GET /dispatch/jev/status (alias kept for pages loaded before the rename)."""
        return self._statusOf('jev', request)

    def _statusOf(self, key: str, request: dict) -> dict:
        resolved = DecisionKeyResolver.resolve(self.db, self.config, self._userId(request), key)
        return {
            'success': True,
            'provider': key,
            'allowed': resolved['source'] not in ('not_allowed', 'unknown'),
            'available': resolved['key'] != '',
            'source': resolved['source'],
            'status_code': 200,
        }

    def jevRoute(self, request: dict) -> dict:
        """POST /dispatch/jev (alias): route with provider 'jev' unless the body names one."""
        body = request.get('body') if isinstance(request.get('body'), dict) else {}
        request = {**request, 'body': {**body, 'provider': body['provider'] if 'provider' in body else 'jev'}}
        return self.route(request)

    def route(self, request: dict) -> dict:
        """POST /dispatch/route: route one request to one of the targets with the named decision provider."""
        input_ = request.get('body') if isinstance(request.get('body'), dict) else {}
        provider = php_trim(input_['provider']) if isinstance(input_.get('provider'), str) else ''
        text = input_.get('request')
        targets = input_.get('targets')
        question = input_.get('question')
        floor = JevRouter.DEFAULT_CONFIDENCE_FLOOR

        if provider == '':
            return self._bad('provider is required')
        if not isinstance(text, str) or php_trim(text) == '':
            return self._bad('request is required')
        if not isinstance(targets, (list, dict)):
            return self._bad('targets must be an array')
        if not isinstance(question, str):
            return self._bad('question must be a string')
        if 'min_confidence' in input_ and input_['min_confidence'] is not None:
            if not is_numeric(input_['min_confidence']):
                return self._bad('min_confidence must be a number')
            floor = max(0.0, min(1.0, php_floatval(input_['min_confidence'])))

        targetList = list(targets.values()) if isinstance(targets, dict) else targets
        userId = self._userId(request)
        resolved = DecisionKeyResolver.resolve(self.db, self.config, userId, provider)
        router = DecisionRouters.make(resolved, floor, self.http) if resolved['key'] != '' else None
        out = router.route(text, targetList, question) if router is not None else DecisionRouters.unavailable(resolved, provider)
        # One usage row per call the vendor answered; refused calls record nothing.
        row = resolved.get('row') if isinstance(resolved.get('row'), dict) else {}
        DecisionUsage.record(
            self.usage if self.usage is not None else UsageLogger(
                self.db, True, self.config.get('contexts_database') if self.config.get('contexts_database') is not None
                else self.config.get('database')),
            userId, provider, php_strval(row.get('model') if row.get('model') is not None else ''), out,
        )

        t = out.get('target')
        target = {'id': t.get('id'), 'name': t.get('name')} if isinstance(t, dict) else None

        return {
            'success': True,
            'provider': provider,
            'outcome': out['outcome'],
            'target': target,
            'confidence': out['confidence'],
            'ms': out['ms'],
            'reason': out['reason'],
            'status_code': 200,
        }

    @staticmethod
    def _userId(request: dict) -> int | None:
        return php_intval(request['user_id']) if request.get('user_id') is not None else None

    @staticmethod
    def _bad(message: str) -> dict:
        return {'success': False, 'message': message, 'status_code': 400}
