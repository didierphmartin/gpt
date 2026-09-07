"""Upload parity: same multipart to both backends; rows/files removed afterwards."""
import os
import pathlib

import pytest

from app.db import Db

pytestmark = pytest.mark.differential


def test_upload_parity_and_cleanup(php, py, token, config):
    h = {'Authorization': f'Bearer {token}'}
    data = b'differential upload body\n' * 8
    a = php.post('/api/v1/chat/upload', files={'file': ('diff.txt', data, 'text/plain')}, headers=h)
    b = py.post('/api/v1/chat/upload', files={'file': ('diff.txt', data, 'text/plain')}, headers=h)
    assert a.status_code == b.status_code == 200, (a.status_code, a.text, b.status_code, b.text)
    ja, jb = a.json(), b.json()
    assert list(ja) == list(jb) and list(ja['attachment']) == list(jb['attachment'])
    for k in ('name', 'mime_type', 'size'):
        assert ja['attachment'][k] == jb['attachment'][k]
    assert ja['attachment']['name'] == 'diff.txt'
    assert ja['attachment']['mime_type'] == 'text/plain'
    assert ja['attachment']['size'] == len(data)

    db = Db.connect(config.get('contexts_database') or config['database'])
    try:
        for j in (ja, jb):
            row = db.fetch_one('SELECT stored_path FROM chat_attachments WHERE id = ?',
                               [j['attachment']['id']])
            assert row is not None
            assert row['stored_path'].endswith('.txt')
            # Both backends store under the SAME physical root (constraints).
            assert os.path.dirname(row['stored_path']).endswith('/chat-uploads/3')
            assert os.path.isfile(row['stored_path'])
            with open(row['stored_path'], 'rb') as f:
                assert f.read() == data
            os.remove(row['stored_path'])
            db.execute('DELETE FROM chat_attachments WHERE id = ?', [j['attachment']['id']])
    finally:
        db.close()


def test_docx_upload_divergence_is_environment_caused(php, py, token, config):
    """KNOWN divergence, pinned so a libmagic upgrade tells us.

    This box's libmagic types a .docx as `application/octet-stream`, and PHP's
    octet-stream branch (ChatAttachmentController.php:196-204) maps only
    md/csv/html/json/txt — so PHP 415s it. The Python sniffer sees the OOXML
    `PK\\x03\\x04` container, returns `application/zip`, and PHP's own zip
    branch (208-214) then maps it to the docx MIME — so Python accepts it.
    """
    h = {'Authorization': f'Bearer {token}'}
    fixture = (pathlib.Path(__file__).resolve().parent.parent
               / 'fixtures' / 'attachments' / 'tiny.docx')
    data = fixture.read_bytes()
    ctype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    a = php.post('/api/v1/chat/upload', files={'file': ('tiny.docx', data, ctype)}, headers=h)
    b = py.post('/api/v1/chat/upload', files={'file': ('tiny.docx', data, ctype)}, headers=h)

    assert a.status_code == 415, f'PHP now accepts docx ({a.status_code}) — libmagic upgraded?'
    assert a.json()['error'].startswith('Unsupported file type: application/octet-stream.')
    assert b.status_code == 200, b.text
    jb = b.json()
    assert jb['attachment']['mime_type'] == ctype
    assert jb['attachment']['name'] == 'tiny.docx' and jb['attachment']['size'] == len(data)

    db = Db.connect(config.get('contexts_database') or config['database'])
    try:
        row = db.fetch_one('SELECT stored_path FROM chat_attachments WHERE id = ?',
                           [jb['attachment']['id']])
        assert row is not None and row['stored_path'].endswith('.docx')
        if os.path.isfile(row['stored_path']):
            os.remove(row['stored_path'])
        db.execute('DELETE FROM chat_attachments WHERE id = ?', [jb['attachment']['id']])
    finally:
        db.close()


def test_pptx_upload_divergence_is_environment_caused(php, py, token, config):
    """Same KNOWN divergence as the docx pin above, for pptx: this box's
    libmagic also types a .pptx as `application/octet-stream` (calibrated
    with the XAMPP php finfo binary), so PHP 415s it while Python's
    PK\\x03\\x04-signature sniff accepts it as the OOXML pptx MIME."""
    h = {'Authorization': f'Bearer {token}'}
    fixture = (pathlib.Path(__file__).resolve().parent.parent
               / 'fixtures' / 'attachments' / 'tiny.pptx')
    data = fixture.read_bytes()
    ctype = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    a = php.post('/api/v1/chat/upload', files={'file': ('tiny.pptx', data, ctype)}, headers=h)
    b = py.post('/api/v1/chat/upload', files={'file': ('tiny.pptx', data, ctype)}, headers=h)

    assert a.status_code == 415, f'PHP now accepts pptx ({a.status_code}) — libmagic upgraded?'
    assert a.json()['error'].startswith('Unsupported file type: application/octet-stream.')
    assert b.status_code == 200, b.text
    jb = b.json()
    assert jb['attachment']['mime_type'] == ctype
    assert jb['attachment']['name'] == 'tiny.pptx' and jb['attachment']['size'] == len(data)

    db = Db.connect(config.get('contexts_database') or config['database'])
    try:
        row = db.fetch_one('SELECT stored_path FROM chat_attachments WHERE id = ?',
                           [jb['attachment']['id']])
        assert row is not None and row['stored_path'].endswith('.pptx')
        if os.path.isfile(row['stored_path']):
            os.remove(row['stored_path'])
        db.execute('DELETE FROM chat_attachments WHERE id = ?', [jb['attachment']['id']])
    finally:
        db.close()


def test_upload_validation_parity(both):
    from .conftest import same
    same(*both('POST', '/api/v1/chat/upload', json={}, auth=False))
    same(*both('POST', '/api/v1/chat/upload', json={}))
