/**
 * File Storage Manager
 *
 * Provides a treeview interface for browsing files from universalFS.
 * Displays file contents in the main content area when selected.
 */
class FileStorageManager {
    constructor() {
        this.apiBaseUrl = '/gpt/backend/api/v1';
        this.treeContainer = document.getElementById('file-tree-container');
        this.refreshBtn = document.getElementById('refresh-files-btn');
        this.fileContentPanel = document.getElementById('file-content-panel');
        this.primaryPane = document.getElementById('primary-pane');
        this.currentProvider = 'local';
        this.userFolder = ''; // User's folder name from settings
        this.isActive = false;

        // True-tree state (replaces the previous currentPath/pathStack
        // flat-navigation model). Each folder's children are fetched
        // lazily on first expansion and cached for the page session.
        // The root folder's path is the empty string ''.
        this.expandedPaths = new Set();      // paths currently expanded
        this.childrenCache = new Map();      // path -> items[]
        this.loadingPaths = new Set();       // paths currently being fetched

        this.init();
    }

    /**
     * Initialize the file storage manager
     */
    init() {
        if (!this.treeContainer) {
            console.warn('[FileStorage] Required elements not found');
            return;
        }

        // Refresh button handler
        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => this.loadFiles());
        }

        // Delegate click handling for tree items
        this.treeContainer.addEventListener('click', (e) => this.handleTreeClick(e));
    }

    /**
     * Translation helper
     */
    t(key) {
        return window.i18n?.t(key) || key.split('.').pop();
    }

    /**
     * Show the file storage view. The sidebar tree itself is what File
     * Storage actually IS — there's no main-area takeover. The chat panel
     * (and the rest of the conversation area) stays visible at all times;
     * the user just gets a tree they can expand/collapse on the side.
     */
    async show() {
        this.isActive = true;
        // Use the local FSA-granted folder name as the visible root label.
        // (Previously we read settings from the backend, which was the
        // server-side universalFS path — a different namespace entirely.)
        try {
            const root = await window.localFs?.getRootHandle?.();
            this.userFolder = root?.name || 'synergyAI';
        } catch {
            this.userFolder = 'synergyAI';
        }
        await this.loadFiles();
    }

    /**
     * Get auth token for API calls
     */
    getAuthToken() {
        if (window.authManager) {
            return window.authManager.token || '';
        }
        return localStorage.getItem('token') || '';
    }

    /**
     * Load user's storage settings from backend
     */
    async loadStorageSettings() {
        try {
            const response = await fetch(`${this.apiBaseUrl}/settings/storage`, {
                headers: {
                    'Authorization': `Bearer ${this.getAuthToken()}`
                }
            });
            const result = await response.json();

            if (result.success && result.data) {
                const data = result.data;

                // Use user's configured provider and folder
                if (data.provider) {
                    this.currentProvider = data.provider;
                }
                if (data.folder) {
                    this.userFolder = data.folder; // User's folder name (e.g., "workflow")
                    this.currentPath = ''; // Start at root of user's folder (relative path)
                }

                // Reset path stack when reloading settings
                this.pathStack = [];

                console.log('[FileStorage] Loaded settings:', {
                    provider: this.currentProvider,
                    userFolder: this.userFolder
                });
            }
        } catch (error) {
            console.error('[FileStorage] Failed to load storage settings:', error);
        }
    }

    /**
     * Hide the file storage view
     */
    hide() {
        this.isActive = false;

        // Hide file content panel, show primary pane
        if (this.fileContentPanel && this.primaryPane) {
            this.fileContentPanel.classList.add('hidden');
            this.primaryPane.classList.remove('hidden');
        }
    }

    /**
     * Get display name for a provider
     */
    getProviderName(providerId) {
        const names = {
            'local': 'Local Filesystem',
            'gdrive': 'Google Drive',
            's3': 'Amazon S3',
            'onedrive': 'OneDrive'
        };
        return names[providerId] || providerId.charAt(0).toUpperCase() + providerId.slice(1);
    }

    /**
     * Load files for the current path
     */
    /**
     * Top-level entry: ensure the root is fetched + expanded, then render.
     * The user always sees the root expanded showing its children; deeper
     * folders are loaded lazily on first expansion.
     */
    async loadFiles() {
        this.expandedPaths.add('');           // root always expanded
        this.childrenCache.delete('');        // refresh button forces a re-fetch of root
        this.showLoading();
        await this.fetchChildren('');
        this.renderTree();
    }

    /**
     * Fetch the children of one folder under the local synergyAI root,
     * via the File System Access API handle stored on window.localFs.
     * Caches results per session — refresh button (loadFiles) clears the
     * root entry to force a re-read.
     *
     * Path is relative to the FSA root: '' is the root, 'skills' walks
     * into the skills folder, 'skills/SEO' into a subfolder, etc.
     */
    async fetchChildren(path) {
        if (this.childrenCache.has(path)) return this.childrenCache.get(path);
        if (this.loadingPaths.has(path)) return null;
        if (!window.localFs?.resolvePath) {
            this.childrenCache.set(path, []);
            this._setSidebarNotice('Local file system API not available in this browser. Use Chrome, Edge, or Brave.');
            return [];
        }

        // Diagnose permission state up-front for the root fetch so an
        // empty result doesn't get confused with "no permission yet".
        // Chrome can silently downgrade the grant to 'prompt' after a
        // session restart; the user needs to re-grant before we can
        // read anything. Surface a clickable banner in that case.
        if (path === '' && typeof window.localFs.getStatus === 'function') {
            const status = await window.localFs.getStatus();
            console.log('[FileStorage] window.localFs status:', status?.state);
            if (status?.state !== 'granted') {
                this.childrenCache.set(path, []);
                this._fsaBlocked = true;
                this._setSidebarNotice(this._statusMessage(status));
                return [];
            }
            this._fsaBlocked = false;
        }

        this.loadingPaths.add(path);
        try {
            const dirHandle = await window.localFs.resolvePath(path, { kind: 'directory' });
            if (!dirHandle) {
                console.warn('[FileStorage] resolvePath returned null for path=' + JSON.stringify(path));
                this.childrenCache.set(path, []);
                return [];
            }
            const items = [];
            for await (const entry of dirHandle.values()) {
                const rel = path ? `${path}/${entry.name}` : entry.name;
                if (entry.kind === 'directory') {
                    items.push({
                        id: rel,
                        name: entry.name,
                        path: rel,
                        type: 'folder'
                    });
                } else {
                    // entry.kind === 'file'
                    let size = 0;
                    let mtime = null;
                    try {
                        const f = await entry.getFile();
                        size = f.size;
                        mtime = f.lastModified;
                    } catch {}
                    items.push({
                        id: rel,
                        name: entry.name,
                        path: rel,
                        type: 'file',
                        size,
                        // mimeType intentionally omitted — getFileIcon
                        // falls back to extension-based detection, and the
                        // PHP-side guessMimeType helper doesn't exist on
                        // this class.
                        modified: mtime ? new Date(mtime).toISOString() : null
                    });
                }
            }
            // Folders first, then files; both alphabetized.
            items.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            this.childrenCache.set(path, items);
            return items;
        } catch (e) {
            console.error('[FileStorage] fetchChildren(' + JSON.stringify(path) + ') threw:', e);
            this.showError('Could not read folder: ' + (e?.message ?? e));
            this.childrenCache.set(path, []);
            return [];
        } finally {
            this.loadingPaths.delete(path);
        }
    }

    /**
     * Get file icon based on type/extension
     */
    getFileIcon(item) {
        const name = item.name || '';
        const mimeType = item.mimeType || '';

        // By mime type
        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType.startsWith('video/')) return '🎬';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.includes('pdf')) return '📕';
        if (mimeType.includes('zip') || mimeType.includes('archive')) return '🗜️';
        if (mimeType.includes('json')) return '📋';

        // By extension
        if (name.endsWith('.js')) return '📜';
        if (name.endsWith('.html') || name.endsWith('.htm')) return '🌐';
        if (name.endsWith('.css')) return '🎨';
        if (name.endsWith('.php')) return '🐘';
        if (name.endsWith('.py')) return '🐍';
        if (name.endsWith('.md')) return '📝';
        if (name.endsWith('.txt')) return '📄';

        return '📄'; // Default document icon
    }

    /**
     * Show info message
     */
    showMessage(message) {
        const folderName = this.userFolder || 'this folder';
        this.treeContainer.innerHTML = `
            <div class="text-center text-gray-500 text-xs py-6">
                <div class="mb-2 text-2xl">📂</div>
                <div class="font-medium text-gray-600 mb-1">${this.escapeHtml(folderName)}</div>
                <div class="text-gray-400">${this.escapeHtml(message)}</div>
                ${!this.userFolder ? `
                    <div class="mt-3">
                        <button onclick="window.settingsPanel?.show(); window.settingsPanel?.switchTab('account');"
                                class="text-blue-600 hover:text-blue-800 underline">
                            Configure in Settings
                        </button>
                    </div>
                ` : `
                    <div class="mt-3 text-gray-400 text-xs">
                        Run a workflow with output storage enabled to save files here
                    </div>
                `}
            </div>
        `;
    }

    /**
     * Get icon for a provider (kept for compatibility)
     */
    getProviderIcon(providerId) {
        const icons = {
            'local': '📁',
            'gdrive': '☁️',
            's3': '🪣',
            'onedrive': '☁️'
        };
        return icons[providerId] || '📁';
    }

    /**
     * Show loading state
     */
    showLoading() {
        this.treeContainer.innerHTML = `
            <div class="text-center text-gray-400 text-xs py-6">
                <div class="animate-pulse">${this.t('fileStorage.loading')}</div>
            </div>
        `;
    }

    /**
     * Show error message
     */
    showError(message) {
        this.treeContainer.innerHTML = `
            <div class="text-center text-red-500 text-xs py-6">
                <span>⚠️</span> ${this.escapeHtml(message)}
            </div>
        `;
    }

    /**
     * Render the whole tree from the root, walking only into folders that
     * are in `expandedPaths` (and have their children cached). Folders not
     * yet expanded show a ▶ caret; expanded folders show ▼ and their
     * children, indented deeper. Files render as leaf rows. One DOM
     * rebuild per change is fine — the tree is small.
     */
    renderTree() {
        // If FSA permission isn't granted, _setSidebarNotice has already
        // painted an actionable notice into the container — don't clobber
        // it with the empty tree below.
        if (this._fsaBlocked) return;
        const rootFolderName = this.userFolder || 'Storage';
        let html = '<div class="file-tree">';

        // Root row — represents the user's storage folder. Always
        // visually expanded (we always pre-fetch it in loadFiles).
        const rootExpanded = this.expandedPaths.has('');
        html += this._renderRow({
            type: 'folder',
            name: rootFolderName,
            id: '',
            path: '',
            isRoot: true,
            expanded: rootExpanded
        }, 0);

        if (rootExpanded) {
            html += this._renderChildren('', 1);
        }

        html += '</div>';
        this.treeContainer.innerHTML = html;
    }

    /**
     * Render the children of one folder path at the given depth, walking
     * recursively into any expanded sub-folders. Folders whose children
     * haven't been cached yet (i.e. just-expanded with the fetch still
     * in flight) render a "Loading…" placeholder.
     */
    _renderChildren(path, depth) {
        const items = this.childrenCache.get(path);
        if (items == null) {
            return this._loadingRow(depth);
        }
        if (items.length === 0) {
            return `<div class="file-tree-empty" style="padding-left: ${depth * 20}px;">
                        <span class="text-gray-400 text-xs italic">(empty)</span>
                    </div>`;
        }
        let html = '';
        for (const item of items) {
            const expanded = item.type === 'folder' && this.expandedPaths.has(item.path);
            html += this._renderRow({
                type: item.type,
                name: item.name,
                id: item.id,
                path: item.path,
                size: item.size,
                mimeType: item.mimeType,
                expanded
            }, depth);
            if (expanded) {
                html += this._renderChildren(item.path, depth + 1);
            }
        }
        return html;
    }

    /**
     * Render one row (folder or file). The data-* attributes feed the
     * delegated click handler.
     */
    _renderRow(item, depth) {
        const indent = depth * 20;
        const isFolder = item.type === 'folder';
        const caret = isFolder ? (item.expanded ? '▼' : '▶') : '';
        const icon = isFolder ? '📁' : this.getFileIcon(item);
        const sizeStr = !isFolder ? this.formatSize(item.size) : '';
        const cls = isFolder ? 'file-tree-folder' : 'file-tree-file';
        const rootCls = item.isRoot ? ' file-tree-root' : '';
        const selCls = (item.path ?? '') === this.selectedPath ? ' file-tree-selected' : '';
        return `
            <div class="file-tree-item ${cls}${rootCls}${selCls}"
                 data-type="${item.type}"
                 data-id="${this.escapeHtml(item.id ?? '')}"
                 data-path="${this.escapeHtml(item.path ?? '')}"
                 data-name="${this.escapeHtml(item.name)}"
                 data-expanded="${item.expanded ? 'true' : 'false'}"
                 style="padding-left: ${indent}px;">
                <span class="expand-icon">${caret}</span>
                <span class="file-icon">${icon}</span>
                <span class="file-name${item.isRoot ? ' font-medium' : ''}">${this.escapeHtml(item.name)}</span>
                ${sizeStr ? `<span class="file-size">${sizeStr}</span>` : ''}
            </div>
        `;
    }

    _loadingRow(depth) {
        return `<div class="file-tree-empty" style="padding-left: ${depth * 20}px;">
                    <span class="text-gray-400 text-xs italic">Loading…</span>
                </div>`;
    }

    /**
     * Show an actionable notice above the file tree — used when the FSA
     * permission isn't 'granted' yet (Chrome can downgrade to 'prompt'
     * after a session restart). Includes a button that triggers the
     * directory picker so the user can re-grant without leaving the page.
     */
    _setSidebarNotice(message) {
        if (!this.treeContainer) return;
        const safe = this.escapeHtml(message);
        this.treeContainer.innerHTML = `
            <div class="file-tree-notice"
                 style="background:#fef3c7;border:1px solid #fcd34d;color:#92400e;
                        font-size:12px;padding:8px 10px;border-radius:6px;margin-bottom:8px;">
                <div style="margin-bottom:6px;">${safe}</div>
                <button type="button" id="file-storage-grant-btn"
                        style="background:#fff;border:1px solid #fcd34d;color:#92400e;
                               border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;">
                    Grant folder access
                </button>
            </div>
        `;
        const btn = document.getElementById('file-storage-grant-btn');
        if (btn) {
            btn.addEventListener('click', async () => {
                if (!window.localFs?.requestRootAccess) return;
                const res = await window.localFs.requestRootAccess('synergyAI');
                if (res?.ok) {
                    // Permission granted — bust caches and reload.
                    this.childrenCache.clear();
                    this.expandedPaths.clear();
                    await this.show();
                }
            });
        }
    }

    _clearSidebarNotice() {
        const notice = this.treeContainer?.querySelector('.file-tree-notice');
        if (notice) notice.remove();
    }

    _statusMessage(status) {
        switch (status?.state) {
            case 'not_picked':
                return 'No local folder picked yet. Re-run the install wizard or click the button to choose your synergyAI folder.';
            case 'prompt':
                return 'Browser permission to read your synergyAI folder needs to be re-granted (Chrome resets this between sessions).';
            case 'denied':
                return 'Folder access was denied. Reset the permission in Chrome’s site settings, then grant again.';
            case 'unsupported':
                return 'This browser does not expose the File System Access API. Use Chrome, Edge, or Brave.';
            default:
                return 'Local folder is not available.';
        }
    }

    /**
     * Handle click on tree items
     */
    async handleTreeClick(e) {
        const item = e.target.closest('.file-tree-item');
        if (!item) return;

        const type = item.dataset.type;
        const id   = item.dataset.id;
        const path = item.dataset.path;
        const name = item.dataset.name;

        // Mark the clicked row as selected — same highlight as the other lists.
        this.selectedPath = path ?? '';

        if (type === 'folder') {
            // Toggle expand / collapse. Path is the relative path from
            // the storage root; the root itself is the empty string.
            const key = path ?? '';
            if (this.expandedPaths.has(key)) {
                this.expandedPaths.delete(key);
                this.renderTree();
                return;
            }
            this.expandedPaths.add(key);
            // Lazy fetch children if not already cached. Render once
            // with a Loading… row, then re-render with the data.
            if (!this.childrenCache.has(key)) {
                this.renderTree();
                await this.fetchChildren(key);
            }
            this.renderTree();
        } else if (type === 'file' && id) {
            // Re-render to show the selection highlight, then open the file.
            this.renderTree();
            this.openFile(id, name);
        }
    }

    /**
     * Open a file and display its content
     */
    async openFile(fileId, fileName) {
        // Read the file via FSA and open it in a new tab. The browser
        // handles previewing whatever it can natively (text, html, images,
        // PDFs). The chat area in the current tab stays untouched.
        // fileId here is the relative path from the FSA root.
        if (!window.localFs?.resolvePath) {
            console.warn('[FileStorage] openFile: window.localFs unavailable');
            return;
        }
        try {
            const handle = await window.localFs.resolvePath(fileId, { kind: 'file' });
            if (!handle) {
                console.warn('[FileStorage] openFile: handle not found for', fileId);
                return;
            }
            const file = await handle.getFile();
            const url = URL.createObjectURL(file);
            // Open in a new tab. Note: blob: URLs persist as long as the
            // origin tab is alive; we leak ~one URL per file open which is
            // negligible for a personal-use UI. Caller can navigate freely.
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (e) {
            console.error('[FileStorage] openFile threw:', e);
        }
    }

    /**
     * Show loading state for file content
     */
    showFileLoading(fileName) {
        const contentArea = this.getContentArea();
        if (contentArea) {
            contentArea.innerHTML = `
                <div class="file-content-wrapper">
                    <div class="file-content-header">
                        <h3 class="file-content-title">${this.escapeHtml(fileName)}</h3>
                    </div>
                    <div class="file-content-body">
                        <div class="text-center text-gray-400 py-8">
                            <div class="animate-pulse">${this.t('fileStorage.loadingFile')}</div>
                        </div>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Display file content in the content area
     */
    displayFileContent(data) {
        const contentArea = this.getContentArea();
        if (!contentArea) return;

        let contentHtml;

        if (data.isBinary) {
            // Handle binary files
            if (data.mimeType.startsWith('image/')) {
                contentHtml = `<img src="data:${data.mimeType};base64,${data.content}" class="max-w-full h-auto" alt="${this.escapeHtml(data.name)}">`;
            } else {
                contentHtml = `<div class="text-center text-gray-500 py-8">
                    <span class="text-4xl">📄</span>
                    <p class="mt-2">${this.t('fileStorage.binaryFile')}</p>
                    <p class="text-xs text-gray-400">${this.escapeHtml(data.mimeType)}</p>
                </div>`;
            }
        } else {
            // Text content
            const language = this.getLanguageFromMime(data.mimeType);
            contentHtml = `<pre class="file-content-pre"><code class="${language}">${this.escapeHtml(data.content)}</code></pre>`;
        }

        contentArea.innerHTML = `
            <div class="file-content-wrapper">
                <div class="file-content-header">
                    <h3 class="file-content-title">${this.escapeHtml(data.name)}</h3>
                    <div class="file-content-meta">
                        <span class="file-content-size">${this.formatSize(data.size)}</span>
                        <span class="file-content-type">${this.escapeHtml(data.mimeType)}</span>
                    </div>
                </div>
                <div class="file-content-body">
                    ${contentHtml}
                </div>
            </div>
        `;

        // Syntax highlighting if available
        if (window.hljs && !data.isBinary) {
            contentArea.querySelectorAll('pre code').forEach(block => {
                window.hljs.highlightBlock(block);
            });
        }
    }

    /**
     * Show file error
     */
    showFileError(message) {
        const contentArea = this.getContentArea();
        if (contentArea) {
            contentArea.innerHTML = `
                <div class="file-content-wrapper">
                    <div class="file-content-body">
                        <div class="text-center text-red-500 py-8">
                            <span>⚠️</span> ${this.escapeHtml(message)}
                        </div>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Get the main content area
     */
    getContentArea() {
        // Use the chat messages container or create a dedicated area
        return document.getElementById('file-content-display') ||
               document.getElementById('messages-container');
    }

    /**
     * Get icon for file/folder
     */
    getIcon(item) {
        if (item.type === 'folder') {
            return '📁';
        }

        // File icons based on mime type or extension
        const mimeType = item.mimeType || '';
        const name = item.name || '';

        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType.startsWith('video/')) return '🎬';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.includes('pdf')) return '📕';
        if (mimeType.includes('zip') || mimeType.includes('archive')) return '🗜️';
        if (mimeType.includes('json')) return '📋';
        if (mimeType.includes('javascript') || name.endsWith('.js')) return '📜';
        if (mimeType.includes('html') || name.endsWith('.html')) return '🌐';
        if (mimeType.includes('css') || name.endsWith('.css')) return '🎨';
        if (mimeType.includes('php') || name.endsWith('.php')) return '🐘';
        if (mimeType.includes('python') || name.endsWith('.py')) return '🐍';
        if (name.endsWith('.md')) return '📝';

        return '📄';
    }

    /**
     * Get language class for syntax highlighting
     */
    getLanguageFromMime(mimeType) {
        const map = {
            'application/json': 'json',
            'application/javascript': 'javascript',
            'text/html': 'html',
            'text/css': 'css',
            'application/x-php': 'php',
            'text/x-python': 'python',
            'text/markdown': 'markdown',
            'application/xml': 'xml',
            'text/yaml': 'yaml',
            'application/sql': 'sql'
        };
        return map[mimeType] || 'plaintext';
    }

    /**
     * Format file size
     */
    formatSize(bytes) {
        if (!bytes || bytes === 0) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (bytes >= 1024 && i < units.length - 1) {
            bytes /= 1024;
            i++;
        }
        return `${bytes.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    }

    /**
     * Escape HTML
     */
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.fileStorageManager = new FileStorageManager();
});
