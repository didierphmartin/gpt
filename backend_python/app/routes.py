"""Route table — mirrors backend/src/routes.php (same order, same handler names).
Rows for controllers not yet ported are added phase by phase."""
from app.controllers.auth_controller import AuthController
from app.controllers.chat_controller import ChatController
from app.controllers.context_controller import ContextController
from app.controllers.model_catalog_controller import ModelCatalogController
from app.controllers.package_controller import PackageController
from app.controllers.prompt_library_controller import PromptLibraryController
from app.controllers.provider_controller import ProviderController
from app.controllers.root_controller import RootController
from app.controllers.traces_controller import TracesController
from app.controllers.webauthn_controller import WebAuthnController

CONTROLLERS = {
    'AuthController': AuthController,
    'ChatController': ChatController,
    'ContextController': ContextController,
    'ModelCatalogController': ModelCatalogController,
    'PackageController': PackageController,
    'PromptLibraryController': PromptLibraryController,
    'ProviderController': ProviderController,
    'RootController': RootController,
    'TracesController': TracesController,
    'WebAuthnController': WebAuthnController,
}

ROUTES = [
    # AUTH ROUTES (Public)
    ('POST', '/api/v1/auth', ('AuthController', 'handleAction')),
    ('POST', '/api/v1/auth/login', ('AuthController', 'login')),
    ('POST', '/api/v1/auth/register', ('AuthController', 'register')),
    ('POST', '/api/v1/auth/firebase', ('AuthController', 'firebaseAuth')),
    ('POST', '/api/v1/auth/verify', ('AuthController', 'verify')),
    ('POST', '/api/v1/auth/logout', ('AuthController', 'logout')),
    # AUTH ROUTES (Protected)
    ('POST', '/api/v1/auth/link-phone', ('AuthController', 'linkPhone')),
    ('POST', '/api/v1/auth/upgrade-plan', ('AuthController', 'upgradePlan')),
    # CHAT ROUTES
    ('POST', '/api/v1/chat', ('ChatController', 'chat')),
    # PROVIDER ROUTES
    ('GET', '/api/v1/providers', ('ProviderController', 'list')),
    ('POST', '/api/v1/providers', ('ProviderController', 'switch')),   # Legacy: switch via POST to same endpoint
    ('POST', '/api/v1/providers/switch', ('ProviderController', 'switch')),
    # TRACES
    ('POST', '/api/v1/traces', ('TracesController', 'create')),
    ('GET', '/api/v1/traces/diagnosis', ('TracesController', 'diagnose')),
    # MODEL CATALOG (public)
    ('GET', '/api/v1/models/catalog', ('ModelCatalogController', 'get')),
    # PACKAGE ROUTES
    ('GET', '/api/v1/me/package', ('PackageController', 'me')),
    ('GET', '/api/v1/admin/packages', ('PackageController', 'adminList')),
    ('GET', '/api/v1/admin/packages/{role:[a-z]+}', ('PackageController', 'adminGet')),
    ('PUT', '/api/v1/admin/packages/{role:[a-z]+}', ('PackageController', 'adminUpdate')),
    # CONTEXT ROUTES
    ('GET', '/api/v1/contexts', ('ContextController', 'list')),
    ('GET', '/api/v1/contexts/{id:\\d+}', ('ContextController', 'get')),
    ('POST', '/api/v1/contexts', ('ContextController', 'create')),
    ('PUT', '/api/v1/contexts/{id:\\d+}', ('ContextController', 'update')),
    ('DELETE', '/api/v1/contexts/{id:\\d+}', ('ContextController', 'delete')),
    # PROMPT LIBRARY
    ('GET', '/api/v1/prompts', ('PromptLibraryController', 'getTree')),
    ('GET', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'get')),
    ('POST', '/api/v1/prompts', ('PromptLibraryController', 'create')),
    ('PUT', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'update')),
    ('DELETE', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'delete')),
    # WEBAUTHN
    ('POST', '/api/v1/webauthn/challenge', ('WebAuthnController', 'challenge')),
    ('POST', '/api/v1/webauthn/register', ('WebAuthnController', 'register')),
    ('POST', '/api/v1/webauthn/authenticate', ('WebAuthnController', 'authenticate')),
    ('DELETE', '/api/v1/webauthn/register', ('WebAuthnController', 'delete')),
    # ROOT / DEBUG
    ('GET', '/', ('RootController', 'index')),
    ('GET', '/api/v1', ('RootController', 'index')),
    ('GET', '/api/v1/debug/auth', ('AuthController', 'debugAuth')),
]
