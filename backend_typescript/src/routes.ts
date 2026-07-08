import { Router, Request, Response } from 'express';
import multer from 'multer';
import { handle, buildCtx } from './Support/Http';
import { ChatAttachmentController } from './Controllers/ChatAttachmentController';
import { ModelCatalogController } from './Controllers/ModelCatalogController';
import { AuthController } from './Controllers/AuthController';
import { PromptLibraryController } from './Controllers/PromptLibraryController';
import { ChatController } from './Controllers/ChatController';
import { ProviderController } from './Controllers/ProviderController';
import { ContextController } from './Controllers/ContextController';
import { MCPServerController } from './Controllers/MCPServerController';
import { SettingsController } from './Controllers/SettingsController';
import { UserMemoryController } from './Controllers/UserMemoryController';
import { TeamController } from './Controllers/TeamController';
import { AgentController } from './Controllers/AgentController';
import { WorkflowController } from './Controllers/WorkflowController';
import { ScheduledWorkflowController } from './Controllers/ScheduledWorkflowController';
import { WorkflowSchemaController } from './Controllers/WorkflowSchemaController';
import { IngestionController } from './Controllers/IngestionController';
import { PackageController } from './Controllers/PackageController';
import { UrlFetchController } from './Controllers/UrlFetchController';
import { SystemSettingsController } from './Controllers/SystemSettingsController';
import { AdminController } from './Controllers/AdminController';
import { AppKeyController } from './Controllers/AppKeyController';
import { WebAuthnController } from './Controllers/WebAuthnController';
import { AffiliateController } from './Controllers/AffiliateController';
import { SchedulerController } from './Controllers/SchedulerController';
import { TracesController } from './Controllers/TracesController';
import { HealController } from './Controllers/HealController';
import { VoiceController } from './Controllers/VoiceController';

export const router = Router();

const modelCatalog = new ModelCatalogController();
const auth = new AuthController();
const prompts = new PromptLibraryController();
const chat = new ChatController();
const providers = new ProviderController();
const contexts = new ContextController();
const mcpServers = new MCPServerController();
const settings = new SettingsController();
const userMemories = new UserMemoryController();
const teams = new TeamController();
const agents = new AgentController();
const workflows = new WorkflowController();
const schedules = new ScheduledWorkflowController();
const workflowSchemas = new WorkflowSchemaController();
const ingestion = new IngestionController();
const chatAttachments = new ChatAttachmentController();
const pkg = new PackageController();
const urlFetch = new UrlFetchController();
const systemSettings = new SystemSettingsController();
const admin = new AdminController();
const appKeys = new AppKeyController();
const webauthn = new WebAuthnController();
const affiliates = new AffiliateController();
const scheduler = new SchedulerController();
const traces = new TracesController();
const heal = new HealController();
const voice = new VoiceController();
// In-memory multipart parsing for file uploads (the controller writes to disk itself). 50 MB cap
// matches ChatAttachmentController.MAX_BYTES; the controller returns the friendly 413 on its own check.
const uploadMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// Health (public)
router.get('/', handle(() => ({ success: true, status: 'ok', service: 'gpt-backend-typescript' })));

// Models catalog (public)
router.get('/api/v1/models/catalog', handle((ctx) => modelCatalog.get(ctx)));

// Current user's effective capability package (protected). Fixes the 404 hit on every page load.
router.get('/api/v1/me/package', handle((ctx) => pkg.me(ctx)));

// Server-side URL fetcher for Pyodide skills (protected). SSRF-guarded (bypassed for loopback).
router.post('/api/v1/fetch-url', handle((ctx) => urlFetch.fetch(ctx)));

// Providers (protected) — the provider picker's data source
router.get('/api/v1/providers', handle((ctx) => providers.list(ctx)));
router.post('/api/v1/providers', handle((ctx) => providers.switch(ctx)));
router.post('/api/v1/providers/switch', handle((ctx) => providers.switch(ctx)));

// Chat attachment upload (protected). multipart/form-data → multer puts the file on req.file.
router.post('/api/v1/chat/upload', uploadMw.single('file'), (req: Request, res: Response) => {
  chatAttachments.upload(req, res).catch((err) => {
    console.error('[chat/upload] unhandled', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
  });
});

// Chat (protected). Raw handler — it streams SSE, so it bypasses the JSON handle() wrapper.
router.post('/api/v1/chat', (req: Request, res: Response) => {
  chat.chat(req, res).catch((err) => {
    console.error('[chat] unhandled', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
  });
});

// Verify / Compare panes (protected). Raw handlers — both stream SSE, so they bypass handle().
router.post('/api/v1/verify', (req: Request, res: Response) => {
  chat.verify(req, res).catch((err) => {
    console.error('[verify] unhandled', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
  });
});
router.post('/api/v1/compare', (req: Request, res: Response) => {
  chat.compare(req, res).catch((err) => {
    console.error('[compare] unhandled', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
  });
});

// Auth (public)
router.post('/api/v1/auth', handle((ctx) => auth.handleAction(ctx)));
router.post('/api/v1/auth/login', handle((ctx) => auth.login(ctx)));
router.post('/api/v1/auth/register', handle((ctx) => auth.register(ctx)));
router.post('/api/v1/auth/firebase', handle((ctx) => auth.firebaseAuth(ctx)));
router.post('/api/v1/auth/verify', handle((ctx) => auth.verify(ctx)));
router.post('/api/v1/auth/logout', handle((ctx) => auth.logout(ctx)));

// Auth (protected — gated by the global auth middleware)
router.post('/api/v1/auth/link-phone', handle((ctx) => auth.linkPhone(ctx)));
router.post('/api/v1/auth/upgrade-plan', handle((ctx) => auth.upgradePlan(ctx)));

// WebAuthn / passkey login. challenge + authenticate are PUBLIC (in MiddlewareProcessor.PUBLIC_ROUTES);
// register (POST) + delete (DELETE) require auth. NB: PHP does NO signature verification (trusts the
// browser ceremony) — the TS port mirrors that faithfully.
router.post('/api/v1/webauthn/challenge', handle((ctx) => webauthn.challenge(ctx)));
router.post('/api/v1/webauthn/register', handle((ctx) => webauthn.register(ctx)));
router.post('/api/v1/webauthn/authenticate', handle((ctx) => webauthn.authenticate(ctx)));
router.delete('/api/v1/webauthn/register', handle((ctx) => webauthn.delete(ctx)));

// MCP server management (protected)
router.get('/api/v1/mcp/servers', handle((ctx) => mcpServers.list(ctx)));
router.get('/api/v1/mcp/servers/tools', handle((ctx) => mcpServers.getTools(ctx)));
router.get('/api/v1/mcp/servers/all-tools', handle((ctx) => mcpServers.getAllTools(ctx)));
router.post('/api/v1/mcp/servers', handle((ctx) => mcpServers.create(ctx)));
router.post('/api/v1/mcp/servers/update', handle((ctx) => mcpServers.update(ctx)));
router.post('/api/v1/mcp/servers/toggle', handle((ctx) => mcpServers.toggle(ctx)));
router.delete('/api/v1/mcp/servers', handle((ctx) => mcpServers.delete(ctx)));

// Settings (protected) — user API keys, usage, phone, storage, auto-heal.
router.get('/api/v1/settings/usage', handle((ctx) => settings.getUsage(ctx)));
router.get('/api/v1/settings/keys', handle((ctx) => settings.getKeys(ctx)));
router.post('/api/v1/settings/keys', handle((ctx) => settings.saveKeys(ctx)));
router.delete('/api/v1/settings/keys', handle((ctx) => settings.clearKeys(ctx)));
router.get('/api/v1/settings/phone', handle((ctx) => settings.getPhoneStatus(ctx)));
router.get('/api/v1/settings/storage', handle((ctx) => settings.getStorageSettings(ctx)));
router.post('/api/v1/settings/storage', handle((ctx) => settings.saveStorageSettings(ctx)));
router.get('/api/v1/settings/heal', handle((ctx) => settings.getHealSettings(ctx)));
router.post('/api/v1/settings/heal', handle((ctx) => settings.saveHealSettings(ctx)));
// Active avatar/voice provider selection (protected).
router.post('/api/v1/settings/provider/active', handle((ctx) => settings.setActiveProvider(ctx)));

// Admin — LLM settings (protected + admin-gated in the controller). Manages the
// system_llm_settings table (the chat app's provider config). :key is a provider_key STRING
// (e.g. "claude"), NOT digits — so it uses a plain param. The literal /toggle and /seed routes
// are registered BEFORE /:key so they aren't shadowed. PHP maps both POST and PUT to
// saveLLMProvider (POST = create at the collection path, PUT = update at /:key).
router.get('/api/v1/admin/llm-settings', handle((ctx) => systemSettings.getLLMProviders(ctx)));
router.post('/api/v1/admin/llm-settings', handle((ctx) => systemSettings.saveLLMProvider(ctx)));
router.post('/api/v1/admin/llm-settings/toggle', handle((ctx) => systemSettings.toggleProvider(ctx)));
router.post('/api/v1/admin/llm-settings/seed', handle((ctx) => systemSettings.seedFromConfig(ctx)));
router.get('/api/v1/admin/llm-settings/:key', handle((ctx) => systemSettings.getLLMProvider(ctx)));
router.put('/api/v1/admin/llm-settings/:key', handle((ctx) => systemSettings.saveLLMProvider(ctx)));
router.delete('/api/v1/admin/llm-settings/:key', handle((ctx) => systemSettings.deleteLLMProvider(ctx)));

// Admin — users (protected; AUTHENTICATION ONLY — AdminController.php has NO admin-role check, so
// these mirror that: no role gate beyond the global auth middleware). :id is digits-only. The
// literal POST /users/update route is distinct from the digit param routes (different method/path).
router.get('/api/v1/admin/users', handle((ctx) => admin.listUsers(ctx)));
router.post('/api/v1/admin/users', handle((ctx) => admin.createUser(ctx)));
router.post('/api/v1/admin/users/update', handle((ctx) => admin.updateUser(ctx)));
// Admin — per-user panels (keys / providers / MCP overrides / costs). Literal sub-paths
// (/keys, /keys/delete, /providers*) are registered before the digit-param routes.
router.post('/api/v1/admin/keys', handle((ctx) => admin.saveApiKeys(ctx)));
router.post('/api/v1/admin/keys/delete', handle((ctx) => admin.deleteApiKey(ctx)));
router.post('/api/v1/admin/providers/category-toggle', handle((ctx) => admin.toggleCategoryEnabled(ctx)));
router.post('/api/v1/admin/providers/toggle', handle((ctx) => admin.toggleProviderEnabled(ctx)));
router.post('/api/v1/admin/providers', handle((ctx) => admin.saveProvider(ctx)));
router.delete('/api/v1/admin/providers', handle((ctx) => admin.deleteProvider(ctx)));

router.get('/api/v1/admin/users/:id(\\d+)', handle((ctx) => admin.getUser(ctx)));
router.get('/api/v1/admin/users/:id(\\d+)/account', handle((ctx) => admin.getUserAccount(ctx)));
router.get('/api/v1/admin/users/:id(\\d+)/keys', handle((ctx) => admin.getApiKeys(ctx)));
router.get('/api/v1/admin/users/:id(\\d+)/providers', handle((ctx) => admin.getProviderSettings(ctx)));
router.get('/api/v1/admin/users/:id(\\d+)/mcp-servers', handle((ctx) => admin.getUserMCPServers(ctx)));
router.put(
  '/api/v1/admin/users/:id(\\d+)/mcp-servers/:serverId(\\d+)/override',
  handle((ctx) => admin.setUserMCPOverride(ctx))
);
router.delete(
  '/api/v1/admin/users/:id(\\d+)/mcp-servers/:serverId(\\d+)/override',
  handle((ctx) => admin.clearUserMCPOverride(ctx))
);
router.get('/api/v1/admin/users/:id(\\d+)/costs', handle((ctx) => admin.getUserCosts(ctx)));
router.delete('/api/v1/admin/users/:id(\\d+)', handle((ctx) => admin.deleteUser(ctx)));

// Admin — usage / analytics (read-only; same AUTHENTICATION-ONLY gating). Literal /usage/* paths
// are registered before the digit-param /usage/users/:id route. /costs + /exchange-rates literal.
router.get('/api/v1/admin/usage/stats', handle((ctx) => admin.getUsageStats(ctx)));
router.get('/api/v1/admin/usage/by-user', handle((ctx) => admin.getUsageByUser(ctx)));
router.get('/api/v1/admin/usage/transactions', handle((ctx) => admin.getUsageTransactions(ctx)));
router.get('/api/v1/admin/usage/tools', handle((ctx) => admin.getToolStats(ctx)));
router.get('/api/v1/admin/usage/users/:id(\\d+)', handle((ctx) => admin.getUserUsageDetail(ctx)));
router.get('/api/v1/admin/costs', handle((ctx) => admin.getCosts(ctx)));
router.get('/api/v1/admin/exchange-rates', handle((ctx) => admin.getExchangeRates(ctx)));

// Admin — cost / exchange-rate refresh (POST; same AUTHENTICATION-ONLY gating). These make REAL
// external calls (provider pricing pages + Claude Messages API; exchangerate-api / frankfurter).
router.post('/api/v1/admin/costs/refresh', handle((ctx) => admin.refreshAllCosts(ctx)));
router.post('/api/v1/admin/costs/refresh-provider', handle((ctx) => admin.refreshProviderCosts(ctx)));
router.post('/api/v1/admin/exchange-rates/refresh', handle((ctx) => admin.refreshExchangeRates(ctx)));

// Admin — MCP servers (protected; AUTHENTICATION ONLY — AdminController.php has NO admin-role check).
// Global/per-user MCP server CRUD, distinct from the per-user /api/v1/mcp/servers (MCPServerController).
// Literal sub-paths (/update, /toggle, /refresh) are registered before the digit-param DELETE route.
router.get('/api/v1/admin/mcp/servers', handle((ctx) => admin.listMCPServers(ctx)));
router.post('/api/v1/admin/mcp/servers', handle((ctx) => admin.createMCPServer(ctx)));
router.post('/api/v1/admin/mcp/servers/update', handle((ctx) => admin.updateMCPServer(ctx)));
router.post('/api/v1/admin/mcp/servers/toggle', handle((ctx) => admin.toggleMCPServer(ctx)));
router.post('/api/v1/admin/mcp/servers/refresh', handle((ctx) => admin.refreshMCPServerTools(ctx)));
router.delete('/api/v1/admin/mcp/servers/:id(\\d+)', handle((ctx) => admin.deleteMCPServer(ctx)));

// Admin — capability packages (protected; PackageController gates on role=admin, unlike AdminController).
// :role is letters-only ([a-z]+) so the list route isn't shadowed.
router.get('/api/v1/admin/packages', handle((ctx) => pkg.adminList(ctx)));
router.get('/api/v1/admin/packages/:role([a-z]+)', handle((ctx) => pkg.adminGet(ctx)));
router.put('/api/v1/admin/packages/:role([a-z]+)', handle((ctx) => pkg.adminUpdate(ctx)));

// Admin — app keys (protected; AppKeyController gates on role=admin, except whoami which requires
// app-key auth). Scoped, revocable `ak_` credentials. Literal sub-paths (/whoami, /workflows,
// /agents) are registered BEFORE the digit-param /:id route so they aren't shadowed. destroy is a
// soft-delete (sets revoked_at). PHP maps these under /api/v1/app-keys.
router.post('/api/v1/app-keys', handle((ctx) => appKeys.create(ctx)));
router.get('/api/v1/app-keys', handle((ctx) => appKeys.index(ctx)));
router.get('/api/v1/app-keys/whoami', handle((ctx) => appKeys.whoami(ctx)));
router.get('/api/v1/app-keys/workflows', handle((ctx) => appKeys.listUserWorkflows(ctx)));
router.get('/api/v1/app-keys/agents', handle((ctx) => appKeys.listUserAgents(ctx)));
router.delete('/api/v1/app-keys/:id(\\d+)', handle((ctx) => appKeys.destroy(ctx)));

// Admin — affiliates (protected; AffiliateController gates every method on role=admin via
// requireAdmin). Uses the standard handle() like every other endpoint: the frontend consumes
// responses via .json(), which normalizes PHP's escaped-slash/float-expansion byte quirks away, so
// parse-equality is the fidelity bar (matches all other ported controllers). Literal
// /affiliate-products* routes and the /affiliates collection are registered BEFORE the
// digit-param /affiliates/:id routes; :id/:productId/:saleId are digits-only (\d+).
router.get('/api/v1/admin/affiliates', handle((ctx) => affiliates.adminList(ctx)));
router.post('/api/v1/admin/affiliates', handle((ctx) => affiliates.adminCreate(ctx)));
router.get('/api/v1/admin/affiliate-products', handle((ctx) => affiliates.adminListProducts(ctx)));
router.post('/api/v1/admin/affiliate-products', handle((ctx) => affiliates.adminCreateProduct(ctx)));
router.put('/api/v1/admin/affiliate-products/:id(\\d+)', handle((ctx) => affiliates.adminUpdateProduct(ctx)));
router.delete('/api/v1/admin/affiliate-products/:id(\\d+)', handle((ctx) => affiliates.adminDeleteProduct(ctx)));
router.get('/api/v1/admin/affiliates/:id(\\d+)', handle((ctx) => affiliates.adminGet(ctx)));
router.delete('/api/v1/admin/affiliates/:id(\\d+)', handle((ctx) => affiliates.adminDelete(ctx)));
router.get('/api/v1/admin/affiliates/:id(\\d+)/transactions', handle((ctx) => affiliates.adminTransactions(ctx)));
router.post('/api/v1/admin/affiliates/:id(\\d+)/accounts', handle((ctx) => affiliates.adminAddAccount(ctx)));
router.put('/api/v1/admin/affiliates/:id(\\d+)/accounts/:productId(\\d+)', handle((ctx) => affiliates.adminUpdateAccount(ctx)));
router.delete('/api/v1/admin/affiliates/:id(\\d+)/accounts/:productId(\\d+)', handle((ctx) => affiliates.adminDeleteAccount(ctx)));
router.post('/api/v1/admin/affiliates/:id(\\d+)/transactions/:saleId(\\d+)/mark-paid', handle((ctx) => affiliates.adminMarkPaid(ctx)));

// Affiliate self-scope (protected; requireAffiliate resolves the caller's affiliate row by user_id)
// + conversion recording (any authenticated caller). Same PHP-faithful serialization as above.
router.get('/api/v1/affiliate/me', handle((ctx) => affiliates.me(ctx)));
router.get('/api/v1/affiliate/me/transactions', handle((ctx) => affiliates.myTransactions(ctx)));
router.post('/api/v1/affiliate/conversions', handle((ctx) => affiliates.recordConversion(ctx)));

// User memories (protected) — Settings → Memory panel. /events routes before the param route.
router.get('/api/v1/user-memories', handle((ctx) => userMemories.show(ctx)));
router.put('/api/v1/user-memories', handle((ctx) => userMemories.update(ctx)));
router.get('/api/v1/user-memories/events', handle((ctx) => userMemories.listEvents(ctx)));
router.delete('/api/v1/user-memories/events/:id(\\d+)', handle((ctx) => userMemories.deleteEvent(ctx)));

// Contexts / conversation history (protected)
router.get('/api/v1/contexts', handle((ctx) => contexts.list(ctx)));
router.get('/api/v1/contexts/:id(\\d+)', handle((ctx) => contexts.get(ctx)));
router.post('/api/v1/contexts', handle((ctx) => contexts.create(ctx)));
router.put('/api/v1/contexts/:id(\\d+)', handle((ctx) => contexts.update(ctx)));
router.delete('/api/v1/contexts/:id(\\d+)', handle((ctx) => contexts.delete(ctx)));

// Teams (protected) — the AgentTeam module's team management.
router.get('/api/v1/teams', handle((ctx) => teams.index(ctx)));
router.post('/api/v1/teams', handle((ctx) => teams.create(ctx)));
router.get('/api/v1/teams/:id(\\d+)', handle((ctx) => teams.show(ctx)));
router.put('/api/v1/teams/:id(\\d+)', handle((ctx) => teams.update(ctx)));
router.delete('/api/v1/teams/:id(\\d+)', handle((ctx) => teams.destroy(ctx)));
router.get('/api/v1/teams/:id(\\d+)/agents', handle((ctx) => teams.agents(ctx)));

// Agents (protected) — the AgentTeam module's agent management. Literal sub-paths
// (tools/reorder/categories/categories/rename) are registered BEFORE the :id param routes
// so they aren't shadowed. executions is a plain DB read; run/chat need the execution engine.
router.get('/api/v1/agents', handle((ctx) => agents.index(ctx)));
router.post('/api/v1/agents', handle((ctx) => agents.create(ctx)));
router.get('/api/v1/agents/tools', handle((ctx) => agents.listTools(ctx)));
router.post('/api/v1/agents/reorder', handle((ctx) => agents.reorder(ctx)));
router.get('/api/v1/agents/categories', handle((ctx) => agents.listCategories(ctx)));
router.put('/api/v1/agents/categories/rename', handle((ctx) => agents.renameCategory(ctx)));
router.delete('/api/v1/agents/categories', handle((ctx) => agents.deleteCategory(ctx)));
router.get('/api/v1/agents/:id(\\d+)', handle((ctx) => agents.show(ctx)));
router.get('/api/v1/agents/:id(\\d+)/executions', handle((ctx) => agents.executions(ctx)));
router.put('/api/v1/agents/:id(\\d+)', handle((ctx) => agents.update(ctx)));
router.delete('/api/v1/agents/:id(\\d+)', handle((ctx) => agents.destroy(ctx)));
router.post('/api/v1/agents/:id(\\d+)/duplicate', handle((ctx) => agents.duplicate(ctx)));
router.post('/api/v1/agents/:id(\\d+)/move-up', handle((ctx) => agents.moveUp(ctx)));
router.post('/api/v1/agents/:id(\\d+)/move-down', handle((ctx) => agents.moveDown(ctx)));

// Agent execution (Slice 1a). run is a JSON endpoint via handle(); chat streams SSE so it uses a
// raw handler (like /chat) that finishes with `data: [DONE]\n\n`.
router.post('/api/v1/agents/:id(\\d+)/run', handle((ctx) => agents.run(ctx)));
router.post('/api/v1/agents/:id(\\d+)/chat', (req: Request, res: Response) => {
  agents.chat(req, res).catch((err) => {
    console.error('[agents.chat] unhandled', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
  });
});

// Workflow schemas (protected) — reusable JSON Schemas for constrained decoding. Registered
// before the /workflows routes; distinct prefix so no shadowing concerns.
router.get('/api/v1/workflow-schemas', handle((ctx) => workflowSchemas.index(ctx)));
router.post('/api/v1/workflow-schemas', handle((ctx) => workflowSchemas.create(ctx)));
router.get('/api/v1/workflow-schemas/:id(\\d+)', handle((ctx) => workflowSchemas.show(ctx)));
router.put('/api/v1/workflow-schemas/:id(\\d+)', handle((ctx) => workflowSchemas.update(ctx)));
router.delete('/api/v1/workflow-schemas/:id(\\d+)', handle((ctx) => workflowSchemas.destroy(ctx)));

// Workflows (protected) — the AgentTeam module's workflow management CRUD slice. The :id param
// routes are digits-only (\d+); the /:id/toggle|duplicate|executions sub-paths are distinct, so
// they don't shadow the bare routes. Execution/ingestion/storage endpoints are deferred.
router.get('/api/v1/workflows', handle((ctx) => workflows.index(ctx)));
router.post('/api/v1/workflows', handle((ctx) => workflows.create(ctx)));
// Client-tool round-trip: the browser posts a client-side skill result back here. `tool-result` is a
// literal segment (won't match :id(\d+)) but keep it with the workflow literals, registered before
// the :id param routes so it can never be shadowed.
router.post('/api/v1/workflows/tool-result', handle((ctx) => workflows.toolResult(ctx)));
router.get('/api/v1/workflows/:id(\\d+)', handle((ctx) => workflows.show(ctx)));
router.put('/api/v1/workflows/:id(\\d+)', handle((ctx) => workflows.update(ctx)));
router.delete('/api/v1/workflows/:id(\\d+)', handle((ctx) => workflows.destroy(ctx)));
router.post('/api/v1/workflows/:id(\\d+)/toggle', handle((ctx) => workflows.toggle(ctx)));
router.post('/api/v1/workflows/:id(\\d+)/duplicate', handle((ctx) => workflows.duplicate(ctx)));
router.get('/api/v1/workflows/:id(\\d+)/executions', handle((ctx) => workflows.executions(ctx)));
// Per-run JSONL replay (WorkflowRunLog). Registered among the workflow literals — the runId param is
// hex-constrained so it can't collide with the numeric :id(\d+) routes above.
router.get('/api/v1/workflows/runs/:runId([a-f0-9]{32})/events', handle((ctx) => workflows.runEvents(ctx)));

// Stored workflow outputs (WorkflowOutputStorage). List is registered before the :filename param
// route so it isn't shadowed.
router.get('/api/v1/workflows/:id(\\d+)/outputs', handle((ctx) => workflows.listOutputs(ctx)));
router.get('/api/v1/workflows/:id(\\d+)/outputs/:filename', handle((ctx) => workflows.getOutput(ctx)));

// Workflow node documents (metadata stored in the node config). The /metadata literal is registered
// before the :docId param route so it isn't shadowed.
router.post('/api/v1/workflows/:id(\\d+)/nodes/:nodeId(\\d+)/documents/metadata', handle((ctx) => workflows.saveDocumentMetadata(ctx)));
router.get('/api/v1/workflows/:id(\\d+)/nodes/:nodeId(\\d+)/documents', handle((ctx) => workflows.listNodeDocuments(ctx)));
router.delete('/api/v1/workflows/:id(\\d+)/nodes/:nodeId(\\d+)/documents/:docId', handle((ctx) => workflows.deleteNodeDocument(ctx)));

// Workflow execution. run is a JSON endpoint via handle(); run-stream streams SSE so it uses a raw
// handler (like /chat) that finishes with `data: [DONE]\n\n`.
router.post('/api/v1/workflows/:id(\\d+)/run', handle((ctx) => workflows.run(ctx)));
router.post('/api/v1/workflows/:id(\\d+)/run-stream', (req: Request, res: Response) => {
  workflows.runStream(req, res).catch((err) => {
    console.error('[workflows.run-stream] unhandled', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
  });
});

// Generate Python (protected). Raw handler — the ?download=1 response streams a Python body with
// custom headers, which the JSON handle() wrapper can't do. JSON shape otherwise.
router.get('/api/v1/workflows/:id(\\d+)/generate-python', async (req: Request, res: Response) => {
  try {
    const result = await workflows.generatePython(buildCtx(req));
    const status = (result.status_code as number) ?? 200;
    if (result.raw_body !== undefined) {
      res.status(status);
      for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v as string);
      res.end(result.raw_body);
    } else {
      const { status_code, ...body } = result;
      void status_code;
      res.status(status).json(body);
    }
  } catch (err: any) {
    console.error('[generate-python] unhandled', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
  }
});

// RAG ingestion (protected). compile = full standalone script; node-code = one node's (or the
// ordered stages') Python view; save-script = persist a compiled script; store-find = retrieval
// test against the vector-DB MCP. run-start enumerates the source + creates a shared run record
// (JSON); run-worker is ONE parallel worker that claims + processes files, streaming SSE.
router.post('/api/v1/workflows/:id(\\d+)/ingestion/compile', handle((ctx) => ingestion.compile(ctx)));
router.post('/api/v1/workflows/:id(\\d+)/ingestion/node-code', handle((ctx) => ingestion.nodeCode(ctx)));
router.post('/api/v1/workflows/:id(\\d+)/ingestion/save-script', handle((ctx) => ingestion.saveScript(ctx)));
router.post('/api/v1/workflows/:id(\\d+)/ingestion/store-find', handle((ctx) => ingestion.storeFind(ctx)));
router.post('/api/v1/workflows/:id(\\d+)/ingestion/run-start', handle((ctx) => ingestion.runStart(ctx)));
// run-worker streams SSE — raw handler (mirror of /run-stream): set SSE headers, write each emitted
// event as `data: <json>\n\n`, and terminate with `data: [DONE]\n\n`. PHP's connection_aborted() is
// mirrored by a close flag on the request.
router.post('/api/v1/workflows/:id(\\d+)/ingestion/run-worker', (req: Request, res: Response) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });
  const sse = (event: Record<string, any>) => {
    if (!res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n');
  };
  const done = () => {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  ingestion
    .runWorker(buildCtx(req), sse, () => aborted)
    .then(done)
    .catch((err) => {
      console.error('[ingestion.run-worker] unhandled', err);
      done();
    });
});

// Scheduled workflows (protected) — the AgentTeam module's schedule CRUD. IMPORTANT: the
// literal /schedules/stats is registered BEFORE /schedules/:id(\d+) so it isn't shadowed.
router.get('/api/v1/schedules', handle((ctx) => schedules.index(ctx)));
router.post('/api/v1/schedules', handle((ctx) => schedules.create(ctx)));
router.get('/api/v1/schedules/stats', handle((ctx) => schedules.stats(ctx)));
router.get('/api/v1/schedules/:id(\\d+)', handle((ctx) => schedules.show(ctx)));
router.put('/api/v1/schedules/:id(\\d+)', handle((ctx) => schedules.update(ctx)));
router.delete('/api/v1/schedules/:id(\\d+)', handle((ctx) => schedules.destroy(ctx)));
router.post('/api/v1/schedules/:id(\\d+)/pause', handle((ctx) => schedules.pause(ctx)));
router.post('/api/v1/schedules/:id(\\d+)/resume', handle((ctx) => schedules.resume(ctx)));
// Schedules for a specific workflow — the 404 the workflow editor hits on every load.
router.get('/api/v1/workflows/:id(\\d+)/schedules', handle((ctx) => schedules.byWorkflow(ctx)));

// Scheduler cron-execution engine (SchedulerController). /run is PUBLIC (in
// MiddlewareProcessor.PUBLIC_ROUTES) — it does its own scheduler-token validation for cron access;
// /status requires user auth.
router.post('/api/v1/scheduler/run', handle((ctx) => scheduler.run(ctx)));
router.get('/api/v1/scheduler/status', handle((ctx) => scheduler.status(ctx)));

// Execution traces (protected) — Phase 0 self-healing. Chat posts a classified trace per skill
// run; diagnosis is a read-only per-skill verdict aggregate. Both require auth (no public routes).
router.post('/api/v1/traces', handle((ctx) => traces.create(ctx)));
router.get('/api/v1/traces/diagnosis', handle((ctx) => traces.diagnose(ctx)));

// Self-heal enforcement gate (protected) — server-side budget/ceiling authorization + spend ledger.
router.post('/api/v1/heal/authorize', handle((ctx) => heal.authorize(ctx)));
router.post('/api/v1/heal/record', handle((ctx) => heal.record(ctx)));
router.get('/api/v1/heal/status', handle((ctx) => heal.status(ctx)));

// Voice (protected — none of /api/v1/voice/* are in MiddlewareProcessor.PUBLIC_ROUTES, so all four
// require auth; the retired Hume/EVI path is not ported). New voice: Grok (ephemeral token brokered
// here) + Gemini (client connects direct to Google; backend only brokers the key via /voice/config).
router.post('/api/v1/voice/usage', handle((ctx) => voice.logUsage(ctx)));
router.get('/api/v1/voice/stats', handle((ctx) => voice.getStats(ctx)));
router.post('/api/v1/voice/token', handle((ctx) => voice.getEphemeralToken(ctx)));
router.get('/api/v1/voice/config', handle((ctx) => voice.getConfig(ctx)));

// Prompts (protected). {id} is digits-only, matching FastRoute \d+.
router.get('/api/v1/prompts', handle((ctx) => prompts.getTree(ctx)));
router.get('/api/v1/prompts/:id(\\d+)', handle((ctx) => prompts.get(ctx)));
router.post('/api/v1/prompts', handle((ctx) => prompts.create(ctx)));
router.put('/api/v1/prompts/:id(\\d+)', handle((ctx) => prompts.update(ctx)));
router.delete('/api/v1/prompts/:id(\\d+)', handle((ctx) => prompts.delete(ctx)));
