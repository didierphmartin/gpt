/**
 * Shared install of one server on the Docker app's server host, and its registration URL.
 * installOnHost(folder, {name, filesB64, env, source}) -> {state, log?, port?}
 * registrationUrl(gateway, folder, manifest) -> the URL the server is registered under
 * installAndRegister({folder, manifest, filesB64, env, source, gateway}) -> {state, log?, server?}
 * Depends on: window.mcpClient, window.i18n.
 */
(function () {
    'use strict';

    const i18n = (key) => (window.i18n && window.i18n.t ? window.i18n.t(`workflow.package.${key}`) : key);
    const POLL_MS = 3000, POLL_MAX_MS = 15 * 60 * 1000;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Send one server to the Docker app's server host. A long install can outlive the proxy: then watch the list.
     *  "running" at the install reply only means the process was launched, so its state is read once more a moment
     *  later: a server that stops on start then shows as such, with its log. */
    async function installOnHost(folder, { name, filesB64, env, source }) {
        const mc = window.mcpClient;
        try {
            const r = await mc.hostInstall(folder, { name, files: filesB64, env, source });
            await wait(POLL_MS);
            try {
                const row = (await mc.hostServers()).find((x) => x.folder === folder);
                if (row) return { ...r, state: row.state, log: row.log };
            } catch (_) { /* the install reply stands */ }
            return r;
        } catch (e) {
            if (e.status === 422) {
                const log = (e.body && e.body.data && e.body.data.log) || (e.body && e.body.log) || [];
                throw new Error(`${e.message}${log.length ? '\n' + log.slice(0, 20).join('\n') : ''}`);
            }
            if (e.status !== undefined && e.status !== 502 && e.status !== 504) throw e;
        }
        for (const start = Date.now(); Date.now() - start < POLL_MAX_MS;) {
            await wait(POLL_MS);
            let list;
            try { list = await mc.hostServers(); } catch (_) { continue; }
            const row = list.find((x) => x.folder === folder);
            if (!row) throw new Error(i18n('hostInstallUnfinished'));
            if (row.state !== 'installing') return { state: row.state, log: row.log };
        }
        throw new Error(i18n('hostInstallTooLong'));
    }

    function registrationUrl(gateway, folder, manifest) {
        const gw = String(gateway || '').replace(/\/+$/, '');
        if (manifest && manifest.runtime === 'php' && manifest.entry) {
            return `${gw}/${folder}/${String(manifest.entry).split('/').map(encodeURIComponent).join('/')}`;
        }
        return `${gw}/${folder}/mcp`;
    }

    async function installAndRegister({ folder, manifest, filesB64, env, source, gateway }) {
        const name = manifest.name || folder;
        const r = await installOnHost(folder, { name, filesB64, env, source });
        if (r.state !== 'running') return { state: r.state, log: r.log };
        const server = await window.mcpClient.addServer(name, registrationUrl(gateway, folder, manifest),
            manifest.description || '', {}, 'http');
        if (!server || server.success === false) return { state: 'register-failed', error: server && server.error };
        return { state: r.state, server };
    }

    window.McpHostInstall = { installOnHost, registrationUrl, installAndRegister };
})();
