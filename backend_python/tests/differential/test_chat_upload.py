"""Upload parity: same multipart to both backends; rows/files removed afterwards."""
import os

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


def test_upload_validation_parity(both):
    from .conftest import same
    same(*both('POST', '/api/v1/chat/upload', json={}, auth=False))
    same(*both('POST', '/api/v1/chat/upload', json={}))
