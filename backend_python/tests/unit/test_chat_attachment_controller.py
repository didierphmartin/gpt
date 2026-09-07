"""ChatAttachmentController parity with Controllers/ChatAttachmentController.php (26-241)."""
import pathlib
import re

from starlette.datastructures import Headers

from app.controllers.chat_attachment_controller import ChatAttachmentController
from app.support.http import Ctx


class Db:
    def __init__(self, fail=False): self.calls = []; self.fail = fail

    def insert(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params))
        if self.fail:
            raise RuntimeError('boom')
        return 55

    def fetch_all(self, *a): return []

    def fetch_one(self, *a): return None

    def fetch_column(self, *a): return []

    def execute(self, *a): return 1


def ctx(files=None, user_id=3):
    c = Ctx(method='POST', uri='/api/v1/chat/upload', headers=Headers({}), query={}, body={},
            raw_body='', params={}, user_id=user_id, authenticated=user_id is not None,
            remote_addr='')
    c['auth_type'] = 'jwt'; c['sse'] = None; c['files'] = files or {}
    return c


def _file(tmp_path, name, data, ctype='application/octet-stream', error=0):
    p = tmp_path / ('up_' + name); p.write_bytes(data)
    return {'name': name, 'type': ctype, 'tmp_name': str(p), 'size': len(data), 'error': error}


def test_validation_paths(tmp_path):
    root = tmp_path / 'root'; c = ChatAttachmentController(Db(), {'chat_upload_root': str(root)})
    assert c.upload(ctx(user_id=None)) == {'success': False, 'error': 'Authentication required',
                                           'status_code': 401}
    assert c.upload(ctx({})) == {'success': False, 'error': 'No file field', 'status_code': 400}
    assert c.upload(ctx({'file': _file(tmp_path, 'a.txt', b'x', error=4)})) == {
        'success': False, 'error': 'Upload failed (error code 4)', 'status_code': 400}
    assert c.upload(ctx({'file': _file(tmp_path, 'a.txt', b'')})) == {
        'success': False, 'error': 'Empty file', 'status_code': 400}
    big = _file(tmp_path, 'a.txt', b'x'); big['size'] = 50 * 1024 * 1024 + 1
    assert c.upload(ctx({'file': big})) == {'success': False, 'error': 'File exceeds 50 MB limit',
                                            'status_code': 413}
    missing = _file(tmp_path, 'a.txt', b'x'); missing['tmp_name'] = str(tmp_path / 'nope')
    assert c.upload(ctx({'file': missing})) == {
        'success': False, 'error': 'Temporary upload file missing', 'status_code': 500}
    r = c.upload(ctx({'file': _file(tmp_path, 'a.exe', b'MZ\x90\x00' + b'\x00' * 32)}))
    assert r == {
        'success': False,
        'error': 'Unsupported file type: application/octet-stream. '
                 'Allowed: PDF, PNG/JPEG/WebP/GIF, plain text, Markdown, CSV, HTML, JSON. '
                 '(Office documents will be supported in a later release.)',
        'status_code': 415,
    }


def test_success_stores_under_user_dir_and_records_row(tmp_path):
    root = tmp_path / 'root'; db = Db(); c = ChatAttachmentController(db, {'chat_upload_root': str(root)})
    r = c.upload(ctx({'file': _file(tmp_path, 'notes.md', b'# hi\n', 'text/markdown')}))
    assert r == {'success': True,
                 'attachment': {'id': 55, 'name': 'notes.md', 'mime_type': 'text/markdown', 'size': 5}}
    sql, params = db.calls[0]
    assert sql == ('INSERT INTO chat_attachments (user_id, original_name, stored_path, mime_type, '
                   'size_bytes) VALUES (:uid, :name, :path, :mime, :size)')
    assert params[':uid'] == 3 and params[':mime'] == 'text/markdown' and params[':size'] == 5
    assert params[':name'] == 'notes.md'
    stored = pathlib.Path(params[':path'])
    assert stored.is_file() and stored.parent == root / '3' and stored.read_bytes() == b'# hi\n'
    # PHP 129-132: uuid v4 (dashed) + the ALLOWED_MIME extension for the detected type.
    assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md',
                        stored.name)
    assert oct((root / '3').stat().st_mode)[-3:] == '755'   # PHP 124: mkdir(..., 0755, true)


def test_db_failure_rolls_back_the_disk_write(tmp_path):
    root = tmp_path / 'root'; db = Db(fail=True)
    c = ChatAttachmentController(db, {'chat_upload_root': str(root)})
    r = c.upload(ctx({'file': _file(tmp_path, 'notes.md', b'# hi\n')}))
    assert r == {'success': False, 'error': 'Failed to record upload', 'status_code': 500}
    assert list((root / '3').iterdir()) == []


def test_long_display_name_is_basenamed_and_capped(tmp_path):
    root = tmp_path / 'root'; db = Db()
    c = ChatAttachmentController(db, {'chat_upload_root': str(root)})
    name = '../../evil/' + 'n' * 300 + '.txt'
    r = c.upload(ctx({'file': _file(tmp_path, 'x.txt', b'hello')}))
    assert r['success'] is True
    f = _file(tmp_path, 'x.txt', b'hello'); f['name'] = name
    r = c.upload(ctx({'file': f}))
    assert r['attachment']['name'] == ('n' * 300 + '.txt')[:250]
    assert r['attachment']['mime_type'] == 'text/plain'


def test_mime_sniffing_matches_php_finfo_for_allowed_types(tmp_path):
    c = ChatAttachmentController(Db(), {'chat_upload_root': str(tmp_path)})
    cases = [('a.pdf', b'%PDF-1.4\n%', 'application/pdf'),
             ('a.png', b'\x89PNG\r\n\x1a\n' + b'\x00' * 8, 'image/png'),
             ('a.jpg', b'\xff\xd8\xff\xe0' + b'\x00' * 8, 'image/jpeg'),
             ('a.gif', b'GIF89a' + b'\x00' * 8, 'image/gif'),
             ('a.webp', b'RIFF\x00\x00\x00\x00WEBPVP8 ', 'image/webp'),
             ('a.csv', b'a,b\n1,2\n', 'text/csv'),
             ('a.md', b'# t\n', 'text/markdown'),
             ('a.json', b'{"a":1}', 'application/json'),
             ('a.txt', b'hello', 'text/plain'),
             ('a.html', b'<html><body>x</body></html>', 'text/html')]
    for name, data, mime in cases:
        p = tmp_path / name; p.write_bytes(data)
        assert c._detectMime(str(p), name) == mime, name


SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
SVG_PROLOG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
HTML_DOC = b'<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>'


def test_text_family_sniffing_matches_php_finfo(tmp_path):
    """Every expectation below was read off the XAMPP php binary's finfo
    (`/Applications/XAMPP/xamppfiles/bin/php -r 'echo finfo_file(...)'`)."""
    c = ChatAttachmentController(Db(), {'chat_upload_root': str(tmp_path)})
    cases = [
        ('a.svg', SVG, 'image/svg+xml'),                       # finfo: image/svg+xml
        ('a2.svg', SVG_PROLOG, 'image/svg+xml'),               # finfo: image/svg+xml
        ('a.xml', b'<?xml version="1.0"?><root/>', 'text/xml'),  # finfo: text/xml
        ('page.htm', HTML_DOC, 'text/html'),                   # finfo: text/html
        ('bare_html', b'<html><body>hello</body></html>', 'text/html'),   # finfo: text/html
        ('mid_html.txt', b'hello world\nthis mentions <html> in the middle\n', 'text/html'),
        ('lead_ws.json', b'  \n {"a": 1}\n', 'application/json'),   # finfo: application/json
        ('arr.json', b'[1,2,3]', 'application/json'),          # finfo: application/json
        ('notjson.json', b'{not json', 'application/json'),    # finfo: text/plain → ext fallback
        ('xmlish.txt', b'<root><a/></root>', 'text/plain'),    # finfo: text/plain (no prolog)
        ('svg_mid.txt', b'text before\n<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'text/plain'),
        ('notes.txt', b'plain text body\n', 'text/plain'),     # finfo: text/plain
        ('csv.csv', b'a,b\n1,2\n', 'text/csv'),                # finfo: text/plain → ext fallback
    ]
    for name, data, mime in cases:
        p = tmp_path / name; p.write_bytes(data)
        assert c._detectMime(str(p), name) == mime, name


def test_svg_and_xml_are_rejected_html_and_text_accepted(tmp_path):
    root = tmp_path / 'root'; c = ChatAttachmentController(Db(), {'chat_upload_root': str(root)})
    for name, data in (('a.svg', SVG), ('a.xml', b'<?xml version="1.0"?><root/>')):
        r = c.upload(ctx({'file': _file(tmp_path, name, data)}))
        assert r['status_code'] == 415, name
        assert r['error'].startswith('Unsupported file type: '
                                     + ('image/svg+xml' if name.endswith('.svg') else 'text/xml'))
    r = c.upload(ctx({'file': _file(tmp_path, 'page.htm', HTML_DOC)}))
    assert r == {'success': True, 'attachment': {'id': 55, 'name': 'page.htm',
                                                 'mime_type': 'text/html', 'size': len(HTML_DOC)}}
    r = c.upload(ctx({'file': _file(tmp_path, 'notes.txt', b'plain text body\n')}))
    assert r['success'] is True and r['attachment']['mime_type'] == 'text/plain'


def test_ooxml_and_legacy_office_are_disambiguated_by_extension(tmp_path):
    c = ChatAttachmentController(Db(), {'chat_upload_root': str(tmp_path)})
    zipped = b'PK\x03\x04' + b'\x00' * 26
    ole = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\x00' * 8
    cases = [('a.docx', zipped, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
             ('a.xlsx', zipped, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
             ('a.pptx', zipped, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
             ('a.doc', ole, 'application/msword'),
             ('a.xls', ole, 'application/vnd.ms-excel'),
             ('a.ppt', ole, 'application/vnd.ms-powerpoint')]
    for name, data, mime in cases:
        p = tmp_path / name; p.write_bytes(data)
        assert c._detectMime(str(p), name) == mime, name
