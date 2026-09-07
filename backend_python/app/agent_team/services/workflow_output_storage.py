"""Port of backend/src/AgentTeam/Services/WorkflowOutputStorage.php (478 lines).

Handles saving workflow outputs to external storage via universalFS.
Supports local, S3, Google Drive, and OneDrive providers in PHP.

External-system ruling (constraints.md "universalFS ruling"): universalFS
(`/Applications/XAMPP/xamppfiles/htdocs/universalfs`) is a PHP-only package
(Dotenv + a PDO credential store + an AdapterFactory) with no Python port —
same precedent as `app/controllers/file_storage_controller.py`'s
`getUniversalFSAdapter()` stub. `getUniversalFSClient()` (PHP 360-391) is
therefore ported as an always-`None` stub, so `saveToStorage`/
`listFromStorage`/`readFromStorage` always take the local-filesystem
fallback branch (PHP 281-283/305-306/344-345) — that branch IS ported in
full (`saveToLocalFallback`/`listFromLocalFallback`/`readFromLocalFallback`,
PHP 410-477). The universalFS client-present branches (PHP 286-295,
309-334, 348-354) are unreachable here and are not implemented; each
returns/raises the same shape its PHP counterpart would use for an
unavailable client, documented per method below.

DONE_WITH_CONCERNS: the task brief describes `getUserUniversalFSApiKey`
(PHP 397-401) as a "guarded column read" against `users.universalfs_api_key`.
The actual PHP method does no such thing — it is `return
$this->config['universalfs']['api_key'] ?? null;`, a pure config lookup
with no DB access at all (only `SettingsController.php:1283` reads that
column, in a different class). Ported verbatim from PHP (config-only, no
DB, no presence guard) per "PHP wins over the brief".

Local-fallback base path (PHP 412-413/434-435/467-468):
`__DIR__ . '/../../../../storage/workflow_outputs'` from
`backend/src/AgentTeam/Services/WorkflowOutputStorage.php` resolves (4
`..` from that directory: Services -> AgentTeam -> src -> backend) to
`<htdocs>/gpt/storage/workflow_outputs` — verified via a `php -r` string
walk 2026-09-07. That is `PHP_BACKEND.parent / 'storage' /
'workflow_outputs'` here (`PHP_BACKEND` = `.../gpt/backend`, so
`.parent` = `.../gpt`). Overridable via `config['workflow_outputs_path']`,
exactly like PHP's `$this->config['workflow_outputs_path'] ?? ...`
default chain, so tests can inject a tmp root without touching the real
tree.
"""
from __future__ import annotations

import os
import re
from datetime import datetime

from app.config import PHP_BACKEND
from app.support.logger import error_log
from app.support.phpcompat import php_date, php_empty, php_trim, php_tz
from app.support.phpjson import dumps_pretty

_DEFAULT_BASE_PATH = str(PHP_BACKEND.parent / 'storage' / 'workflow_outputs')

_SPECIAL_CHARS_RE = re.compile(r'[^a-zA-Z0-9_\-]')
_MULTI_UNDERSCORE_RE = re.compile(r'_+')


def _generate_timestamp() -> str:
    """date('Y-m-d_H-i-s') in PHP's configured timezone (PHP 251). A
    module-level function (not inlined) so tests can monkeypatch it to
    freeze time."""
    return php_date('Y-m-d_H-i-s', tz=php_tz())


def _format_mtime(ts: float) -> str:
    """date('Y-m-d H:i:s', $timestamp) in PHP's configured timezone (PHP 452)."""
    return php_date('Y-m-d H:i:s', dt=datetime.fromtimestamp(ts, php_tz()))


class WorkflowOutputStorage:
    ROOT_FOLDER = 'synergyaichatroot'

    def __init__(self, db, config: dict | None = None):
        self.db = db
        self.config = config if config is not None else {}
        self.universalFSClient = None

    # ─── buildFullPath (PHP 35-48) ───────────────────────────────────────

    def buildFullPath(self, userFolder: str, path: str = '') -> str:
        """Build the full path including the root folder.
        Structure: synergyaichatroot/{user_folder}/{path}"""
        parts = [self.ROOT_FOLDER]
        if not php_empty(userFolder):
            parts.append(php_trim(userFolder, '/'))
        if not php_empty(path):
            parts.append(php_trim(path, '/'))
        return '/'.join(parts)

    # ─── saveOutput (PHP 58-112) ──────────────────────────────────────────

    def saveOutput(self, workflowId: int, userId: int, output: dict) -> dict:
        try:
            workflow = self.getWorkflow(workflowId)
            if not workflow:
                return {'success': False, 'error': 'Workflow not found'}

            if not workflow['output_storage_enabled']:
                return {'success': False, 'error': 'Output storage not enabled for this workflow'}

            storageConfig = self.getStorageConfig(userId, workflow)
            if not storageConfig['provider'] or not storageConfig['folder']:
                return {'success': False, 'error': 'Storage not configured'}

            filename = self.generateFilename(workflow['name'])
            fullPath = self.buildFullPath(storageConfig['folder'], filename)
            # PHP 85: JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE (no
            # JSON_UNESCAPED_SLASHES) -- unicode literal, slashes still \/-escaped.
            content = dumps_pretty(output, unescape_slashes=False)

            result = self.saveToStorage(storageConfig['provider'], fullPath, content, userId)

            if result.get('success'):
                error_log(
                    f"[WorkflowOutputStorage] Saved output to "
                    f"{storageConfig['provider']}://{fullPath}"
                )

            merged = dict(result)
            merged['filename'] = filename
            merged['path'] = fullPath
            merged['provider'] = storageConfig['provider']
            return merged

        except Exception as e:  # noqa: BLE001 — mirrors PHP's catch (\Exception $e)
            error_log(f"[WorkflowOutputStorage] Error: {e}")
            return {'success': False, 'error': str(e)}

    # ─── listOutputs (PHP 121-163) ────────────────────────────────────────

    def listOutputs(self, workflowId: int, userId: int) -> dict:
        try:
            workflow = self.getWorkflow(workflowId)
            if not workflow:
                return {'success': False, 'error': 'Workflow not found'}

            storageConfig = self.getStorageConfig(userId, workflow)
            if not storageConfig['provider'] or not storageConfig['folder']:
                return {'success': True, 'files': [], 'message': 'Storage not configured'}

            sanitizedName = self.sanitizeFilename(workflow['name'])
            pattern = sanitizedName + '_'

            fullPath = self.buildFullPath(storageConfig['folder'])

            files = self.listFromStorage(storageConfig['provider'], fullPath, pattern, userId)

            return {
                'success': True,
                'files': files,
                'provider': storageConfig['provider'],
                'folder': storageConfig['folder'],
            }

        except Exception as e:  # noqa: BLE001
            error_log(f"[WorkflowOutputStorage] List error: {e}")
            return {'success': False, 'error': str(e)}

    # ─── getOutput (PHP 168-202) ───────────────────────────────────────────

    def getOutput(self, workflowId: int, userId: int, filename: str) -> dict:
        try:
            workflow = self.getWorkflow(workflowId)
            if not workflow:
                return {'success': False, 'error': 'Workflow not found'}

            storageConfig = self.getStorageConfig(userId, workflow)
            if not storageConfig['provider'] or not storageConfig['folder']:
                return {'success': False, 'error': 'Storage not configured'}

            fullPath = self.buildFullPath(storageConfig['folder'], filename)

            content = self.readFromStorage(storageConfig['provider'], fullPath, userId)

            return {'success': True, 'content': content, 'filename': filename}

        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e)}

    # ─── getWorkflow (PHP 207-215) ─────────────────────────────────────────

    def getWorkflow(self, workflowId: int) -> dict | None:
        row = self.db.fetch_one(
            "SELECT id, name, user_id, output_storage_enabled, output_folder\n"
            "             FROM agent_workflows WHERE id = ?",
            [workflowId],
        )
        return row or None

    # ─── getStorageConfig (PHP 221-242) ───────────────────────────────────

    def getStorageConfig(self, userId: int, workflow: dict) -> dict:
        """Workflow-specific folder overrides user's global folder."""
        user = self.db.fetch_one(
            "SELECT storage_provider, storage_folder FROM users WHERE id = ?",
            [userId],
        )
        user = user or {}

        provider = user.get('storage_provider')
        if provider is None:
            provider = 'local'
        folder = user.get('storage_folder')
        if folder is None:
            folder = ''

        if not php_empty(workflow.get('output_folder')):
            folder = workflow['output_folder']

        return {'provider': provider, 'folder': folder}

    # ─── generateFilename (PHP 248-253) ───────────────────────────────────

    def generateFilename(self, workflowName: str) -> str:
        """Format: Workflow_Name_2026-03-31_19-45-30.json"""
        sanitized = self.sanitizeFilename(workflowName)
        timestamp = _generate_timestamp()
        return f"{sanitized}_{timestamp}.json"

    # ─── sanitizeFilename (PHP 260-271) ───────────────────────────────────

    def sanitizeFilename(self, name: str) -> str:
        # Replace spaces with underscores
        name = name.replace(' ', '_')
        # Remove special characters except - and _
        name = _SPECIAL_CHARS_RE.sub('', name)
        # Remove consecutive underscores
        name = _MULTI_UNDERSCORE_RE.sub('_', name)
        # Trim underscores from start/end
        name = php_trim(name, '_')
        return name or 'workflow'

    # ─── saveToStorage (PHP 276-296) ───────────────────────────────────────

    def saveToStorage(self, provider: str, path: str, content: str, userId: int) -> dict:
        client = self.getUniversalFSClient(userId)

        if not client:
            return self.saveToLocalFallback(path, content, userId)

        # PHP 286-295 (universalFS $client->connect()/write()) — unreachable:
        # getUniversalFSClient() always returns None (see module docstring),
        # universalFS is not ported.
        return {'success': False, 'error': 'universalFS client unavailable (not ported)'}

    # ─── listFromStorage (PHP 301-335) ─────────────────────────────────────

    def listFromStorage(self, provider: str, folder: str, pattern: str, userId: int) -> list:
        client = self.getUniversalFSClient(userId)

        if not client:
            return self.listFromLocalFallback(folder, pattern, userId)

        # PHP 309-334 (universalFS $client->connect()/ls()) — unreachable,
        # same reasoning as saveToStorage.
        return []

    # ─── readFromStorage (PHP 340-355) ─────────────────────────────────────

    def readFromStorage(self, provider: str, path: str, userId: int) -> str:
        client = self.getUniversalFSClient(userId)

        if not client:
            return self.readFromLocalFallback(path, userId)

        # PHP 348-354 (universalFS $client->connect()/read()) — unreachable,
        # same reasoning as saveToStorage. PHP's own client-absent behavior
        # never reaches this branch either (client is always None here).
        raise RuntimeError("Failed to read file: universalFS client unavailable (not ported)")

    # ─── getUniversalFSClient (PHP 360-391) ────────────────────────────────

    def getUniversalFSClient(self, userId: int):
        """universalFS is a PHP-only package with no Python port (module
        docstring). Ported as an always-None stub: `getUserUniversalFSApiKey`
        (a pure config lookup, PHP 397-401, no DB) still runs so its
        no-key log message fires exactly as PHP's does when no
        `config['universalfs']['api_key']` is configured (the live default —
        `ai_config.php` sets no `universalfs` key)."""
        if self.universalFSClient is not None:
            return self.universalFSClient

        apiKey = self.getUserUniversalFSApiKey(userId)

        if not apiKey:
            error_log(f"[WorkflowOutputStorage] No universalFS API key configured for user {userId}")
            return None

        # PHP 379-382 (getUniversalFSClientWithApiKey()) — unreachable here;
        # universalFS bootstrap/client construction is not ported.
        error_log(
            "[WorkflowOutputStorage] universalFS client unavailable for user "
            f"{userId} (universalFS is a PHP-only package, not ported)"
        )
        return None

    # ─── getUserUniversalFSApiKey (PHP 397-401) ────────────────────────────

    def getUserUniversalFSApiKey(self, userId: int) -> str | None:
        """For now, check if there's a global API key in config."""
        return (self.config.get('universalfs') or {}).get('api_key')

    # =========================================
    # Local Fallback Methods
    # =========================================

    def _basePath(self) -> str:
        p = self.config.get('workflow_outputs_path')
        return p if p is not None else _DEFAULT_BASE_PATH

    # ─── saveToLocalFallback (PHP 410-427) ─────────────────────────────────

    def saveToLocalFallback(self, path: str, content: str, userId: int) -> dict:
        basePath = self._basePath()
        fullPath = basePath + '/' + str(userId) + '/' + path
        dirPath = os.path.dirname(fullPath)

        if not os.path.isdir(dirPath):
            try:
                os.makedirs(dirPath, mode=0o755, exist_ok=True)
            except OSError:
                pass  # PHP: mkdir()'s return value is never checked either

        try:
            with open(fullPath, 'w', encoding='utf-8') as fh:
                fh.write(content)
            return {'success': True}
        except OSError:
            return {'success': False, 'error': 'Failed to write file'}

    # ─── listFromLocalFallback (PHP 432-460) ───────────────────────────────

    def listFromLocalFallback(self, folder: str, pattern: str, userId: int) -> list:
        basePath = self._basePath()
        fullPath = basePath + '/' + str(userId) + '/' + folder

        if not os.path.isdir(fullPath):
            return []

        files = []
        # scandir()'s default sort (SCANDIR_SORT_ASCENDING) is byte-order
        # ascending; sorted() on the entry names matches it (same precedent
        # as file_storage_controller.py's listLocalFiles).
        for file in sorted(os.listdir(fullPath)):
            if not file.startswith(pattern):
                continue

            filePath = fullPath + '/' + file
            files.append({
                'name': file,
                'size': os.path.getsize(filePath),
                'modified': _format_mtime(os.path.getmtime(filePath)),
                'path': folder + '/' + file,
            })

        # usort($a,$b) => $b['modified'] <=> $a['modified'] — descending,
        # stable under PHP 8's sort. Python's sorted(reverse=True) is also
        # stable (ties keep their original — i.e. scandir — order), so this
        # matches PHP 8 exactly.
        files.sort(key=lambda f: f['modified'], reverse=True)

        return files

    # ─── readFromLocalFallback (PHP 465-477) ───────────────────────────────

    def readFromLocalFallback(self, path: str, userId: int) -> str:
        basePath = self._basePath()
        fullPath = basePath + '/' + str(userId) + '/' + path

        if not os.path.exists(fullPath):
            raise RuntimeError(f"File not found: {path}")

        with open(fullPath, 'r', encoding='utf-8') as fh:
            return fh.read()
