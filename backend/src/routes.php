<?php

declare(strict_types=1);

use FastRoute\RouteCollector;

/**
 * Route Definitions for GPT Backend API
 *
 * All routes are defined here and dispatched via FastRoute.
 * Route format: [Controller, method]
 */
function createRouteDispatcher(): \FastRoute\Dispatcher
{
    return \FastRoute\simpleDispatcher(function (RouteCollector $r) {

        // ============================================
        // AUTH ROUTES (Public)
        // ============================================
        // Legacy route - handles action-based routing from old frontend
        $r->post('/api/v1/auth', ['AuthController', 'handleAction']);
        // New RESTful routes
        $r->post('/api/v1/auth/login', ['AuthController', 'login']);
        $r->post('/api/v1/auth/register', ['AuthController', 'register']);
        $r->post('/api/v1/auth/firebase', ['AuthController', 'firebaseAuth']);
        $r->post('/api/v1/auth/verify', ['AuthController', 'verify']);
        $r->post('/api/v1/auth/logout', ['AuthController', 'logout']);

        // ============================================
        // AUTH ROUTES (Protected - requires authentication)
        // ============================================
        $r->post('/api/v1/auth/link-phone', ['AuthController', 'linkPhone']);
        $r->post('/api/v1/auth/upgrade-plan', ['AuthController', 'upgradePlan']);

        // ============================================
        // CHAT ROUTES
        // ============================================
        $r->post('/api/v1/chat', ['ChatController', 'chat']);
        $r->post('/api/v1/agent', ['ChatController', 'agent']);
        $r->post('/api/v1/verify', ['ChatController', 'verify']);
        $r->post('/api/v1/compare', ['ChatController', 'compareOnly']);
        $r->post('/api/v1/chat/upload', ['ChatAttachmentController', 'upload']);

        // Phase 0 self-healing: chat.js posts one execution trace here after a
        // skill runs in conversation/forced mode (the workflow path captures
        // its own traces server-side). See docs/specs/2026-06-13-phase0-*.
        $r->post('/api/v1/traces', ['TracesController', 'create']);
        $r->get('/api/v1/traces/diagnosis', ['TracesController', 'diagnose']);

        // Server-side URL fetcher used by the Pyodide interceptor when a skill
        // declares fetches_urls: true and the LLM passes a URL argument that
        // the browser can't reach due to CORS.
        $r->post('/api/v1/fetch-url', ['UrlFetchController', 'fetch']);

        // ============================================
        // MODEL CATALOG (public - single source of truth
        // for model choices shown in gpt + gpt_admin)
        // ============================================
        $r->get('/api/v1/models/catalog', ['ModelCatalogController', 'get']);

        // ============================================
        // PACKAGE ROUTES (role-based capability bundles)
        // ============================================
        $r->get('/api/v1/me/package', ['PackageController', 'me']);
        $r->get('/api/v1/admin/packages', ['PackageController', 'adminList']);
        $r->get('/api/v1/admin/packages/{role:[a-z]+}', ['PackageController', 'adminGet']);
        $r->put('/api/v1/admin/packages/{role:[a-z]+}', ['PackageController', 'adminUpdate']);

        // ============================================
        // AFFILIATE ROUTES
        // ============================================
        // Admin (existing admin JWT / role=admin enforced in controller)
        $r->get('/api/v1/admin/affiliates', ['AffiliateController', 'adminList']);
        $r->post('/api/v1/admin/affiliates', ['AffiliateController', 'adminCreate']);
        $r->get('/api/v1/admin/affiliates/{id:\d+}', ['AffiliateController', 'adminGet']);
        $r->delete('/api/v1/admin/affiliates/{id:\d+}', ['AffiliateController', 'adminDelete']);
        $r->get('/api/v1/admin/affiliates/{id:\d+}/transactions', ['AffiliateController', 'adminTransactions']);
        $r->post('/api/v1/admin/affiliates/{id:\d+}/accounts', ['AffiliateController', 'adminAddAccount']);
        $r->delete('/api/v1/admin/affiliates/{id:\d+}/accounts/{productId:\d+}', ['AffiliateController', 'adminDeleteAccount']);
        $r->post('/api/v1/admin/affiliates/{id:\d+}/transactions/{saleId:\d+}/mark-paid', ['AffiliateController', 'adminMarkPaid']);

        $r->get('/api/v1/admin/affiliate-products', ['AffiliateController', 'adminListProducts']);
        $r->post('/api/v1/admin/affiliate-products', ['AffiliateController', 'adminCreateProduct']);
        $r->put('/api/v1/admin/affiliate-products/{id:\d+}', ['AffiliateController', 'adminUpdateProduct']);
        $r->delete('/api/v1/admin/affiliate-products/{id:\d+}', ['AffiliateController', 'adminDeleteProduct']);

        // Affiliate self-scope (role=affiliate enforced in controller)
        $r->get('/api/v1/affiliate/me', ['AffiliateController', 'me']);
        $r->get('/api/v1/affiliate/me/transactions', ['AffiliateController', 'myTransactions']);

        // Conversion endpoint — selling apps report a sale
        $r->post('/api/v1/affiliate/conversions', ['AffiliateController', 'recordConversion']);

        // ============================================
        // CONTEXT ROUTES
        // ============================================
        $r->get('/api/v1/contexts', ['ContextController', 'list']);
        $r->get('/api/v1/contexts/{id:\d+}', ['ContextController', 'get']);
        $r->post('/api/v1/contexts', ['ContextController', 'create']);
        $r->put('/api/v1/contexts/{id:\d+}', ['ContextController', 'update']);
        $r->delete('/api/v1/contexts/{id:\d+}', ['ContextController', 'delete']);

        // ============================================
        // PROVIDER ROUTES (Public)
        // ============================================
        $r->get('/api/v1/providers', ['ProviderController', 'list']);
        $r->post('/api/v1/providers', ['ProviderController', 'switch']); // Legacy: switch via POST to same endpoint
        $r->post('/api/v1/providers/switch', ['ProviderController', 'switch']);

        // ============================================
        // SETTINGS ROUTES
        // ============================================
        $r->get('/api/v1/settings/usage', ['SettingsController', 'getUsage']);
        $r->get('/api/v1/settings/keys', ['SettingsController', 'getKeys']);
        $r->post('/api/v1/settings/keys', ['SettingsController', 'saveKeys']);
        $r->delete('/api/v1/settings/keys', ['SettingsController', 'clearKeys']);
        $r->get('/api/v1/settings/providers', ['SettingsController', 'getProviderSettings']);
        $r->post('/api/v1/settings/provider', ['SettingsController', 'saveProvider']);
        $r->post('/api/v1/settings/provider/active', ['SettingsController', 'setActiveProvider']);
        $r->delete('/api/v1/settings/provider', ['SettingsController', 'deleteProvider']);
        $r->get('/api/v1/settings/phone', ['SettingsController', 'getPhoneStatus']);

        // Storage settings
        $r->get('/api/v1/settings/storage', ['SettingsController', 'getStorageSettings']);
        $r->post('/api/v1/settings/storage', ['SettingsController', 'saveStorageSettings']);

        // Auto-heal settings (self-healing mode + cost guards)
        $r->get('/api/v1/settings/heal', ['SettingsController', 'getHealSettings']);
        $r->post('/api/v1/settings/heal', ['SettingsController', 'saveHealSettings']);

        // Self-healing enforcement gate (mode/budget/ceiling)
        $r->post('/api/v1/heal/authorize', ['HealController', 'authorize']);
        $r->post('/api/v1/heal/record', ['HealController', 'record']);
        $r->get('/api/v1/heal/status', ['HealController', 'status']);

        // ============================================
        // FILE STORAGE ROUTES (universalFS)
        // ============================================
        $r->get('/api/v1/storage/providers', ['FileStorageController', 'getProviders']);
        $r->get('/api/v1/storage/list', ['FileStorageController', 'listFiles']);
        $r->get('/api/v1/storage/read', ['FileStorageController', 'readFile']);

        // ============================================
        // USAGE ROUTES
        // ============================================
        $r->get('/api/v1/usage', ['UsageController', 'getBalance']);
        $r->get('/api/v1/usage/balance', ['UsageController', 'getBalance']);
        $r->get('/api/v1/usage/transactions', ['UsageController', 'getTransactions']);
        $r->get('/api/v1/usage/stats', ['UsageController', 'getStats']);

        // ============================================
        // PROMPT LIBRARY ROUTES
        // ============================================
        $r->get('/api/v1/prompts', ['PromptLibraryController', 'getTree']);
        $r->get('/api/v1/prompts/{id:\d+}', ['PromptLibraryController', 'get']);
        $r->post('/api/v1/prompts', ['PromptLibraryController', 'create']);
        $r->put('/api/v1/prompts/{id:\d+}', ['PromptLibraryController', 'update']);
        $r->delete('/api/v1/prompts/{id:\d+}', ['PromptLibraryController', 'delete']);

        // ============================================
        // ADMIN ROUTES
        // ============================================
        $r->get('/api/v1/admin/users', ['AdminController', 'listUsers']);
        $r->get('/api/v1/admin/users/{id:\d+}', ['AdminController', 'getUser']);
        $r->get('/api/v1/admin/users/{id:\d+}/account', ['AdminController', 'getUserAccount']);
        $r->post('/api/v1/admin/users', ['AdminController', 'createUser']);
        $r->post('/api/v1/admin/users/update', ['AdminController', 'updateUser']);
        $r->delete('/api/v1/admin/users/{id:\d+}', ['AdminController', 'deleteUser']);
        $r->get('/api/v1/admin/users/{id:\d+}/providers', ['AdminController', 'getProviderSettings']);
        $r->post('/api/v1/admin/providers', ['AdminController', 'saveProvider']);
        $r->post('/api/v1/admin/providers/toggle', ['AdminController', 'toggleProviderEnabled']);
        $r->post('/api/v1/admin/providers/category-toggle', ['AdminController', 'toggleCategoryEnabled']);
        $r->delete('/api/v1/admin/providers', ['AdminController', 'deleteProvider']);
        $r->get('/api/v1/admin/users/{id:\d+}/costs', ['AdminController', 'getUserCosts']);
        $r->get('/api/v1/admin/users/{id:\d+}/keys', ['AdminController', 'getApiKeys']);
        $r->post('/api/v1/admin/keys', ['AdminController', 'saveApiKeys']);
        $r->post('/api/v1/admin/keys/delete', ['AdminController', 'deleteApiKey']);

        // Admin Usage Statistics Routes
        $r->get('/api/v1/admin/usage/stats', ['AdminController', 'getUsageStats']);
        $r->get('/api/v1/admin/usage/by-user', ['AdminController', 'getUsageByUser']);
        $r->get('/api/v1/admin/usage/users/{id:\d+}', ['AdminController', 'getUserUsageDetail']);
        $r->get('/api/v1/admin/usage/transactions', ['AdminController', 'getUsageTransactions']);
        $r->get('/api/v1/admin/usage/tools', ['AdminController', 'getToolStats']);

        // Admin MCP Server Management
        $r->get('/api/v1/admin/mcp/servers', ['AdminController', 'listMCPServers']);
        $r->post('/api/v1/admin/mcp/servers', ['AdminController', 'createMCPServer']);
        $r->post('/api/v1/admin/mcp/servers/update', ['AdminController', 'updateMCPServer']);
        $r->post('/api/v1/admin/mcp/servers/toggle', ['AdminController', 'toggleMCPServer']);
        $r->post('/api/v1/admin/mcp/servers/refresh', ['AdminController', 'refreshMCPServerTools']);
        $r->delete('/api/v1/admin/mcp/servers/{id:\d+}', ['AdminController', 'deleteMCPServer']);

        // Per-user MCP overrides — admin broadens/narrows the package allowlist
        // for one user (resolves: package → admin override → user pref).
        $r->get('/api/v1/admin/users/{id:\d+}/mcp-servers', ['AdminController', 'getUserMCPServers']);
        $r->put('/api/v1/admin/users/{id:\d+}/mcp-servers/{serverId:\d+}/override', ['AdminController', 'setUserMCPOverride']);
        $r->delete('/api/v1/admin/users/{id:\d+}/mcp-servers/{serverId:\d+}/override', ['AdminController', 'clearUserMCPOverride']);

        // Admin Costs Management (pricing data)
        $r->get('/api/v1/admin/costs', ['AdminController', 'getCosts']);
        $r->post('/api/v1/admin/costs/refresh', ['AdminController', 'refreshAllCosts']);
        $r->post('/api/v1/admin/costs/refresh-provider', ['AdminController', 'refreshProviderCosts']);
        $r->get('/api/v1/admin/exchange-rates', ['AdminController', 'getExchangeRates']);
        $r->post('/api/v1/admin/exchange-rates/refresh', ['AdminController', 'refreshExchangeRates']);

        // Admin System LLM Settings
        $r->get('/api/v1/admin/llm-settings', ['SystemSettingsController', 'getLLMProviders']);
        $r->get('/api/v1/admin/llm-settings/{key}', ['SystemSettingsController', 'getLLMProvider']);
        $r->post('/api/v1/admin/llm-settings', ['SystemSettingsController', 'saveLLMProvider']);
        $r->delete('/api/v1/admin/llm-settings/{key}', ['SystemSettingsController', 'deleteLLMProvider']);
        $r->post('/api/v1/admin/llm-settings/toggle', ['SystemSettingsController', 'toggleProvider']);
        $r->post('/api/v1/admin/llm-settings/seed', ['SystemSettingsController', 'seedFromConfig']);

        // ============================================
        // TOOLS ROUTES (List all available tools for LLM)
        // ============================================
        $r->get('/api/v1/tools', ['ToolsController', 'list']);
        $r->post('/api/v1/tools/execute', ['ToolsController', 'execute']);
        $r->post('/api/v1/tools/classify-intent', ['ToolsController', 'classifyIntent']);

        // ============================================
        // MCP SERVER ROUTES (per-user CRUD; admin endpoints live under /admin/mcp)
        // ============================================
        $r->get('/api/v1/mcp/servers', ['MCPServerController', 'list']);
        $r->get('/api/v1/mcp/servers/tools', ['MCPServerController', 'getTools']);
        $r->get('/api/v1/mcp/servers/all-tools', ['MCPServerController', 'getAllTools']);
        $r->post('/api/v1/mcp/servers', ['MCPServerController', 'create']);
        $r->post('/api/v1/mcp/servers/update', ['MCPServerController', 'update']);
        $r->post('/api/v1/mcp/servers/toggle', ['MCPServerController', 'toggle']);
        $r->delete('/api/v1/mcp/servers', ['MCPServerController', 'delete']);

        // ============================================
        // MCP PROXY ROUTES
        // ============================================
        $r->post('/api/v1/mcp/proxy', ['MCPProxyController', 'forward']);

        // ============================================
        // MCP APP ROUTES (Public - serves HTML)
        // ============================================
        $r->get('/api/v1/mcp/app', ['MCPAppController', 'getResource']);
        $r->get('/api/mcp-app.php', ['MCPAppController', 'getResource']); // Legacy path

        // ============================================
        // HUME TOOL ROUTES (Public)
        // ============================================
        $r->post('/api/v1/hume/tools/execute', ['HumeToolController', 'execute']);
        $r->get('/api/v1/hume/tools/list', ['HumeToolController', 'list']);
        $r->post('/api/v1/hume/tools/sync', ['HumeToolController', 'sync']);
        $r->get('/api/v1/hume/tools/status', ['HumeToolController', 'getStatus']);
        $r->get('/api/v1/hume/tools/test-connection', ['HumeToolController', 'testConnection']);
        $r->get('/api/v1/hume/config', ['HumeToolController', 'getConfig']);

        // ============================================
        // EVI WEBHOOK ROUTES (Public)
        // ============================================
        $r->post('/api/v1/evi/webhook', ['EVIWebhookController', 'handleWebhook']);

        // ============================================
        // WEBAUTHN (BIOMETRIC) ROUTES
        // ============================================
        $r->post('/api/v1/webauthn/challenge', ['WebAuthnController', 'challenge']);
        $r->post('/api/v1/webauthn/register', ['WebAuthnController', 'register']);
        $r->post('/api/v1/webauthn/authenticate', ['WebAuthnController', 'authenticate']);
        $r->delete('/api/v1/webauthn/register', ['WebAuthnController', 'delete']);

        // ============================================
        // VOICE USAGE ROUTES
        // ============================================
        $r->post('/api/v1/voice/usage', ['VoiceController', 'logUsage']);
        $r->get('/api/v1/voice/stats', ['VoiceController', 'getStats']);
        $r->post('/api/v1/voice/token', ['VoiceController', 'getEphemeralToken']);
        $r->get('/api/v1/voice/config', ['VoiceController', 'getConfig']);

        // ============================================
        // GOOGLE DRIVE ROUTES
        // ============================================
        $r->post('/api/v1/drive/save', ['DriveController', 'save']);

        // ============================================
        // ROOT / HEALTH CHECK
        // ============================================
        $r->get('/', ['RootController', 'index']);
        $r->get('/api/v1', ['RootController', 'index']);

        // ============================================
        // DEBUG ROUTE (TEMPORARY - REMOVE AFTER DEBUGGING)
        // ============================================
        $r->get('/api/v1/debug/auth', ['AuthController', 'debugAuth']);

        // ============================================
        // AGENT TEAM ROUTES
        // ============================================
        // Team CRUD
        $r->get('/api/v1/teams', ['AgentTeam:TeamController', 'index']);
        $r->post('/api/v1/teams', ['AgentTeam:TeamController', 'create']);
        $r->get('/api/v1/teams/{id:\d+}', ['AgentTeam:TeamController', 'show']);
        $r->put('/api/v1/teams/{id:\d+}', ['AgentTeam:TeamController', 'update']);
        $r->delete('/api/v1/teams/{id:\d+}', ['AgentTeam:TeamController', 'destroy']);
        $r->get('/api/v1/teams/{id:\d+}/agents', ['AgentTeam:TeamController', 'agents']);

        // Workflow CRUD and execution
        $r->get('/api/v1/workflows', ['AgentTeam:WorkflowController', 'index']);
        $r->post('/api/v1/workflows', ['AgentTeam:WorkflowController', 'create']);
        $r->get('/api/v1/workflows/{id:\d+}', ['AgentTeam:WorkflowController', 'show']);
        $r->get('/api/v1/workflows/{id:\d+}/generate-python', ['AgentTeam:WorkflowController', 'generatePython']);
        // Standalone config-driven ingestion compiler (separate from agent code) —
        // chunks/scripts are compiled from the node configs the frontend sends.
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/node-code', ['AgentTeam:IngestionController', 'nodeCode']);
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/compile', ['AgentTeam:IngestionController', 'compile']);
        // Interpreter (node-by-node): the loader node runs live and returns the
        // files-as-text shown in its Output tab; the splitter chunks that text.
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/loader-text', ['AgentTeam:IngestionController', 'loaderText']);
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/splitter-chunks', ['AgentTeam:IngestionController', 'splitterChunks']);
        // Store node: loader→split→write each chunk to the chosen vector-DB MCP.
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/store-chunks', ['AgentTeam:IngestionController', 'storeChunks']);
        // Store node retrieval test: qdrant-find against the chosen vector-DB MCP.
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/store-find', ['AgentTeam:IngestionController', 'storeFind']);
        // Closed event loop: server-side run (enumerate once → loop loader→split→store), SSE progress.
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/run-stream', ['AgentTeam:IngestionController', 'runStream']);
        // Parallel run (true multi-core): run-start enumerates + creates a shared
        // cursor; K concurrent run-worker SSE streams pull files work-stealing.
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/run-start', ['AgentTeam:IngestionController', 'runStart']);
        $r->post('/api/v1/workflows/{id:\d+}/ingestion/run-worker', ['AgentTeam:IngestionController', 'runWorker']);
        $r->put('/api/v1/workflows/{id:\d+}', ['AgentTeam:WorkflowController', 'update']);
        $r->delete('/api/v1/workflows/{id:\d+}', ['AgentTeam:WorkflowController', 'destroy']);
        $r->post('/api/v1/workflows/run', ['AgentTeam:WorkflowController', 'runByName']);
        $r->post('/api/v1/workflows/{id:\d+}/run', ['AgentTeam:WorkflowController', 'run']);
        $r->post('/api/v1/workflows/{id:\d+}/run-stream', ['AgentTeam:WorkflowController', 'runStream']);
        $r->post('/api/v1/workflows/tool-result', ['AgentTeam:WorkflowController', 'toolResult']);
        $r->get('/api/v1/workflows/{id:\d+}/executions', ['AgentTeam:WorkflowController', 'executions']);
        $r->post('/api/v1/workflows/{id:\d+}/toggle', ['AgentTeam:WorkflowController', 'toggle']);
        $r->post('/api/v1/workflows/{id:\d+}/duplicate', ['AgentTeam:WorkflowController', 'duplicate']);

        // Workflow output storage
        $r->get('/api/v1/workflows/{id:\d+}/outputs', ['AgentTeam:WorkflowController', 'listOutputs']);
        $r->get('/api/v1/workflows/{id:\d+}/outputs/{filename}', ['AgentTeam:WorkflowController', 'getOutput']);

        // Workflow output schemas (constrained decoding)
        $r->get('/api/v1/workflow-schemas',                ['AgentTeam:WorkflowSchemaController', 'index']);
        $r->post('/api/v1/workflow-schemas',               ['AgentTeam:WorkflowSchemaController', 'create']);
        $r->get('/api/v1/workflow-schemas/{id:\d+}',       ['AgentTeam:WorkflowSchemaController', 'show']);
        $r->put('/api/v1/workflow-schemas/{id:\d+}',       ['AgentTeam:WorkflowSchemaController', 'update']);
        $r->delete('/api/v1/workflow-schemas/{id:\d+}',    ['AgentTeam:WorkflowSchemaController', 'destroy']);

        // Workflow node document attachments
        $r->post('/api/v1/workflows/{id:\d+}/nodes/{nodeId:\d+}/documents', ['AgentTeam:WorkflowController', 'uploadNodeDocument']);
        $r->post('/api/v1/workflows/{id:\d+}/nodes/{nodeId:\d+}/documents/metadata', ['AgentTeam:WorkflowController', 'saveDocumentMetadata']);
        $r->get('/api/v1/workflows/{id:\d+}/nodes/{nodeId:\d+}/documents', ['AgentTeam:WorkflowController', 'listNodeDocuments']);
        $r->delete('/api/v1/workflows/{id:\d+}/nodes/{nodeId:\d+}/documents/{docId}', ['AgentTeam:WorkflowController', 'deleteNodeDocument']);

        // Agent CRUD and execution
        $r->get('/api/v1/agents', ['AgentTeam:AgentController', 'index']);
        $r->post('/api/v1/agents', ['AgentTeam:AgentController', 'create']);
        $r->get('/api/v1/agents/tools', ['AgentTeam:AgentController', 'listTools']);
        $r->post('/api/v1/agents/reorder', ['AgentTeam:AgentController', 'reorder']);
        // Agent categories (containers for the Agents sidebar service)
        $r->get('/api/v1/agents/categories', ['AgentTeam:AgentController', 'listCategories']);
        $r->put('/api/v1/agents/categories/rename', ['AgentTeam:AgentController', 'renameCategory']);
        $r->delete('/api/v1/agents/categories', ['AgentTeam:AgentController', 'deleteCategory']);
        $r->get('/api/v1/agents/{id:\d+}', ['AgentTeam:AgentController', 'show']);
        $r->put('/api/v1/agents/{id:\d+}', ['AgentTeam:AgentController', 'update']);
        $r->delete('/api/v1/agents/{id:\d+}', ['AgentTeam:AgentController', 'destroy']);
        $r->post('/api/v1/agents/{id:\d+}/run', ['AgentTeam:AgentController', 'run']);
        $r->post('/api/v1/agents/{id:\d+}/chat', ['AgentTeam:AgentController', 'chat']);
        $r->get('/api/v1/agents/{id:\d+}/executions', ['AgentTeam:AgentController', 'executions']);
        $r->post('/api/v1/agents/{id:\d+}/duplicate', ['AgentTeam:AgentController', 'duplicate']);
        $r->post('/api/v1/agents/{id:\d+}/move-up', ['AgentTeam:AgentController', 'moveUp']);
        $r->post('/api/v1/agents/{id:\d+}/move-down', ['AgentTeam:AgentController', 'moveDown']);

        // MCP JSON-RPC endpoint for AI client integration
        $r->post('/api/v1/mcp/agents', ['AgentTeam:AgentMCPController', 'handle']);

        // Skills are folder-backed under ~/Documents/synergyAI/skills/<dir>/.
        // The legacy DB skills/skill_categories tables and their CRUD routes
        // were removed once everything migrated to the filesystem.

        // User Memory (Hermes-style frozen memory — always injected into system prompt)
        $r->get('/api/v1/user-memories', ['AgentTeam:UserMemoryController', 'show']);
        $r->put('/api/v1/user-memories', ['AgentTeam:UserMemoryController', 'update']);
        $r->get('/api/v1/user-memories/events', ['AgentTeam:UserMemoryController', 'listEvents']);
        $r->delete('/api/v1/user-memories/events/{id:\d+}', ['AgentTeam:UserMemoryController', 'deleteEvent']);

        // App Keys — scoped credentials for client code (CRUD is admin-only;
        // whoami is app-key-authed so client code can introspect its key).
        $r->post('/api/v1/app-keys', ['AgentTeam:AppKeyController', 'create']);
        $r->get('/api/v1/app-keys', ['AgentTeam:AppKeyController', 'index']);
        $r->get('/api/v1/app-keys/whoami', ['AgentTeam:AppKeyController', 'whoami']);
        $r->get('/api/v1/app-keys/workflows', ['AgentTeam:AppKeyController', 'listUserWorkflows']);
        $r->get('/api/v1/app-keys/agents', ['AgentTeam:AppKeyController', 'listUserAgents']);
        $r->delete('/api/v1/app-keys/{id:\d+}', ['AgentTeam:AppKeyController', 'destroy']);

        // ============================================
        // SCHEDULED WORKFLOW ROUTES
        // ============================================
        $r->get('/api/v1/schedules', ['AgentTeam:ScheduledWorkflowController', 'index']);
        $r->post('/api/v1/schedules', ['AgentTeam:ScheduledWorkflowController', 'create']);
        $r->get('/api/v1/schedules/stats', ['AgentTeam:ScheduledWorkflowController', 'stats']);
        $r->get('/api/v1/schedules/{id:\d+}', ['AgentTeam:ScheduledWorkflowController', 'show']);
        $r->put('/api/v1/schedules/{id:\d+}', ['AgentTeam:ScheduledWorkflowController', 'update']);
        $r->delete('/api/v1/schedules/{id:\d+}', ['AgentTeam:ScheduledWorkflowController', 'destroy']);
        $r->post('/api/v1/schedules/{id:\d+}/pause', ['AgentTeam:ScheduledWorkflowController', 'pause']);
        $r->post('/api/v1/schedules/{id:\d+}/resume', ['AgentTeam:ScheduledWorkflowController', 'resume']);
        $r->get('/api/v1/workflows/{id:\d+}/schedules', ['AgentTeam:ScheduledWorkflowController', 'byWorkflow']);

        // ============================================
        // SCHEDULER ROUTES (Cron/Admin)
        // ============================================
        $r->post('/api/v1/scheduler/run', ['AgentTeam:SchedulerController', 'run']);
        $r->get('/api/v1/scheduler/status', ['AgentTeam:SchedulerController', 'status']);
    });
}

/**
 * Get controller class name from short name
 *
 * Supports namespaced controllers with prefix:
 * - 'AgentTeam:AgentController' => AgentTeam\Controllers\AgentController
 * - 'AuthController' => Quantis\AIPortfolioAssistant\Controllers\AuthController
 */
function getControllerClass(string $shortName): string
{
    // Check for AgentTeam namespace prefix
    if (str_starts_with($shortName, 'AgentTeam:')) {
        $controllerName = substr($shortName, strlen('AgentTeam:'));
        return 'AgentTeam\\Controllers\\' . $controllerName;
    }

    // Default to main namespace
    return 'Quantis\\AIPortfolioAssistant\\Controllers\\' . $shortName;
}
