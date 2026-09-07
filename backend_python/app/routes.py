"""Route table — mirrors backend/src/routes.php (same order, same handler names).
Rows for controllers not yet ported are added phase by phase."""
from app.agent_team.controllers.agent_controller import AgentController
from app.agent_team.controllers.agent_mcp_controller import AgentMCPController
from app.agent_team.controllers.app_key_controller import AppKeyController
from app.agent_team.controllers.ingestion_controller import IngestionController
from app.agent_team.controllers.scheduled_workflow_controller import ScheduledWorkflowController
from app.agent_team.controllers.scheduler_controller import SchedulerController
from app.agent_team.controllers.team_controller import TeamController
from app.agent_team.controllers.user_memory_controller import UserMemoryController
from app.agent_team.controllers.workflow_controller import WorkflowController
from app.agent_team.controllers.workflow_schema_controller import WorkflowSchemaController
from app.controllers.admin_controller import AdminController
from app.controllers.affiliate_controller import AffiliateController
from app.controllers.auth_controller import AuthController
from app.controllers.chat_attachment_controller import ChatAttachmentController
from app.controllers.chat_controller import ChatController
from app.controllers.context_controller import ContextController
from app.controllers.drive_controller import DriveController
from app.controllers.file_storage_controller import FileStorageController
from app.controllers.genesis_controller import GenesisController
from app.controllers.heal_controller import HealController
from app.controllers.login_admin_controller import LoginAdminController
from app.controllers.mcp_app_controller import MCPAppController
from app.controllers.mcp_proxy_controller import MCPProxyController
from app.controllers.mcp_server_controller import MCPServerController
from app.controllers.model_catalog_controller import ModelCatalogController
from app.controllers.package_controller import PackageController
from app.controllers.playbook_controller import PlaybookController
from app.controllers.prompt_library_controller import PromptLibraryController
from app.controllers.provider_controller import ProviderController
from app.controllers.root_controller import RootController
from app.controllers.settings_controller import SettingsController
from app.controllers.system_settings_controller import SystemSettingsController
from app.controllers.tools_controller import ToolsController
from app.controllers.traces_controller import TracesController
from app.controllers.url_fetch_controller import UrlFetchController
from app.controllers.usage_controller import UsageController
from app.controllers.voice_controller import VoiceController
from app.controllers.webauthn_controller import WebAuthnController

# AgentTeam-namespaced controllers (backend/src/AgentTeam/Controllers/*) use the
# PHP-prefixed key 'AgentTeam:<ClassName>' so the registry mirrors routes.php's
# ['AgentTeam:UserMemoryController', 'show'] handler literals.
CONTROLLERS = {
    'AgentTeam:AgentController': AgentController,
    'AgentTeam:AgentMCPController': AgentMCPController,
    'AgentTeam:AppKeyController': AppKeyController,
    'AgentTeam:IngestionController': IngestionController,
    'AgentTeam:ScheduledWorkflowController': ScheduledWorkflowController,
    'AgentTeam:SchedulerController': SchedulerController,
    'AgentTeam:TeamController': TeamController,
    'AgentTeam:UserMemoryController': UserMemoryController,
    'AgentTeam:WorkflowController': WorkflowController,
    'AgentTeam:WorkflowSchemaController': WorkflowSchemaController,
    'AdminController': AdminController,
    'AffiliateController': AffiliateController,
    'AuthController': AuthController,
    'ChatAttachmentController': ChatAttachmentController,
    'ChatController': ChatController,
    'ContextController': ContextController,
    'DriveController': DriveController,
    'FileStorageController': FileStorageController,
    'GenesisController': GenesisController,
    'HealController': HealController,
    'LoginAdminController': LoginAdminController,
    'MCPAppController': MCPAppController,
    'MCPProxyController': MCPProxyController,
    'MCPServerController': MCPServerController,
    'ModelCatalogController': ModelCatalogController,
    'PackageController': PackageController,
    'PlaybookController': PlaybookController,
    'PromptLibraryController': PromptLibraryController,
    'ProviderController': ProviderController,
    'RootController': RootController,
    'SettingsController': SettingsController,
    'SystemSettingsController': SystemSettingsController,
    'ToolsController': ToolsController,
    'TracesController': TracesController,
    'UrlFetchController': UrlFetchController,
    'UsageController': UsageController,
    'VoiceController': VoiceController,
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
    # AFFILIATES (routes.php:73-93)
    # Admin (existing admin JWT / role=admin enforced in controller)
    ('GET', '/api/v1/admin/affiliates', ('AffiliateController', 'adminList')),
    ('POST', '/api/v1/admin/affiliates', ('AffiliateController', 'adminCreate')),
    ('GET', '/api/v1/admin/affiliates/{id:\\d+}', ('AffiliateController', 'adminGet')),
    ('DELETE', '/api/v1/admin/affiliates/{id:\\d+}', ('AffiliateController', 'adminDelete')),
    ('GET', '/api/v1/admin/affiliates/{id:\\d+}/transactions', ('AffiliateController', 'adminTransactions')),
    ('POST', '/api/v1/admin/affiliates/{id:\\d+}/accounts', ('AffiliateController', 'adminAddAccount')),
    ('PUT', '/api/v1/admin/affiliates/{id:\\d+}/accounts/{productId:\\d+}', ('AffiliateController', 'adminUpdateAccount')),
    ('DELETE', '/api/v1/admin/affiliates/{id:\\d+}/accounts/{productId:\\d+}', ('AffiliateController', 'adminDeleteAccount')),
    ('POST', '/api/v1/admin/affiliates/{id:\\d+}/transactions/{saleId:\\d+}/mark-paid', ('AffiliateController', 'adminMarkPaid')),
    ('GET', '/api/v1/admin/affiliate-products', ('AffiliateController', 'adminListProducts')),
    ('POST', '/api/v1/admin/affiliate-products', ('AffiliateController', 'adminCreateProduct')),
    ('PUT', '/api/v1/admin/affiliate-products/{id:\\d+}', ('AffiliateController', 'adminUpdateProduct')),
    ('DELETE', '/api/v1/admin/affiliate-products/{id:\\d+}', ('AffiliateController', 'adminDeleteProduct')),
    # Affiliate self-scope (role=affiliate enforced in controller)
    ('GET', '/api/v1/affiliate/me', ('AffiliateController', 'me')),
    ('GET', '/api/v1/affiliate/me/transactions', ('AffiliateController', 'myTransactions')),
    # Conversion endpoint — selling apps report a sale. NOT in PUBLIC_ROUTES on
    # either backend (see app/middleware/processor.py): any authenticated
    # caller, gated by recordConversion()'s own user_id check, not by role.
    ('POST', '/api/v1/affiliate/conversions', ('AffiliateController', 'recordConversion')),
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
    # ADMIN — SYSTEM LLM SETTINGS (routes.php:249-254)
    ('GET', '/api/v1/admin/llm-settings', ('SystemSettingsController', 'getLLMProviders')),
    ('GET', '/api/v1/admin/llm-settings/{key}', ('SystemSettingsController', 'getLLMProvider')),
    ('POST', '/api/v1/admin/llm-settings', ('SystemSettingsController', 'saveLLMProvider')),
    ('DELETE', '/api/v1/admin/llm-settings/{key}', ('SystemSettingsController', 'deleteLLMProvider')),
    ('POST', '/api/v1/admin/llm-settings/toggle', ('SystemSettingsController', 'toggleProvider')),
    ('POST', '/api/v1/admin/llm-settings/seed', ('SystemSettingsController', 'seedFromConfig')),
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
    # MCP SERVER ROUTES (per-user CRUD; admin endpoints live under /admin/mcp — routes.php:266-276)
    ('GET', '/api/v1/mcp/servers', ('MCPServerController', 'list')),
    ('GET', '/api/v1/mcp/servers/tools', ('MCPServerController', 'getTools')),
    ('GET', '/api/v1/mcp/servers/all-tools', ('MCPServerController', 'getAllTools')),
    ('POST', '/api/v1/mcp/servers', ('MCPServerController', 'create')),
    ('POST', '/api/v1/mcp/servers/update', ('MCPServerController', 'update')),
    ('POST', '/api/v1/mcp/servers/toggle', ('MCPServerController', 'toggle')),
    ('DELETE', '/api/v1/mcp/servers', ('MCPServerController', 'delete')),
    ('PUT', '/api/v1/me/mcp-settings', ('MCPServerController', 'setMasterSetting')),
    ('GET', '/api/v1/me/mcp-servers', ('MCPServerController', 'listMine')),
    ('PUT', '/api/v1/me/mcp-servers/{serverId:\\d+}/override', ('MCPServerController', 'setMyOverride')),
    ('DELETE', '/api/v1/me/mcp-servers/{serverId:\\d+}/override', ('MCPServerController', 'clearMyOverride')),
    # MCP PROXY (routes.php:279-281)
    ('POST', '/api/v1/mcp/proxy', ('MCPProxyController', 'forward')),
    # MCP APP (Public - serves HTML; routes.php:283-287)
    ('GET', '/api/v1/mcp/app', ('MCPAppController', 'getResource')),
    ('GET', '/api/mcp-app.php', ('MCPAppController', 'getResource')),  # Legacy path
    # FILE STORAGE (universalFS; routes.php:151-153)
    ('GET', '/api/v1/storage/providers', ('FileStorageController', 'getProviders')),
    ('GET', '/api/v1/storage/list', ('FileStorageController', 'listFiles')),
    ('GET', '/api/v1/storage/read', ('FileStorageController', 'readFile')),
    # VOICE USAGE (routes.php:315-318)
    ('POST', '/api/v1/voice/usage', ('VoiceController', 'logUsage')),
    ('GET', '/api/v1/voice/stats', ('VoiceController', 'getStats')),
    ('POST', '/api/v1/voice/token', ('VoiceController', 'getEphemeralToken')),
    ('GET', '/api/v1/voice/config', ('VoiceController', 'getConfig')),
    # GOOGLE DRIVE (routes.php:323)
    ('POST', '/api/v1/drive/save', ('DriveController', 'save')),
    # PROMPT LIBRARY
    ('GET', '/api/v1/prompts', ('PromptLibraryController', 'getTree')),
    ('GET', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'get')),
    ('POST', '/api/v1/prompts', ('PromptLibraryController', 'create')),
    ('PUT', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'update')),
    ('DELETE', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'delete')),
    # ADMIN — USERS / PROVIDERS / KEYS (routes.php 175-189; Task 3 appends
    # usage/MCP-admin/costs/exchange-rate rows for the same controller after
    # this block, mirroring routes.php 192-196, 228-246)
    ('GET', '/api/v1/admin/users', ('AdminController', 'listUsers')),
    ('GET', '/api/v1/admin/users/{id:\\d+}', ('AdminController', 'getUser')),
    ('GET', '/api/v1/admin/users/{id:\\d+}/account', ('AdminController', 'getUserAccount')),
    ('POST', '/api/v1/admin/users', ('AdminController', 'createUser')),
    ('POST', '/api/v1/admin/users/update', ('AdminController', 'updateUser')),
    ('DELETE', '/api/v1/admin/users/{id:\\d+}', ('AdminController', 'deleteUser')),
    ('GET', '/api/v1/admin/users/{id:\\d+}/providers', ('AdminController', 'getProviderSettings')),
    ('POST', '/api/v1/admin/providers', ('AdminController', 'saveProvider')),
    ('POST', '/api/v1/admin/providers/toggle', ('AdminController', 'toggleProviderEnabled')),
    ('POST', '/api/v1/admin/providers/category-toggle', ('AdminController', 'toggleCategoryEnabled')),
    ('DELETE', '/api/v1/admin/providers', ('AdminController', 'deleteProvider')),
    ('GET', '/api/v1/admin/users/{id:\\d+}/costs', ('AdminController', 'getUserCosts')),
    ('GET', '/api/v1/admin/users/{id:\\d+}/keys', ('AdminController', 'getApiKeys')),
    ('POST', '/api/v1/admin/keys', ('AdminController', 'saveApiKeys')),
    ('POST', '/api/v1/admin/keys/delete', ('AdminController', 'deleteApiKey')),
    # ADMIN — LOGIN (login microservice admin: users, apps, passkeys, appkeys
    # — routes.php:217-225)
    ('GET', '/api/v1/admin/login/stats', ('LoginAdminController', 'getStats')),
    ('GET', '/api/v1/admin/login/users', ('LoginAdminController', 'getUsers')),
    ('POST', '/api/v1/admin/login/users', ('LoginAdminController', 'createUser')),
    ('POST', '/api/v1/admin/login/users/update', ('LoginAdminController', 'updateUser')),
    ('POST', '/api/v1/admin/login/users/delete', ('LoginAdminController', 'deleteUser')),
    ('GET', '/api/v1/admin/login/apps', ('LoginAdminController', 'getApps')),
    ('GET', '/api/v1/admin/login/app-users', ('LoginAdminController', 'getAppUsers')),
    ('POST', '/api/v1/admin/login/app-users/role', ('LoginAdminController', 'setAppUserRole')),
    ('POST', '/api/v1/admin/login/app-users/add', ('LoginAdminController', 'addAppMember')),
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
    # TEAMS (routes.php:340-345)
    ('GET', '/api/v1/teams', ('AgentTeam:TeamController', 'index')),
    ('POST', '/api/v1/teams', ('AgentTeam:TeamController', 'create')),
    ('GET', '/api/v1/teams/{id:\\d+}', ('AgentTeam:TeamController', 'show')),
    ('PUT', '/api/v1/teams/{id:\\d+}', ('AgentTeam:TeamController', 'update')),
    ('DELETE', '/api/v1/teams/{id:\\d+}', ('AgentTeam:TeamController', 'destroy')),
    ('GET', '/api/v1/teams/{id:\\d+}/agents', ('AgentTeam:TeamController', 'agents')),
    # WORKFLOWS (routes.php:348-350, 374-384, 391-392, 402-405.
    # generate-python/adk/maf/nooa (351-354) are Phase 6 and NOT routed
    # here.)
    ('GET', '/api/v1/workflows', ('AgentTeam:WorkflowController', 'index')),
    ('POST', '/api/v1/workflows', ('AgentTeam:WorkflowController', 'create')),
    ('GET', '/api/v1/workflows/{id:\\d+}', ('AgentTeam:WorkflowController', 'show')),
    ('PUT', '/api/v1/workflows/{id:\\d+}', ('AgentTeam:WorkflowController', 'update')),
    ('DELETE', '/api/v1/workflows/{id:\\d+}', ('AgentTeam:WorkflowController', 'destroy')),
    ('POST', '/api/v1/workflows/run', ('AgentTeam:WorkflowController', 'runByName')),
    ('POST', '/api/v1/workflows/{id:\\d+}/run', ('AgentTeam:WorkflowController', 'run')),
    ('POST', '/api/v1/workflows/{id:\\d+}/run-stream', ('AgentTeam:WorkflowController', 'runStream')),
    ('POST', '/api/v1/workflows/tool-result', ('AgentTeam:WorkflowController', 'toolResult')),
    ('POST', '/api/v1/workflows/playbook-node/run', ('AgentTeam:WorkflowController', 'runPlaybookNode')),
    # Standalone config-driven ingestion compiler (separate from agent code) —
    # chunks/scripts are compiled from the node configs the frontend sends
    # (routes.php 357-373; mirrors that ordering, positioned here per this
    # phase's Task 6 routing guidance — after the WORKFLOWS run rows, before
    # generate-* which Task 4 adds later).
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/node-code', ('AgentTeam:IngestionController', 'nodeCode')),
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/compile', ('AgentTeam:IngestionController', 'compile')),
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/save-script', ('AgentTeam:IngestionController', 'saveScript')),
    # Interpreter (node-by-node): the loader node runs live and returns the
    # files-as-text shown in its Output tab; the splitter chunks that text.
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/loader-text', ('AgentTeam:IngestionController', 'loaderText')),
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/splitter-chunks', ('AgentTeam:IngestionController', 'splitterChunks')),
    # Store node: loader→split→write each chunk to the chosen vector-DB MCP.
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/store-chunks', ('AgentTeam:IngestionController', 'storeChunks')),
    # Store node retrieval test: qdrant-find against the chosen vector-DB MCP.
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/store-find', ('AgentTeam:IngestionController', 'storeFind')),
    # Closed event loop: server-side run (enumerate once → loop loader→split→store), SSE progress.
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/run-stream', ('AgentTeam:IngestionController', 'runStream')),
    # Parallel run (true multi-core): run-start enumerates + creates a shared
    # cursor; K concurrent run-worker SSE streams pull files work-stealing.
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/run-start', ('AgentTeam:IngestionController', 'runStart')),
    ('POST', '/api/v1/workflows/{id:\\d+}/ingestion/run-worker', ('AgentTeam:IngestionController', 'runWorker')),
    ('GET', '/api/v1/workflows/{id:\\d+}/executions', ('AgentTeam:WorkflowController', 'executions')),
    ('GET', '/api/v1/workflows/runs/{runId:[a-f0-9]{32}}/events', ('AgentTeam:WorkflowController', 'runEvents')),
    ('POST', '/api/v1/workflows/{id:\\d+}/toggle', ('AgentTeam:WorkflowController', 'toggle')),
    ('POST', '/api/v1/workflows/{id:\\d+}/duplicate', ('AgentTeam:WorkflowController', 'duplicate')),
    ('GET', '/api/v1/workflows/{id:\\d+}/outputs', ('AgentTeam:WorkflowController', 'listOutputs')),
    ('GET', '/api/v1/workflows/{id:\\d+}/outputs/{filename}', ('AgentTeam:WorkflowController', 'getOutput')),
    ('POST', '/api/v1/workflows/{id:\\d+}/nodes/{nodeId:\\d+}/documents',
     ('AgentTeam:WorkflowController', 'uploadNodeDocument')),
    ('POST', '/api/v1/workflows/{id:\\d+}/nodes/{nodeId:\\d+}/documents/metadata',
     ('AgentTeam:WorkflowController', 'saveDocumentMetadata')),
    ('GET', '/api/v1/workflows/{id:\\d+}/nodes/{nodeId:\\d+}/documents',
     ('AgentTeam:WorkflowController', 'listNodeDocuments')),
    ('DELETE', '/api/v1/workflows/{id:\\d+}/nodes/{nodeId:\\d+}/documents/{docId}',
     ('AgentTeam:WorkflowController', 'deleteNodeDocument')),
    # Playbook registration-time validation (spec T4): parse + resolve
    # bindings against the caller's MCP tools/agents, no run created.
    # routes.php:386-388.
    ('POST', '/api/v1/playbooks/validate', ('PlaybookController', 'validate')),
    # WORKFLOW SCHEMAS (routes.php:395-399)
    ('GET', '/api/v1/workflow-schemas', ('AgentTeam:WorkflowSchemaController', 'index')),
    ('POST', '/api/v1/workflow-schemas', ('AgentTeam:WorkflowSchemaController', 'create')),
    ('GET', '/api/v1/workflow-schemas/{id:\\d+}', ('AgentTeam:WorkflowSchemaController', 'show')),
    ('PUT', '/api/v1/workflow-schemas/{id:\\d+}', ('AgentTeam:WorkflowSchemaController', 'update')),
    ('DELETE', '/api/v1/workflow-schemas/{id:\\d+}', ('AgentTeam:WorkflowSchemaController', 'destroy')),
    # AGENTS (Agent CRUD and execution; routes.php:407-424)
    ('GET', '/api/v1/agents', ('AgentTeam:AgentController', 'index')),
    ('POST', '/api/v1/agents', ('AgentTeam:AgentController', 'create')),
    ('GET', '/api/v1/agents/tools', ('AgentTeam:AgentController', 'listTools')),
    ('POST', '/api/v1/agents/reorder', ('AgentTeam:AgentController', 'reorder')),
    # Agent categories (containers for the Agents sidebar service)
    ('GET', '/api/v1/agents/categories', ('AgentTeam:AgentController', 'listCategories')),
    ('PUT', '/api/v1/agents/categories/rename', ('AgentTeam:AgentController', 'renameCategory')),
    ('DELETE', '/api/v1/agents/categories', ('AgentTeam:AgentController', 'deleteCategory')),
    ('GET', '/api/v1/agents/{id:\\d+}', ('AgentTeam:AgentController', 'show')),
    ('PUT', '/api/v1/agents/{id:\\d+}', ('AgentTeam:AgentController', 'update')),
    ('DELETE', '/api/v1/agents/{id:\\d+}', ('AgentTeam:AgentController', 'destroy')),
    ('POST', '/api/v1/agents/{id:\\d+}/run', ('AgentTeam:AgentController', 'run')),
    ('POST', '/api/v1/agents/{id:\\d+}/chat', ('AgentTeam:AgentController', 'chat')),
    ('GET', '/api/v1/agents/{id:\\d+}/executions', ('AgentTeam:AgentController', 'executions')),
    ('POST', '/api/v1/agents/{id:\\d+}/duplicate', ('AgentTeam:AgentController', 'duplicate')),
    ('POST', '/api/v1/agents/{id:\\d+}/move-up', ('AgentTeam:AgentController', 'moveUp')),
    ('POST', '/api/v1/agents/{id:\\d+}/move-down', ('AgentTeam:AgentController', 'moveDown')),
    # MCP JSON-RPC endpoint for AI client integration (routes.php:427)
    ('POST', '/api/v1/mcp/agents', ('AgentTeam:AgentMCPController', 'handle')),
    # SCHEDULES (routes.php:451-459. `stats` is registered before `{id}` —
    # same first-match-wins ordering as PHP's FastRoute table.)
    ('GET', '/api/v1/schedules', ('AgentTeam:ScheduledWorkflowController', 'index')),
    ('POST', '/api/v1/schedules', ('AgentTeam:ScheduledWorkflowController', 'create')),
    ('GET', '/api/v1/schedules/stats', ('AgentTeam:ScheduledWorkflowController', 'stats')),
    ('GET', '/api/v1/schedules/{id:\\d+}', ('AgentTeam:ScheduledWorkflowController', 'show')),
    ('PUT', '/api/v1/schedules/{id:\\d+}', ('AgentTeam:ScheduledWorkflowController', 'update')),
    ('DELETE', '/api/v1/schedules/{id:\\d+}', ('AgentTeam:ScheduledWorkflowController', 'destroy')),
    ('POST', '/api/v1/schedules/{id:\\d+}/pause', ('AgentTeam:ScheduledWorkflowController', 'pause')),
    ('POST', '/api/v1/schedules/{id:\\d+}/resume', ('AgentTeam:ScheduledWorkflowController', 'resume')),
    ('GET', '/api/v1/workflows/{id:\\d+}/schedules', ('AgentTeam:ScheduledWorkflowController', 'byWorkflow')),
    # SCHEDULER (routes.php:464-465. `/scheduler/run` is public — see
    # app/middleware/processor.py PUBLIC_ROUTES.)
    ('POST', '/api/v1/scheduler/run', ('AgentTeam:SchedulerController', 'run')),
    ('GET', '/api/v1/scheduler/status', ('AgentTeam:SchedulerController', 'status')),
    # ROOT / DEBUG
    ('GET', '/', ('RootController', 'index')),
    ('GET', '/api/v1', ('RootController', 'index')),
    ('GET', '/api/v1/debug/auth', ('AuthController', 'debugAuth')),
]
