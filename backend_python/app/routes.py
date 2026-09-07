"""Route table — mirrors backend/src/routes.php (same order, same handler names).
Rows for controllers not yet ported are added phase by phase."""
from app.agent_team.controllers.app_key_controller import AppKeyController
from app.agent_team.controllers.user_memory_controller import UserMemoryController
from app.controllers.auth_controller import AuthController
from app.controllers.chat_attachment_controller import ChatAttachmentController
from app.controllers.chat_controller import ChatController
from app.controllers.context_controller import ContextController
from app.controllers.genesis_controller import GenesisController
from app.controllers.heal_controller import HealController
from app.controllers.model_catalog_controller import ModelCatalogController
from app.controllers.package_controller import PackageController
from app.controllers.prompt_library_controller import PromptLibraryController
from app.controllers.provider_controller import ProviderController
from app.controllers.root_controller import RootController
from app.controllers.settings_controller import SettingsController
from app.controllers.tools_controller import ToolsController
from app.controllers.traces_controller import TracesController
from app.controllers.url_fetch_controller import UrlFetchController
from app.controllers.usage_controller import UsageController
from app.controllers.webauthn_controller import WebAuthnController

# AgentTeam-namespaced controllers (backend/src/AgentTeam/Controllers/*) use the
# PHP-prefixed key 'AgentTeam:<ClassName>' so the registry mirrors routes.php's
# ['AgentTeam:UserMemoryController', 'show'] handler literals.
CONTROLLERS = {
    'AgentTeam:AppKeyController': AppKeyController,
    'AgentTeam:UserMemoryController': UserMemoryController,
    'AuthController': AuthController,
    'ChatAttachmentController': ChatAttachmentController,
    'ChatController': ChatController,
    'ContextController': ContextController,
    'GenesisController': GenesisController,
    'HealController': HealController,
    'ModelCatalogController': ModelCatalogController,
    'PackageController': PackageController,
    'PromptLibraryController': PromptLibraryController,
    'ProviderController': ProviderController,
    'RootController': RootController,
    'SettingsController': SettingsController,
    'ToolsController': ToolsController,
    'TracesController': TracesController,
    'UrlFetchController': UrlFetchController,
    'UsageController': UsageController,
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
    ('POST', '/api/v1/agent', ('ChatController', 'agent')),
    ('POST', '/api/v1/verify', ('ChatController', 'verify')),
    ('POST', '/api/v1/compare', ('ChatController', 'compareOnly')),
    # PROVIDER ROUTES
    ('GET', '/api/v1/providers', ('ProviderController', 'list')),
    ('POST', '/api/v1/providers', ('ProviderController', 'switch')),   # Legacy: switch via POST to same endpoint
    ('POST', '/api/v1/providers/switch', ('ProviderController', 'switch')),
    # TRACES
    ('POST', '/api/v1/traces', ('TracesController', 'create')),
    ('GET', '/api/v1/traces/diagnosis', ('TracesController', 'diagnose')),
    # URL FETCH
    ('POST', '/api/v1/fetch-url', ('UrlFetchController', 'fetch')),
    # ATTACHMENTS
    ('POST', '/api/v1/chat/upload', ('ChatAttachmentController', 'upload')),
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
    # USAGE ROUTES
    ('GET', '/api/v1/usage', ('UsageController', 'getBalance')),
    ('GET', '/api/v1/usage/balance', ('UsageController', 'getBalance')),
    ('GET', '/api/v1/usage/transactions', ('UsageController', 'getTransactions')),
    ('GET', '/api/v1/usage/stats', ('UsageController', 'getStats')),
    # SETTINGS ROUTES (routes.php:114-134)
    ('GET', '/api/v1/settings/usage', ('SettingsController', 'getUsage')),
    ('GET', '/api/v1/settings/keys', ('SettingsController', 'getKeys')),
    ('POST', '/api/v1/settings/keys', ('SettingsController', 'saveKeys')),
    ('DELETE', '/api/v1/settings/keys', ('SettingsController', 'clearKeys')),
    ('GET', '/api/v1/settings/providers', ('SettingsController', 'getProviderSettings')),
    ('POST', '/api/v1/settings/provider', ('SettingsController', 'saveProvider')),
    ('POST', '/api/v1/settings/provider/active', ('SettingsController', 'setActiveProvider')),
    ('DELETE', '/api/v1/settings/provider', ('SettingsController', 'deleteProvider')),
    ('GET', '/api/v1/settings/phone', ('SettingsController', 'getPhoneStatus')),
    # Storage settings
    ('GET', '/api/v1/settings/storage', ('SettingsController', 'getStorageSettings')),
    ('POST', '/api/v1/settings/storage', ('SettingsController', 'saveStorageSettings')),
    # Auto-heal settings (self-healing mode + cost guards)
    ('GET', '/api/v1/settings/heal', ('SettingsController', 'getHealSettings')),
    ('POST', '/api/v1/settings/heal', ('SettingsController', 'saveHealSettings')),
    # Skill-genesis settings (promotion mode + cost guards)
    ('GET', '/api/v1/settings/genesis', ('SettingsController', 'getGenesisSettings')),
    ('POST', '/api/v1/settings/genesis', ('SettingsController', 'saveGenesisSettings')),
    # HEAL (self-healing enforcement gate: mode/budget/ceiling — routes.php:137-139)
    ('POST', '/api/v1/heal/authorize', ('HealController', 'authorize')),
    ('POST', '/api/v1/heal/record', ('HealController', 'record')),
    ('GET', '/api/v1/heal/status', ('HealController', 'status')),
    # GENESIS (skill genesis, spec: docs/specs/2026-07-14-skill-genesis-design.md §7 — routes.php:142-146)
    ('GET', '/api/v1/genesis/promotions', ('GenesisController', 'listPromotions')),
    ('POST', '/api/v1/genesis/authorize', ('GenesisController', 'authorize')),
    ('POST', '/api/v1/genesis/record', ('GenesisController', 'record')),
    ('POST', '/api/v1/genesis/promotions/{id:\\d+}/dismiss', ('GenesisController', 'dismiss')),
    ('POST', '/api/v1/genesis/proposals', ('GenesisController', 'createProposal')),
    # TOOLS ROUTES (List all available tools for LLM — routes.php:259-261)
    ('GET', '/api/v1/tools', ('ToolsController', 'list')),
    ('POST', '/api/v1/tools/execute', ('ToolsController', 'execute')),
    ('POST', '/api/v1/tools/classify-intent', ('ToolsController', 'classifyIntent')),
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
    # USER MEMORIES (Hermes-style frozen memory — always injected into system prompt)
    ('GET', '/api/v1/user-memories', ('AgentTeam:UserMemoryController', 'show')),
    ('PUT', '/api/v1/user-memories', ('AgentTeam:UserMemoryController', 'update')),
    ('GET', '/api/v1/user-memories/events', ('AgentTeam:UserMemoryController', 'listEvents')),
    ('DELETE', '/api/v1/user-memories/events/{id:\\d+}', ('AgentTeam:UserMemoryController', 'deleteEvent')),
    # APP KEYS — scoped credentials for client code (CRUD is admin-only;
    # whoami is app-key-authed so client code can introspect its key).
    ('POST', '/api/v1/app-keys', ('AgentTeam:AppKeyController', 'create')),
    ('GET', '/api/v1/app-keys', ('AgentTeam:AppKeyController', 'index')),
    ('GET', '/api/v1/app-keys/whoami', ('AgentTeam:AppKeyController', 'whoami')),
    ('GET', '/api/v1/app-keys/workflows', ('AgentTeam:AppKeyController', 'listUserWorkflows')),
    ('GET', '/api/v1/app-keys/agents', ('AgentTeam:AppKeyController', 'listUserAgents')),
    ('DELETE', '/api/v1/app-keys/{id:\\d+}', ('AgentTeam:AppKeyController', 'destroy')),
    # ROOT / DEBUG
    ('GET', '/', ('RootController', 'index')),
    ('GET', '/api/v1', ('RootController', 'index')),
    ('GET', '/api/v1/debug/auth', ('AuthController', 'debugAuth')),
]
