import { readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { strval } from './php';

/**
 * A user's universalFS adapter as this store uses it: readStream(path) gives the file's bytes
 * (PHP reads the stream to its end; here the adapter hands back the whole content). Throwing,
 * or answering anything but bytes, falls through to the local root.
 */
export interface StartDocumentAdapter {
    readStream(path: string): Buffer | string | null | undefined;
}

/**
 * Reads a Start document for the modular package, only from the requesting user's own
 * document storage (the place WorkflowController::uploadDocument writes it):
 * <ROOT_FOLDER>/<user folder>/<doc path>, through the user's universalFS adapter, else under
 * a local storage root with realpath containment -- GraphWorkflowRunner::readFileRaw's rules.
 *
 * The Start config is saved by the client, so its `path` is untrusted: an absolute path, a
 * `..` segment, a backslash or a document kept on the user's machine (storage "local") is
 * never read. `fullPath` is ignored: the location is rebuilt from the user's own folder.
 *
 * Mirrors backend/src/AgentTeam/Services/StartDocumentStore.php (bytes are Buffers).
 */
export class StartDocumentStore {
    static readonly ROOT_FOLDER = 'synergyaichatroot';

    private adapterInstance: StartDocumentAdapter | null = null;
    private connected = false;

    /**
     * @param userFolder the user's storage folder (users.storage_folder, else "user_<id>")
     * @param adapterFactory connects the user's universalFS adapter (may return null); called once, on first read
     * @param localRoot the local storage root (the controller's storage_path)
     */
    constructor(
        private readonly userFolder: string,
        private readonly adapterFactory: (() => StartDocumentAdapter | null) | null = null,
        private readonly localRoot: string | null = null,
    ) {}

    /** path split into safe segments (no empty, ".", ".." segment, no "\", no NUL, not absolute), else null. */
    static safeSegments(p: string): string[] | null {
        if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) {
            return null;
        }
        const parts = p.split('/');
        for (const s of parts) {
            if (s === '' || s === '.' || s === '..') {
                return null;
            }
        }
        return parts;
    }

    /** The document's bytes, or null when it is not in this user's storage (or cannot be read). */
    read(doc: any): Buffer | null {
        if ((doc?.['storage'] ?? 'remote') === 'local') {
            return null; // kept on the user's machine: the server never had it
        }
        const rel = StartDocumentStore.safeSegments(strval(doc?.['path'] ?? ''));
        const folder = StartDocumentStore.safeSegments(this.userFolder);
        if (rel === null || folder === null) {
            return null;
        }
        const full = StartDocumentStore.ROOT_FOLDER + '/' + folder.join('/') + '/' + rel.join('/');

        const adapter = this.adapter();
        if (adapter !== null) {
            try {
                const bytes = adapter.readStream('/' + full);
                if (Buffer.isBuffer(bytes)) return bytes;
                if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
            } catch {
                // fall through to the local root, as the runner does
            }
        }
        if (this.localRoot === null) {
            return null;
        }
        const base = realpathOrFalse(this.localRoot + '/' + StartDocumentStore.ROOT_FOLDER + '/' + folder.join('/'));
        const target = realpathOrFalse(this.localRoot + '/' + full);
        if (base === false || target === false || !target.startsWith(base + path.sep) || !isFile(target)) {
            return null;
        }
        try {
            return readFileSync(target);
        } catch {
            return null;
        }
    }

    private adapter(): StartDocumentAdapter | null {
        if (!this.connected) {
            this.connected = true;
            try {
                this.adapterInstance = this.adapterFactory !== null ? (this.adapterFactory() ?? null) : null;
            } catch {
                this.adapterInstance = null;
            }
        }
        return this.adapterInstance;
    }
}

/** realpath(): the canonical absolute path, or false when it does not exist. */
function realpathOrFalse(p: string): string | false {
    try {
        return realpathSync(p);
    } catch {
        return false;
    }
}

function isFile(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}
