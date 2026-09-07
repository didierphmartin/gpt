"""Port of Controllers/FileStorageController.php (18-545).

File Storage Controller

Provides API endpoints for browsing and reading files from universalFS.

External-system ruling (constraints.md "External systems"): universalFS
(`/Applications/XAMPP/xamppfiles/htdocs/universalfs`) is a PHP-only package
(Dotenv + a PDO credential store + an AdapterFactory) with no Python port.
`getUniversalFSAdapter()` is therefore ported as an always-`None` stub: on
today's live server the real PHP method also ends up returning `null` (its
`AdapterFactory::connect()` call throws — no usable universalFS credentials
are configured — caught by PHP 389's `catch (\\Exception $e)` and logged),
verified live 2026-09-07 via `GET /storage/list` for user 3 (provider
`s3`), which came back with the "Cloud storage is not yet configured"
message on live PHP. Every adapter-present branch in listFiles/readFile
(PHP 208-273, 320-339) is consequently dead code here and is not ported.

DONE_WITH_CONCERNS: `getProviders()` (PHP 90-150) calls
`$this->getUniversalFSClient($userId)` at PHP:98 — a method that does not
exist anywhere in this class (grep confirms only `getUniversalFSAdapter` is
defined). PHP 8 raises `Error: Call to undefined method ...`, which is a
`\\Throwable` sibling of `\\Exception`, NOT caught by this method's own
`catch (\\Exception $e)` — it propagates to index.php's top-level
`catch (Throwable $e)` (index.php:198) and comes back as a plain 500 with
that exact message. Verified live 2026-09-07:
`curl .../storage/providers` -> 500
`{"success":false,"error":"Call to undefined method Quantis\\\\AIPortfolioAssistant\\\\Controllers\\\\FileStorageController::getUniversalFSClient()"}`.
Ported verbatim (raise, don't catch) — same precedent as
mcp_proxy_controller.py's `proxyRequest()` TypeError port.

The task brief's unit-case list mentions a "path traversal guard" for
listLocalFiles/readLocalFile; PHP 399-479 has no such guard (grep confirms:
no realpath/`..`/basePath-prefix check anywhere in this class) — ported
verbatim (no guard added), per "PHP wins over the brief" (constraints.md).
"""
from __future__ import annotations

import base64
import os
from datetime import datetime

from app.controllers.settings_controller import SettingsController
from app.support.db_presence import DbPresence
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_tz, php_trim


def _pathinfo_extension(filename: str) -> str:
    """PATHINFO_EXTENSION: substring after the LAST '.', or '' if none.
    Diverges from os.path.splitext() for dotfiles — PHP:
    pathinfo('.gitignore', PATHINFO_EXTENSION) === 'gitignore' (verified via
    `php -r`), while Python's splitext('.gitignore') == ('.gitignore', '').
    """
    idx = filename.rfind('.')
    return '' if idx == -1 else filename[idx + 1:]


def _php_date_ts(fmt: str, ts) -> str:
    """date($fmt, $timestamp) in PHP's configured timezone. Only the one
    format this controller uses is supported (mirrors php_date()'s
    subset-table style in app/support/phpcompat.py, which has no
    timestamp-taking variant to reuse)."""
    if fmt != 'Y-m-d H:i:s':
        raise ValueError(f'unsupported _php_date_ts format: {fmt}')
    return datetime.fromtimestamp(ts, php_tz()).strftime('%Y-%m-%d %H:%M:%S')


class FileStorageController:
    ROOT_FOLDER = 'synergyaichatroot'

    # PHP 484-511 (match expression) — extension (lowercased) -> MIME type.
    MIME_MAP = {
        'txt': 'text/plain',
        'html': 'text/html', 'htm': 'text/html',
        'css': 'text/css',
        'js': 'application/javascript',
        'json': 'application/json',
        'xml': 'application/xml',
        'pdf': 'application/pdf',
        'zip': 'application/zip',
        'png': 'image/png',
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'md': 'text/markdown',
        'csv': 'text/csv',
        'php': 'application/x-php',
        'py': 'text/x-python',
        'java': 'text/x-java',
        'c': 'text/x-c', 'cpp': 'text/x-c', 'h': 'text/x-c',
        'sql': 'application/sql',
        'yaml': 'text/yaml', 'yml': 'text/yaml',
    }

    # PHP 519-520 — startswith() prefixes that mark a MIME type as text.
    TEXT_MIME_PREFIXES = (
        'text/', 'application/json', 'application/javascript',
        'application/xml', 'application/sql', 'application/x-php',
    )

    def __init__(self, db, config: dict | None = None):
        self.db = db
        self.config = config if config is not None else {}
        self._presence = DbPresence(db, 'FileStorageController')

    # ─── buildFullPath (PHP 35-48) ──────────────────────────────────────────

    def buildFullPath(self, userFolder: str, path: str = '') -> str:
        """Structure: synergyaichatroot/{user_folder}/{path}"""
        parts = [self.ROOT_FOLDER]
        if not php_empty(userFolder):
            parts.append(php_trim(userFolder, '/'))
        if not php_empty(path):
            parts.append(php_trim(path, '/'))
        return '/'.join(parts)

    # ─── ensureStorageColumnsExist (PHP 53-66; no-DDL per constraints.md) ──

    def ensureStorageColumnsExist(self) -> None:
        for column in ('storage_provider', 'storage_folder'):
            self._presence.column('users', column)

    # ─── getUserStorageConfig (PHP 71-85) ───────────────────────────────────

    def getUserStorageConfig(self, userId: int) -> dict:
        self.ensureStorageColumnsExist()
        user = self.db.fetch_one(
            "SELECT storage_provider, storage_folder FROM users WHERE id = ?", [userId]
        )
        user = user or {}
        return {
            'provider': user['storage_provider'] if user.get('storage_provider') is not None else 'local',
            'folder': user['storage_folder'] if user.get('storage_folder') is not None else '',
        }

    # ─── getProviders (PHP 90-150) ──────────────────────────────────────────

    def getProviders(self, request) -> dict:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if not userId:
            return {'success': False, 'error': 'Authentication required'}

        # PHP 98: $this->getUniversalFSClient($userId) — undefined method,
        # see module docstring. Raises, uncaught here (matches PHP's
        # catch(\Exception) NOT catching \Error) — propagates to main.py's
        # top-level except-Exception handler as a 500.
        raise AttributeError(
            "Call to undefined method Quantis\\AIPortfolioAssistant\\Controllers\\"
            "FileStorageController::getUniversalFSClient()"
        )

    # ─── listFiles (PHP 155-283) ────────────────────────────────────────────

    def listFiles(self, request) -> dict:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if not userId:
            return {'success': False, 'error': 'Authentication required'}

        query = request['query'] if request.get('query') is not None else {}
        relativePath = query['path'] if query.get('path') is not None else ''

        storageConfig = self.getUserStorageConfig(userId)
        provider = storageConfig['provider']
        userFolder = storageConfig['folder']

        if php_empty(userFolder):
            return {
                'success': True,
                'provider': provider,
                'userFolder': '',
                'path': '',
                'fullPath': '',
                'items': [],
                'message': 'No storage folder configured. Please configure your storage folder in Settings.',
            }

        fullPath = self.buildFullPath(userFolder, relativePath)

        try:
            adapter = self.getUniversalFSAdapter(provider)

            if adapter is None:
                if provider != 'local':
                    return {
                        'success': True,
                        'provider': provider,
                        'userFolder': userFolder,
                        'path': relativePath,
                        'fullPath': fullPath,
                        'items': [],
                        'message': 'Cloud storage is not yet configured. Please contact support or configure universalFS.',
                    }
                return self.listLocalFiles(userId, fullPath)

            # universalFS live-adapter branch (PHP 208-273) is unreachable —
            # see module docstring; getUniversalFSAdapter() always returns None.
            raise AssertionError('unreachable: getUniversalFSAdapter() always returns None')

        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            # PHP 276 interpolates `$uri`, a variable never set in this
            # method (`$uri ?? 'not set'` -> always 'not set'); log-only,
            # does not affect the response.
            error_log(f"[FileStorageController] listFiles error: {e} - URI: not set")
            return {
                'success': False,
                'error': 'Unable to connect to storage. Please check your settings.',
                'items': [],
            }

    # ─── readFile (PHP 288-348) ─────────────────────────────────────────────

    def readFile(self, request) -> dict:
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if not userId:
            return {'success': False, 'error': 'Authentication required'}

        query = request['query'] if request.get('query') is not None else {}
        fileId = query['fileId'] if query.get('fileId') is not None else (
            query['file_id'] if query.get('file_id') is not None else ''
        )

        if not fileId:
            return {'success': False, 'error': 'File ID is required'}

        storageConfig = self.getUserStorageConfig(userId)
        provider = storageConfig['provider']

        try:
            adapter = self.getUniversalFSAdapter(provider)

            if adapter is None:
                return self.readLocalFile(userId, fileId)

            # universalFS live-adapter branch (PHP 319-339) is unreachable —
            # see module docstring.
            raise AssertionError('unreachable: getUniversalFSAdapter() always returns None')

        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            error_log(f"[FileStorageController] readFile error: {e}")
            return {'success': False, 'error': str(e)}

    # ─── getUniversalFSAdapter (PHP 354-393) ────────────────────────────────

    def getUniversalFSAdapter(self, provider: str):
        """Always None — see module docstring (universalFS is PHP-only)."""
        error_log(
            "[FileStorageController] universalFS adapter error: adapter unavailable "
            f"for provider '{provider}' (universalFS is a PHP-only package, not ported)"
        )
        return None

    # ─── listLocalFiles (PHP 399-452) ───────────────────────────────────────

    def listLocalFiles(self, userId: int, path: str) -> dict:
        basePath = self.config['storage_path'] if self.config.get('storage_path') is not None \
            else SettingsController.DEFAULT_STORAGE_PATH
        fullPath = basePath + '/' + path.lstrip('/')

        if not os.path.isdir(fullPath):
            # PHP: `if (mkdir($fullPath, 0755, true)) { error_log(...) }` — mkdir()
            # returns bool and never throws; a failure is silently swallowed and
            # the same "just created" response is still returned either way.
            try:
                os.makedirs(fullPath, mode=0o755, exist_ok=True)
                error_log(f"[FileStorageController] Created local folder: {fullPath}")
            except OSError:
                pass
            return {
                'success': True,
                'provider': 'local',
                'path': path,
                'fullPath': fullPath,
                'items': [],
                'message': 'Folder is empty or was just created.',
            }

        items = []
        # scandir()'s default sort (SCANDIR_SORT_ASCENDING) is byte-order
        # ascending; sorted() on the entry names matches it.
        for name in sorted(os.listdir(fullPath)):
            itemPath = fullPath + '/' + name
            relativePath = php_trim(path + '/' + name, '/')
            isDir = os.path.isdir(itemPath)
            isFile = os.path.isfile(itemPath)
            items.append({
                'id': relativePath,
                'name': name,
                'path': relativePath,
                'type': 'folder' if isDir else 'file',
                'size': os.path.getsize(itemPath) if isFile else 0,
                'modified': _php_date_ts('Y-m-d H:i:s', os.path.getmtime(itemPath)),
                'mimeType': self.guessMimeType(name) if isFile else 'inode/directory',
            })

        # Sort: folders first, then case-insensitive name (strcasecmp).
        items.sort(key=lambda it: (0 if it['type'] == 'folder' else 1, it['name'].lower()))

        return {
            'success': True,
            'provider': 'local',
            'path': path,
            'fullPath': fullPath,
            'items': items,
        }

    # ─── readLocalFile (PHP 457-479) ────────────────────────────────────────

    def readLocalFile(self, userId: int, filePath: str) -> dict:
        basePath = self.config['storage_path'] if self.config.get('storage_path') is not None \
            else SettingsController.DEFAULT_STORAGE_PATH
        fullPath = basePath + '/user_' + str(userId) + '/' + filePath.lstrip('/')

        if not os.path.isfile(fullPath):
            return {'success': False, 'error': 'File not found'}

        with open(fullPath, 'rb') as fh:
            content = fh.read()

        mimeType = self.guessMimeType(os.path.basename(fullPath))
        isBinary = self.isBinaryContent(content, mimeType)

        return {
            'success': True,
            'name': os.path.basename(fullPath),
            'size': os.path.getsize(fullPath),
            'mimeType': mimeType,
            'isBinary': isBinary,
            'content': (
                base64.b64encode(content).decode('ascii') if isBinary
                else content.decode('utf-8', errors='replace')
            ),
            'encoding': 'base64' if isBinary else 'utf-8',
        }

    # ─── guessMimeType (PHP 484-511) ────────────────────────────────────────

    def guessMimeType(self, filename: str) -> str:
        ext = _pathinfo_extension(filename).lower()
        return self.MIME_MAP.get(ext, 'application/octet-stream')

    # ─── isBinaryContent (PHP 516-544) ──────────────────────────────────────

    def isBinaryContent(self, content: bytes, mimeType: str) -> bool:
        for t in self.TEXT_MIME_PREFIXES:
            if mimeType.startswith(t):
                return False

        if b"\x00" in content:
            return True

        sample = content[:1024]
        nonPrintable = 0
        for b in sample:
            if b < 32 and b not in (9, 10, 13):  # allow tab, newline, CR
                nonPrintable += 1

        return (nonPrintable / max(1, len(sample))) > 0.1
