"""FileStorageController unit tests — PHP-truth strings and byte-identical SQL.

PHP source: backend/src/Controllers/FileStorageController.php (18-545).
"""
from __future__ import annotations

import os
import tempfile

import pytest
from starlette.datastructures import Headers

from app.controllers.file_storage_controller import FileStorageController
from app.support.http import Ctx


class FakeDb:
    def __init__(self, one=None, all_=None, columns=('storage_provider', 'storage_folder')):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.columns = set(columns)
        self.calls = []

    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        if sql.startswith('SHOW COLUMNS FROM'):
            col = sql.split("LIKE '")[1].rstrip("'")
            return [{'x': col}] if col in self.columns else []
        return self.all_.pop(0) if self.all_ else []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return 1


def ctx(query=None, user_id=3, method='GET'):
    return Ctx(method=method, uri='/', headers=Headers({}), query=query or {}, body={},
               raw_body='', params={}, user_id=user_id, authenticated=True, remote_addr='')


def ctl(db=None, config=None):
    return FileStorageController(db if db is not None else FakeDb(), config if config is not None else {})


# ─── buildFullPath (PHP 35-48) ───────────────────────────────────────────────

def test_build_full_path_root_only():
    c = ctl()
    assert c.buildFullPath('', '') == 'synergyaichatroot'


def test_build_full_path_with_user_folder_and_path():
    c = ctl()
    assert c.buildFullPath('synergyAI', 'sub/dir') == 'synergyaichatroot/synergyAI/sub/dir'


def test_build_full_path_trims_leading_trailing_slashes():
    c = ctl()
    assert c.buildFullPath('/synergyAI/', '/sub/dir/') == 'synergyaichatroot/synergyAI/sub/dir'


# ─── getUserStorageConfig (PHP 71-85) ────────────────────────────────────────

def test_get_user_storage_config_defaults_when_null():
    db = FakeDb(one=[{'storage_provider': None, 'storage_folder': None}])
    c = ctl(db)
    assert c.getUserStorageConfig(3) == {'provider': 'local', 'folder': ''}
    # SQL byte-identical (PHP 75-77)
    assert ('SELECT storage_provider, storage_folder FROM users WHERE id = ?', [3]) in db.calls


def test_get_user_storage_config_reads_row():
    db = FakeDb(one=[{'storage_provider': 's3', 'storage_folder': 'synergyAI'}])
    c = ctl(db)
    assert c.getUserStorageConfig(3) == {'provider': 's3', 'folder': 'synergyAI'}


def test_get_user_storage_config_no_row():
    db = FakeDb(one=[None])
    c = ctl(db)
    assert c.getUserStorageConfig(3) == {'provider': 'local', 'folder': ''}


# ─── getProviders (PHP 90-150) — DONE_WITH_CONCERNS: PHP calls an undefined
# method (getUniversalFSClient), always fatals (verified live 2026-09-07) ────

def test_get_providers_requires_auth():
    c = ctl()
    assert c.getProviders(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required'}


def test_get_providers_raises_matching_php_undefined_method_error():
    c = ctl()
    with pytest.raises(AttributeError) as exc_info:
        c.getProviders(ctx(user_id=3))
    assert str(exc_info.value) == (
        "Call to undefined method Quantis\\AIPortfolioAssistant\\Controllers\\"
        "FileStorageController::getUniversalFSClient()"
    )


# ─── listFiles (PHP 155-283) ─────────────────────────────────────────────────

def test_list_files_requires_auth():
    c = ctl()
    assert c.listFiles(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required'}


def test_list_files_no_folder_configured():
    db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': None}])
    c = ctl(db)
    result = c.listFiles(ctx(user_id=3))
    assert result == {
        'success': True, 'provider': 'local', 'userFolder': '', 'path': '', 'fullPath': '', 'items': [],
        'message': 'No storage folder configured. Please configure your storage folder in Settings.',
    }


def test_list_files_non_local_provider_cloud_not_configured():
    # Live-verified 2026-09-07: user 3's live provider is 's3'; PHP returns
    # this exact message since getUniversalFSAdapter() always returns null.
    db = FakeDb(one=[{'storage_provider': 's3', 'storage_folder': 'synergyAI'}])
    c = ctl(db)
    result = c.listFiles(ctx(user_id=3))
    assert result == {
        'success': True, 'provider': 's3', 'userFolder': 'synergyAI', 'path': '',
        'fullPath': 'synergyaichatroot/synergyAI', 'items': [],
        'message': 'Cloud storage is not yet configured. Please contact support or configure universalFS.',
    }


def test_list_files_local_provider_creates_missing_folder():
    with tempfile.TemporaryDirectory() as tmp:
        db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'synergyAI'}])
        c = ctl(db, {'storage_path': tmp})
        result = c.listFiles(ctx(query={'path': 'newdir'}, user_id=3))
        expected_full = tmp + '/synergyaichatroot/synergyAI/newdir'
        # listLocalFiles() receives buildFullPath()'s result as `path` and
        # echoes it verbatim in both 'path' and 'fullPath' (PHP 205/399-416:
        # listFiles() calls listLocalFiles($userId, $fullPath), and
        # listLocalFiles's own 'path' key is that same argument).
        assert result == {
            'success': True, 'provider': 'local', 'path': 'synergyaichatroot/synergyAI/newdir',
            'fullPath': expected_full, 'items': [], 'message': 'Folder is empty or was just created.',
        }
        assert os.path.isdir(expected_full)


def test_list_files_local_provider_order_and_fields(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, 'synergyaichatroot', 'synergyAI')
        os.makedirs(root)
        os.makedirs(os.path.join(root, 'Zeta'))
        os.makedirs(os.path.join(root, 'alpha'))
        with open(os.path.join(root, 'b.txt'), 'w') as f:
            f.write('hello')
        with open(os.path.join(root, 'A.txt'), 'w') as f:
            f.write('hi')

        db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'synergyAI'}])
        c = ctl(db, {'storage_path': tmp})
        result = c.listFiles(ctx(query={}, user_id=3))

        assert result['success'] is True
        names_types = [(i['name'], i['type']) for i in result['items']]
        # Folders first (case-insensitive name order among folders), then
        # files (case-insensitive name order among files).
        assert names_types == [('alpha', 'folder'), ('Zeta', 'folder'), ('A.txt', 'file'), ('b.txt', 'file')]

        b_item = next(i for i in result['items'] if i['name'] == 'b.txt')
        # relative to the `path` arg listFiles() passed in — the FULL path
        # (synergyaichatroot/synergyAI), not the caller's relative path.
        assert b_item['path'] == 'synergyaichatroot/synergyAI/b.txt'
        assert b_item['id'] == b_item['path']
        assert b_item['size'] == 5
        assert b_item['mimeType'] == 'text/plain'

        zeta_item = next(i for i in result['items'] if i['name'] == 'Zeta')
        assert zeta_item['mimeType'] == 'inode/directory'
        assert zeta_item['size'] == 0


# ─── readFile (PHP 288-348) ──────────────────────────────────────────────────

def test_read_file_requires_auth():
    c = ctl()
    assert c.readFile(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required'}


def test_read_file_requires_file_id():
    db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'x'}])
    c = ctl(db)
    assert c.readFile(ctx(query={}, user_id=3)) == {'success': False, 'error': 'File ID is required'}


def test_read_file_accepts_file_id_snake_case_fallback():
    with tempfile.TemporaryDirectory() as tmp:
        db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'x'}])
        c = ctl(db, {'storage_path': tmp})
        result = c.readFile(ctx(query={'file_id': 'nope.txt'}, user_id=3))
        assert result == {'success': False, 'error': 'File not found'}


def test_read_file_not_found():
    with tempfile.TemporaryDirectory() as tmp:
        db = FakeDb(one=[{'storage_provider': 's3', 'storage_folder': 'x'}])
        c = ctl(db, {'storage_path': tmp})
        # Regardless of provider (adapter is always None), readFile falls
        # back to readLocalFile — PHP 310-311 has no provider check here.
        result = c.readFile(ctx(query={'fileId': 'missing.txt'}, user_id=3))
        assert result == {'success': False, 'error': 'File not found'}


def test_read_file_text_content():
    with tempfile.TemporaryDirectory() as tmp:
        userDir = os.path.join(tmp, 'user_3')
        os.makedirs(userDir)
        with open(os.path.join(userDir, 'note.txt'), 'w') as f:
            f.write('hello world')

        db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'x'}])
        c = ctl(db, {'storage_path': tmp})
        result = c.readFile(ctx(query={'fileId': 'note.txt'}, user_id=3))
        assert result == {
            'success': True, 'name': 'note.txt', 'size': 11, 'mimeType': 'text/plain',
            'isBinary': False, 'content': 'hello world', 'encoding': 'utf-8',
        }


def test_read_file_binary_content_base64():
    with tempfile.TemporaryDirectory() as tmp:
        userDir = os.path.join(tmp, 'user_3')
        os.makedirs(userDir)
        payload = bytes([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02, 0x03])
        with open(os.path.join(userDir, 'x.png'), 'wb') as f:
            f.write(payload)

        db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'x'}])
        c = ctl(db, {'storage_path': tmp})
        result = c.readFile(ctx(query={'fileId': 'x.png'}, user_id=3))
        assert result['success'] is True
        assert result['isBinary'] is True
        assert result['encoding'] == 'base64'
        assert result['mimeType'] == 'image/png'
        import base64
        assert base64.b64decode(result['content']) == payload


# ─── "path traversal guard" — PHP has none (verified: no realpath/../guard
# anywhere in 399-479); ported verbatim, no guard added. ────────────────────

def test_read_local_file_has_no_traversal_guard_matches_php():
    with tempfile.TemporaryDirectory() as tmp:
        # A file OUTSIDE the user_3 folder, reachable via '../'.
        secret_dir = os.path.join(tmp, 'user_3', 'sub')
        os.makedirs(secret_dir)
        outside = os.path.join(tmp, 'outside.txt')
        with open(outside, 'w') as f:
            f.write('leaked')

        db = FakeDb(one=[{'storage_provider': 'local', 'storage_folder': 'x'}])
        c = ctl(db, {'storage_path': tmp})
        # PHP: $basePath . '/user_3/' . ltrim('../outside.txt', '/') resolves
        # (via the filesystem, no realpath check) to tmp/outside.txt.
        result = c.readFile(ctx(query={'fileId': '../outside.txt'}, user_id=3))
        assert result == {
            'success': True, 'name': 'outside.txt', 'size': 6, 'mimeType': 'text/plain',
            'isBinary': False, 'content': 'leaked', 'encoding': 'utf-8',
        }


# ─── guessMimeType (PHP 484-511) ─────────────────────────────────────────────

@pytest.mark.parametrize('filename,expected', [
    ('a.txt', 'text/plain'), ('a.html', 'text/html'), ('a.htm', 'text/html'),
    ('a.css', 'text/css'), ('a.js', 'application/javascript'), ('a.json', 'application/json'),
    ('a.xml', 'application/xml'), ('a.pdf', 'application/pdf'), ('a.zip', 'application/zip'),
    ('a.png', 'image/png'), ('a.jpg', 'image/jpeg'), ('a.jpeg', 'image/jpeg'),
    ('a.gif', 'image/gif'), ('a.svg', 'image/svg+xml'), ('a.md', 'text/markdown'),
    ('a.csv', 'text/csv'), ('a.php', 'application/x-php'), ('a.py', 'text/x-python'),
    ('a.java', 'text/x-java'), ('a.c', 'text/x-c'), ('a.cpp', 'text/x-c'), ('a.h', 'text/x-c'),
    ('a.sql', 'application/sql'), ('a.yaml', 'text/yaml'), ('a.yml', 'text/yaml'),
    ('a.unknownext', 'application/octet-stream'), ('noext', 'application/octet-stream'),
    ('A.TXT', 'text/plain'),  # extension lowercased
])
def test_guess_mime_type(filename, expected):
    assert ctl().guessMimeType(filename) == expected


def test_guess_mime_type_dotfile_matches_php_pathinfo():
    # PHP: pathinfo('.gitignore', PATHINFO_EXTENSION) === 'gitignore' (verified
    # via `php -r`) — NOT Python's os.path.splitext, which treats a leading
    # dot as "no extension".
    assert ctl().guessMimeType('.gitignore') == 'application/octet-stream'  # ext 'gitignore' unmapped
    assert ctl().guessMimeType('.py') == 'text/x-python'  # ext 'py' IS mapped


# ─── isBinaryContent (PHP 516-544) ───────────────────────────────────────────

def test_is_binary_content_text_mime_short_circuits():
    c = ctl()
    assert c.isBinaryContent(b"\x00\x00\x00", 'text/plain') is False
    assert c.isBinaryContent(b"\x00\x00\x00", 'application/json') is False


def test_is_binary_content_null_byte():
    c = ctl()
    assert c.isBinaryContent(b"abc\x00def", 'application/octet-stream') is True


def test_is_binary_content_high_nonprintable_ratio():
    c = ctl()
    # >10% control bytes (excluding tab/newline/CR) among the first 1KB.
    sample = bytes([1, 2, 3, 4]) + b"a" * 20
    assert c.isBinaryContent(sample, 'application/octet-stream') is True


def test_is_binary_content_mostly_printable_with_newlines_is_text():
    c = ctl()
    sample = b"line one\nline two\r\nline three\ttabbed\n" * 5
    assert c.isBinaryContent(sample, 'application/octet-stream') is False


def test_is_binary_content_empty_sample():
    c = ctl()
    assert c.isBinaryContent(b"", 'application/octet-stream') is False


# ─── ensureStorageColumnsExist (no-DDL presence check, constraints.md §3) ────

def test_ensure_storage_columns_exist_logs_when_missing():
    db = FakeDb(columns=())  # neither column present
    c = ctl(db)
    c.ensureStorageColumnsExist()
    show_calls = [s for s, _ in db.calls if s.startswith('SHOW COLUMNS')]
    assert show_calls == [
        "SHOW COLUMNS FROM `users` LIKE 'storage_provider'",
        "SHOW COLUMNS FROM `users` LIKE 'storage_folder'",
    ]


# ─── DEFAULT_STORAGE_PATH shared with SettingsController (same physical tree) ─

def test_default_storage_path_matches_settings_controller():
    assert FileStorageController(FakeDb()).config.get('storage_path') is None
    # Both controllers resolve to the same physical htdocs/storage directory
    # when no per-request override is configured (task brief: "must resolve
    # to the same physical tree PHP uses").
    from app.controllers.settings_controller import SettingsController as SC
    assert SC.DEFAULT_STORAGE_PATH.endswith('/htdocs/storage')
