/**
 * MCP (Model Context Protocol) Client
 *
 * JavaScript client for communicating with MCP servers through the backend proxy.
 * Implements JSON-RPC 2.0 protocol for tool discovery and execution.
 */

class MCPClient {
    constructor() {
        this.apiBaseUrl = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || '/gpt/backend/api/v1';
        this.servers = new Map(); // server_id -> server info
        this.tools = new Map();   // tool_name -> { server_id, tool_info }
        this.initialized = false;
        this.requestId = 1;
    }

    /**
     * Get current user ID
     */
    getUserId() {
        // Always resolve from the user record persisted in localStorage so the
        // same id is used whether authManager has hydrated yet or not. This keeps
        // create/list scoped to the same user — previously an early save could
        // fall back to 'demo-user' while list later queried under the real uid,
        // hiding the row and triggering 409 on retry.
        const stored = window.accountStore.getActiveUser();
        const fromStorage = stored?.id || stored?.uid;
        if (fromStorage) return String(fromStorage);

        if (window.authManager?.user) {
            return String(window.authManager.user.id || window.authManager.user.uid || 'demo-user');
        }
        return 'demo-user';
    }

    /**
     * Get auth token
     */
    getAuthToken() {
        if (window.authManager) {
            return window.authManager.token || '';
        }
        return localStorage.getItem('token') || '';
    }

    /**
     * Make API request
     */
    async request(endpoint, options = {}) {
        const url = `${this.apiBaseUrl}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.getAuthToken()}`
        };

        const response = await fetch(url, {
            ...options,
            headers: { ...headers, ...options.headers }
        });

        // Try to read the body once — most backend errors are JSON with an
        // actionable `error` field (e.g. "A server with this name already
        // exists"). Falling back to the bare status text hides that from users.
        const raw = await response.text();
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }

        if (!response.ok) {
            const detail = parsed?.error || parsed?.message || raw || response.statusText;
            throw new Error(`HTTP ${response.status}: ${detail}`);
        }

        return parsed ?? {};
    }

    /**
     * Load configured MCP servers from backend
     */
    async loadServers() {
        try {
            const userId = this.getUserId();
            const data = await this.request(`/mcp/servers?user_id=${encodeURIComponent(userId)}`);

            if (data.success) {
                this.servers.clear();
                for (const server of data.servers) {
                    this.servers.set(server.id, server);
                }
                return data.servers;
            }
            return [];
        } catch (error) {
            console.error('Failed to load MCP servers:', error);
            return [];
        }
    }

    /**
     * Add a new MCP server
     */
    async addServer(name, url, description = '', headers = {}) {
        try {
            const body = {
                action: 'add',
                user_id: this.getUserId(),
                name,
                url,
                description
            };
            if (headers && Object.keys(headers).length) {
                body.headers = headers;
            }
            const data = await this.request('/mcp/servers', {
                method: 'POST',
                body: JSON.stringify(body)
            });

            if (data.success && data.server_id) {
                // Reload servers to get the new one
                await this.loadServers();

                // Kick off tool discovery in the background so the UI can unblock
                // immediately. Slow MCP servers (tools/list takes seconds) would
                // otherwise leave the Save button stuck on "Saving…" for up to 120s.
                console.log('🔍 Auto-discovering tools for new server:', data.server_id);
                this.discoverTools(url, data.server_id)
                    .then(() => {
                        if (typeof window !== 'undefined' && window.settingsPanel?.loadMCPData) {
                            window.settingsPanel.loadMCPData();
                        }
                    })
                    .catch((err) => console.warn('Tool discovery failed (server still saved):', err));
            }

            return data;
        } catch (error) {
            console.error('Failed to add MCP server:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update an MCP server
     */
    async updateServer(serverId, name, url, description = '') {
        try {
            const data = await this.request('/mcp/servers/update', {
                method: 'POST',
                body: JSON.stringify({
                    user_id: this.getUserId(),
                    server_id: serverId,
                    name,
                    url,
                    description
                })
            });

            if (data.success) {
                await this.loadServers();

                // Rediscover tools (backend clears them when URL changes).
                // Non-blocking — see addServer rationale.
                console.log('🔍 Rediscovering tools for updated server:', serverId);
                this.discoverTools(url, serverId)
                    .then(() => {
                        if (typeof window !== 'undefined' && window.settingsPanel?.loadMCPData) {
                            window.settingsPanel.loadMCPData();
                        }
                    })
                    .catch((err) => console.warn('Tool rediscovery failed (server still updated):', err));
            }

            return data;
        } catch (error) {
            console.error('Failed to update MCP server:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete an MCP server
     */
    async deleteServer(serverId) {
        try {
            const userId = this.getUserId();
            const data = await this.request(
                `/mcp/servers?server_id=${serverId}&user_id=${encodeURIComponent(userId)}`,
                { method: 'DELETE' }
            );

            if (data.success) {
                this.servers.delete(serverId);
                // Remove tools from this server
                for (const [toolName, toolInfo] of this.tools) {
                    if (toolInfo.server_id === serverId) {
                        this.tools.delete(toolName);
                    }
                }
            }

            return data;
        } catch (error) {
            console.error('Failed to delete MCP server:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Toggle server enabled state
     */
    async toggleServer(serverId, enabled) {
        try {
            const data = await this.request('/mcp/servers/toggle', {
                method: 'POST',
                body: JSON.stringify({
                    user_id: this.getUserId(),
                    server_id: serverId,
                    enabled
                })
            });

            if (data.success) {
                const server = this.servers.get(serverId);
                if (server) {
                    server.enabled = enabled ? 1 : 0;
                }
            }

            return data;
        } catch (error) {
            console.error('Failed to toggle MCP server:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * List the current user's MCP servers (admin-provisioned + overrides)
     */
    async listMyMcpServers() {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-servers`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.getAuthToken()}`
            }
        });
        return res.json();
    }

    /**
     * Disable a specific MCP server for the current user (per-user override)
     */
    async disableMyMcpServer(id) {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-servers/${encodeURIComponent(id)}/override`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.getAuthToken()}`
            },
            body: JSON.stringify({ allowed: false })
        });
        return res.json();
    }

    /**
     * Remove the current user's override for a specific MCP server
     */
    async resetMyMcpServer(id) {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-servers/${encodeURIComponent(id)}/override`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.getAuthToken()}`
            }
        });
        return res.json();
    }

    /**
     * Enable/disable MCP entirely for the current user (master switch)
     */
    async setMcpMasterEnabled(enabled) {
        const res = await fetch(`${this.apiBaseUrl}/me/mcp-settings`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.getAuthToken()}`
            },
            body: JSON.stringify({ mcp_enabled: !!enabled })
        });
        return res.json();
    }

    /**
     * Test connection to an MCP server
     */
    async testConnection(serverUrl, headers = {}) {
        try {
            const body = {
                action: 'test_connection',
                server_url: serverUrl
            };
            if (headers && Object.keys(headers).length) {
                body.headers = headers;
            }
            const data = await this.request('/mcp/proxy', {
                method: 'POST',
                body: JSON.stringify(body)
            });

            return data;
        } catch (error) {
            console.error('Failed to test MCP connection:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Discover tools from an MCP server
     */
    async discoverTools(serverUrl, serverId = null) {
        try {
            const data = await this.request('/mcp/proxy', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'discover_tools',
                    server_url: serverUrl,
                    server_id: serverId,
                    user_id: this.getUserId()
                })
            });

            if (data.success && data.tools) {
                // Cache tools locally
                for (const tool of data.tools) {
                    this.tools.set(tool.name, {
                        server_id: serverId,
                        server_url: serverUrl,
                        ...tool
                    });
                }
            }

            return data;
        } catch (error) {
            console.error('Failed to discover MCP tools:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Load all tools from all enabled servers
     */
    async loadAllTools() {
        try {
            const userId = this.getUserId();
            const data = await this.request(`/mcp/servers/all-tools?user_id=${encodeURIComponent(userId)}`);

            if (data.success) {
                this.tools.clear();
                for (const tool of data.tools) {
                    this.tools.set(tool.tool_name, {
                        server_id: tool.server_id,
                        server_url: tool.server_url,
                        server_name: tool.server_name,
                        name: tool.tool_name,
                        description: tool.tool_description,
                        inputSchema: tool.input_schema,
                        hasUi: tool.has_ui === 1,
                        uiResourceUri: tool.ui_resource_uri
                    });
                }
                return Array.from(this.tools.values());
            }
            return [];
        } catch (error) {
            console.error('Failed to load MCP tools:', error);
            return [];
        }
    }

    /**
     * Call an MCP tool
     */
    async callTool(toolName, args = {}) {
        const tool = this.tools.get(toolName);
        if (!tool) {
            return { success: false, error: `Tool '${toolName}' not found` };
        }

        try {
            const data = await this.request('/mcp/proxy', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'proxy',
                    server_url: tool.server_url,
                    server_id: tool.server_id,
                    user_id: this.getUserId(),
                    jsonrpc: {
                        jsonrpc: '2.0',
                        id: this.requestId++,
                        method: 'tools/call',
                        params: {
                            name: toolName,
                            arguments: args
                        }
                    }
                })
            });

            if (data.success && data.response) {
                if (data.response.error) {
                    return {
                        success: false,
                        error: data.response.error.message || 'Tool execution failed'
                    };
                }
                return {
                    success: true,
                    result: data.response.result,
                    tool: tool
                };
            }

            return { success: false, error: 'Invalid response from MCP server' };
        } catch (error) {
            console.error(`Failed to call MCP tool '${toolName}':`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Fetch UI resource for a tool
     */
    async fetchUiResource(resourceUri, serverUrl) {
        try {
            const data = await this.request('/mcp/proxy', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'proxy',
                    server_url: serverUrl,
                    user_id: this.getUserId(),
                    jsonrpc: {
                        jsonrpc: '2.0',
                        id: this.requestId++,
                        method: 'resources/read',
                        params: {
                            uri: resourceUri
                        }
                    }
                })
            });

            if (data.success && data.response && data.response.result) {
                const contents = data.response.result.contents;
                if (contents && contents.length > 0) {
                    return {
                        success: true,
                        content: contents[0].text,
                        mimeType: contents[0].mimeType || 'text/html'
                    };
                }
            }

            return { success: false, error: 'Failed to fetch UI resource' };
        } catch (error) {
            console.error('Failed to fetch MCP UI resource:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get tool by name
     */
    getTool(toolName) {
        return this.tools.get(toolName);
    }

    /**
     * Get all tools as array
     */
    getAllTools() {
        return Array.from(this.tools.values());
    }

    /**
     * Get tools with UI
     */
    getToolsWithUi() {
        return this.getAllTools().filter(tool => tool.hasUi);
    }

    /**
     * Check if a tool exists
     */
    hasTool(toolName) {
        return this.tools.has(toolName);
    }

    /**
     * Get tool definitions in Claude/OpenAI format for AI integration
     */
    getToolDefinitions() {
        const definitions = [];

        for (const tool of this.tools.values()) {
            definitions.push({
                name: `mcp_${tool.name}`,
                description: `[MCP:${tool.server_name}] ${tool.description || tool.name}`,
                input_schema: tool.inputSchema || { type: 'object', properties: {} }
            });
        }

        return definitions;
    }

    /**
     * Initialize - load servers and tools
     */
    async initialize() {
        if (this.initialized) return;

        await this.loadServers();
        await this.loadAllTools();
        this.initialized = true;

        console.log(`MCP Client initialized: ${this.servers.size} servers, ${this.tools.size} tools`);
    }

    /**
     * Refresh - reload servers and tools
     */
    async refresh() {
        this.initialized = false;
        await this.initialize();
    }
}

// Create global instance
window.mcpClient = new MCPClient();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Delay initialization to ensure auth is ready
    setTimeout(() => {
        window.mcpClient.initialize().catch(err => {
            console.warn('MCP Client initialization deferred:', err.message);
        });
    }, 1000);
});
