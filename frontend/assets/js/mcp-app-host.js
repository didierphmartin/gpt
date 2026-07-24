/**
 * MCP App Host
 *
 * Manages sandboxed iframes for MCP app UIs and provides
 * the postMessage bridge for communication between apps and the chatbot.
 */

class MCPAppHost {
    constructor() {
        this.apps = new Map(); // appId -> { iframe, toolName, serverUrl, container }
        this.messageHandlers = new Map();
        this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
        this.requestId = 1;

        // Listen for messages from iframes
        window.addEventListener('message', this.handleMessage.bind(this));
    }

    /**
     * Create a sandboxed iframe for an MCP app UI
     */
    async createAppFrame(toolName, container, options = {}) {
        const tool = window.mcpClient?.getTool(toolName);
        if (!tool) {
            throw new Error(`Tool '${toolName}' not found`);
        }

        if (!tool.hasUi || !tool.uiResourceUri) {
            throw new Error(`Tool '${toolName}' does not have a UI resource`);
        }

        // Fetch UI resource content
        const uiResult = await window.mcpClient.fetchUiResource(
            tool.uiResourceUri,
            tool.server_url
        );

        if (!uiResult.success) {
            throw new Error(`Failed to fetch UI for '${toolName}': ${uiResult.error}`);
        }

        const appId = `mcp-app-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create container wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'mcp-app-wrapper';
        wrapper.id = appId;

        // Create header with app info and controls
        const header = document.createElement('div');
        header.className = 'mcp-app-header';
        header.innerHTML = `
            <span class="mcp-app-title">
                <span class="mcp-app-icon">🔧</span>
                ${tool.name}
                <span class="mcp-app-server">(${tool.server_name})</span>
            </span>
            <div class="mcp-app-controls">
                <button class="mcp-app-btn mcp-app-minimize" title="Minimize">−</button>
                <button class="mcp-app-btn mcp-app-close" title="Close">×</button>
            </div>
        `;
        wrapper.appendChild(header);

        // Create sandboxed iframe
        const iframe = document.createElement('iframe');
        iframe.className = 'mcp-app-frame';
        iframe.sandbox = 'allow-scripts allow-forms allow-same-origin allow-downloads allow-modals';
        iframe.allow = 'clipboard-write';

        // Inject the bridge script into the HTML content
        const bridgedContent = this.injectBridge(uiResult.content, appId, toolName);

        // Use srcdoc for sandboxed content
        iframe.srcdoc = bridgedContent;

        wrapper.appendChild(iframe);

        // Add loading indicator
        const loading = document.createElement('div');
        loading.className = 'mcp-app-loading';
        loading.innerHTML = '<div class="mcp-app-spinner"></div><span>Loading app...</span>';
        wrapper.appendChild(loading);

        // Append to container
        container.appendChild(wrapper);

        // Store app reference
        this.apps.set(appId, {
            iframe,
            toolName,
            serverUrl: tool.server_url,
            serverId: tool.server_id,
            container: wrapper,
            tool,
            minimized: false
        });

        // Setup header controls
        this.setupAppControls(appId, header);

        // Wait for iframe to load
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('App load timeout'));
            }, 30000);

            iframe.onload = () => {
                clearTimeout(timeout);
                loading.remove();
                resolve({ appId, iframe, tool });
            };

            iframe.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Failed to load app'));
            };
        });
    }

    /**
     * Inject the bridge script into HTML content
     */
    injectBridge(htmlContent, appId, toolName) {
        const bridgeScript = `
<script>
(function() {
    const APP_ID = '${appId}';
    const TOOL_NAME = '${toolName}';
    let requestId = 1;
    const pendingRequests = new Map();

    // MCP App Bridge API
    window.app = {
        // Call a tool on the MCP server
        callServerTool: function(name, args) {
            return sendRequest('callServerTool', { name, args });
        },

        // Send a message to the chat
        sendMessage: function(content, options = {}) {
            return sendRequest('sendMessage', { content, ...options });
        },

        // Log a message (for debugging)
        sendLog: function(level, message, data = null) {
            parent.postMessage({
                type: 'mcp-app-log',
                appId: APP_ID,
                level,
                message,
                data
            }, '*');
        },

        // Open a link in a new tab
        openLink: function(url) {
            parent.postMessage({
                type: 'mcp-app-openLink',
                appId: APP_ID,
                url
            }, '*');
        },

        // Get app info
        getInfo: function() {
            return { appId: APP_ID, toolName: TOOL_NAME };
        },

        // Close the app
        close: function() {
            parent.postMessage({
                type: 'mcp-app-close',
                appId: APP_ID
            }, '*');
        },

        // Request to resize
        resize: function(width, height) {
            parent.postMessage({
                type: 'mcp-app-resize',
                appId: APP_ID,
                width,
                height
            }, '*');
        }
    };

    function sendRequest(action, params) {
        return new Promise((resolve, reject) => {
            const id = requestId++;
            pendingRequests.set(id, { resolve, reject });

            parent.postMessage({
                type: 'mcp-app-request',
                appId: APP_ID,
                requestId: id,
                action,
                params
            }, '*');

            // Timeout after 60 seconds
            setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 60000);
        });
    }

    // Listen for responses from parent
    window.addEventListener('message', function(event) {
        const data = event.data;

        if (data.type === 'mcp-app-response' && data.appId === APP_ID) {
            const pending = pendingRequests.get(data.requestId);
            if (pending) {
                pendingRequests.delete(data.requestId);
                if (data.error) {
                    pending.reject(new Error(data.error));
                } else {
                    pending.resolve(data.result);
                }
            }
        }
    });

    // Notify parent that app is ready
    parent.postMessage({
        type: 'mcp-app-ready',
        appId: APP_ID
    }, '*');
})();
</script>
`;

        // Inject bridge script before closing body or at the end
        if (htmlContent.includes('</body>')) {
            return htmlContent.replace('</body>', bridgeScript + '</body>');
        } else if (htmlContent.includes('</html>')) {
            return htmlContent.replace('</html>', bridgeScript + '</html>');
        } else {
            return htmlContent + bridgeScript;
        }
    }

    /**
     * Setup app header controls
     */
    setupAppControls(appId, header) {
        const app = this.apps.get(appId);
        if (!app) return;

        const minimizeBtn = header.querySelector('.mcp-app-minimize');
        const closeBtn = header.querySelector('.mcp-app-close');

        minimizeBtn?.addEventListener('click', () => {
            this.toggleMinimize(appId);
        });

        closeBtn?.addEventListener('click', () => {
            this.closeApp(appId);
        });
    }

    /**
     * Handle messages from iframes
     */
    handleMessage(event) {
        const data = event.data;
        if (!data || !data.type?.startsWith('mcp-app-')) return;

        const app = this.apps.get(data.appId);
        if (!app) return;

        switch (data.type) {
            case 'mcp-app-ready':
                console.log(`MCP App ready: ${app.toolName}`);
                app.container.classList.add('mcp-app-loaded');
                break;

            case 'mcp-app-request':
                this.handleAppRequest(data, app);
                break;

            case 'mcp-app-log':
                this.handleAppLog(data);
                break;

            case 'mcp-app-openLink':
                this.handleOpenLink(data);
                break;

            case 'mcp-app-close':
                this.closeApp(data.appId);
                break;

            case 'mcp-app-resize':
                this.handleResize(data, app);
                break;
        }
    }

    /**
     * Handle requests from apps
     */
    async handleAppRequest(data, app) {
        const { requestId, action, params } = data;

        try {
            let result;

            switch (action) {
                case 'callServerTool':
                    result = await this.handleCallServerTool(params, app);
                    break;

                case 'sendMessage':
                    result = await this.handleSendMessage(params);
                    break;

                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            this.sendResponse(app.iframe, data.appId, requestId, result);
        } catch (error) {
            this.sendResponse(app.iframe, data.appId, requestId, null, error.message);
        }
    }

    /**
     * Handle callServerTool request
     */
    async handleCallServerTool(params, app) {
        const { name, args } = params;

        // Call tool through MCP client
        const result = await window.mcpClient.callTool(name, args || {});

        if (!result.success) {
            throw new Error(result.error || 'Tool call failed');
        }

        return result.result;
    }

    /**
     * Handle sendMessage request
     */
    async handleSendMessage(params) {
        const { content, role = 'assistant', ...options } = params;

        // Add message to chat
        if (window.chatApp) {
            // Create a message element for the MCP app response
            const messageData = {
                role,
                content,
                source: 'mcp-app',
                ...options
            };

            // Use the chat app's method to display message
            if (role === 'assistant') {
                window.chatApp.addMessage(content, 'ai');
            } else if (role === 'user') {
                window.chatApp.addMessage(content, 'user');
            }
        }

        return { success: true };
    }

    /**
     * Handle app log
     */
    handleAppLog(data) {
        const { level, message, appId } = data;
        const app = this.apps.get(appId);
        const prefix = `[MCP:${app?.toolName || appId}]`;

        switch (level) {
            case 'error':
                console.error(prefix, message, data.data);
                break;
            case 'warn':
                console.warn(prefix, message, data.data);
                break;
            case 'info':
                console.info(prefix, message, data.data);
                break;
            default:
                console.log(prefix, message, data.data);
        }
    }

    /**
     * Handle open link request
     */
    handleOpenLink(data) {
        const { url } = data;

        // Validate URL
        try {
            const parsed = new URL(url);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        } catch (e) {
            console.warn('Invalid URL:', url);
        }
    }

    /**
     * Handle resize request
     */
    handleResize(data, app) {
        const { width, height } = data;

        if (app.iframe) {
            if (width) app.iframe.style.width = typeof width === 'number' ? `${width}px` : width;
            if (height) app.iframe.style.height = typeof height === 'number' ? `${height}px` : height;
        }
    }

    /**
     * Send response back to iframe
     */
    sendResponse(iframe, appId, requestId, result, error = null) {
        iframe.contentWindow?.postMessage({
            type: 'mcp-app-response',
            appId,
            requestId,
            result,
            error
        }, '*');
    }

    /**
     * Toggle app minimize state
     */
    toggleMinimize(appId) {
        const app = this.apps.get(appId);
        if (!app) return;

        app.minimized = !app.minimized;
        app.container.classList.toggle('mcp-app-minimized', app.minimized);

        const btn = app.container.querySelector('.mcp-app-minimize');
        if (btn) {
            btn.textContent = app.minimized ? '+' : '−';
            btn.title = app.minimized ? 'Expand' : 'Minimize';
        }
    }

    /**
     * Close an app
     */
    closeApp(appId) {
        const app = this.apps.get(appId);
        if (!app) return;

        // Remove iframe and container
        app.container.remove();
        this.apps.delete(appId);

        console.log(`MCP App closed: ${app.toolName}`);
    }

    /**
     * Get all active apps
     */
    getActiveApps() {
        return Array.from(this.apps.entries()).map(([id, app]) => ({
            id,
            toolName: app.toolName,
            minimized: app.minimized
        }));
    }

    /**
     * Close all apps
     */
    closeAllApps() {
        for (const appId of this.apps.keys()) {
            this.closeApp(appId);
        }
    }

    /**
     * Check if an app is active
     */
    hasApp(toolName) {
        for (const app of this.apps.values()) {
            if (app.toolName === toolName) return true;
        }
        return false;
    }

    /**
     * Get app by tool name
     */
    getAppByTool(toolName) {
        for (const [id, app] of this.apps) {
            if (app.toolName === toolName) {
                return { id, ...app };
            }
        }
        return null;
    }
}

// Create global instance
window.mcpAppHost = new MCPAppHost();
