"""WorkflowOutputStorage unit tests — PHP-truth SQL, local-fallback round
trips, and the universalFS-unavailable path.

PHP source: backend/src/AgentTeam/Services/WorkflowOutputStorage.php (478 lines).
"""
from __future__ import annotations

import json
import os

import pytest

from app.agent_team.services import workflow_output_storage as wos_module
from app.agent_team.services.workflow_output_storage import WorkflowOutputStorage


class FakeDb:
    def __init__(self, one=None):
        self.one = list(one or [])
        self.calls = []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None


def svc(db=None, config=None, tmp_root=None):
    cfg = dict(config or {})
    if tmp_root is not None:
        cfg['workflow_outputs_path'] = str(tmp_root)
    return WorkflowOutputStorage(db if db is not None else FakeDb(), cfg)


# ─── buildFullPath (PHP 35-48) ─────────────────────────────────────────────

def test_build_full_path_root_only():
    assert svc().buildFullPath('', '') == 'synergyaichatroot'


def test_build_full_path_with_folder_and_path():
    assert svc().buildFullPath('myfolder', 'sub/file.json') == 'synergyaichatroot/myfolder/sub/file.json'


def test_build_full_path_trims_slashes():
    assert svc().buildFullPath('/myfolder/', '/sub/file.json/') == 'synergyaichatroot/myfolder/sub/file.json'


def test_build_full_path_folder_only():
    assert svc().buildFullPath('myfolder') == 'synergyaichatroot/myfolder'


# ─── sanitizeFilename (PHP 260-271) ────────────────────────────────────────

@pytest.mark.parametrize('name,expected', [
    ('My Workflow', 'My_Workflow'),
    ('Weird!@# Name$%^', 'Weird_Name'),
    ('a___b', 'a_b'),
    ('__leading_trailing__', 'leading_trailing'),
    ('', 'workflow'),
    ('!!!', 'workflow'),
    ('Already_Clean', 'Already_Clean'),
    ('Mix 123-test_ok', 'Mix_123-test_ok'),
])
def test_sanitize_filename(name, expected):
    assert svc().sanitizeFilename(name) == expected


# ─── generateFilename (PHP 248-253) ────────────────────────────────────────

def test_generate_filename_pattern():
    import re
    result = svc().generateFilename('My Workflow')
    assert re.fullmatch(r'My_Workflow_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json', result), result


def test_generate_filename_frozen_timestamp(monkeypatch):
    monkeypatch.setattr(wos_module, '_generate_timestamp', lambda: '2026-03-31_19-45-30')
    assert svc().generateFilename('My Workflow') == 'My_Workflow_2026-03-31_19-45-30.json'


def test_generate_filename_empty_name_uses_workflow_fallback(monkeypatch):
    monkeypatch.setattr(wos_module, '_generate_timestamp', lambda: '2026-03-31_19-45-30')
    assert svc().generateFilename('!!!') == 'workflow_2026-03-31_19-45-30.json'


# ─── getWorkflow (PHP 207-215) ─────────────────────────────────────────────

def test_get_workflow_sql_byte_identical_and_found():
    db = FakeDb(one=[{'id': 5, 'name': 'WF', 'user_id': 3,
                       'output_storage_enabled': 1, 'output_folder': None}])
    s = svc(db)
    result = s.getWorkflow(5)
    assert result == {'id': 5, 'name': 'WF', 'user_id': 3,
                       'output_storage_enabled': 1, 'output_folder': None}
    assert db.calls == [(
        "SELECT id, name, user_id, output_storage_enabled, output_folder\n"
        "             FROM agent_workflows WHERE id = ?",
        [5],
    )]


def test_get_workflow_not_found():
    db = FakeDb(one=[None])
    assert svc(db).getWorkflow(999) is None


# ─── getStorageConfig (PHP 221-242) ────────────────────────────────────────

def test_get_storage_config_sql_byte_identical():
    db = FakeDb(one=[{'storage_provider': 's3', 'storage_folder': 'myfolder'}])
    s = svc(db)
    s.getStorageConfig(3, {'output_folder': None})
    assert db.calls == [(
        "SELECT storage_provider, storage_folder FROM users WHERE id = ?",
        [3],
    )]


def test_get_storage_config_defaults_when_no_user_row():
    db = FakeDb(one=[None])
    result = svc(db).getStorageConfig(3, {'output_folder': None})
    assert result == {'provider': 'local', 'folder': ''}


def test_get_storage_config_defaults_when_columns_null():
    db = FakeDb(one=[{'storage_provider': None, 'storage_folder': None}])
    result = svc(db).getStorageConfig(3, {'output_folder': None})
    assert result == {'provider': 'local', 'folder': ''}


def test_get_storage_config_workflow_folder_overrides_user_folder():
    db = FakeDb(one=[{'storage_provider': 's3', 'storage_folder': 'user-folder'}])
    result = svc(db).getStorageConfig(3, {'output_folder': 'workflow-folder'})
    assert result == {'provider': 's3', 'folder': 'workflow-folder'}


def test_get_storage_config_empty_workflow_folder_does_not_override():
    db = FakeDb(one=[{'storage_provider': 's3', 'storage_folder': 'user-folder'}])
    result = svc(db).getStorageConfig(3, {'output_folder': ''})
    assert result == {'provider': 's3', 'folder': 'user-folder'}


# ─── universalFS-unavailable path (PHP 360-401) ────────────────────────────

def test_get_universal_fs_client_always_none_no_api_key(monkeypatch):
    logs = []
    monkeypatch.setattr(wos_module, 'error_log', lambda msg: logs.append(msg))
    s = svc(config={})
    assert s.getUniversalFSClient(7) is None
    assert logs == ['[WorkflowOutputStorage] No universalFS API key configured for user 7']


def test_get_universal_fs_client_always_none_with_api_key(monkeypatch):
    logs = []
    monkeypatch.setattr(wos_module, 'error_log', lambda msg: logs.append(msg))
    s = svc(config={'universalfs': {'api_key': 'some-key'}})
    assert s.getUniversalFSClient(7) is None
    assert logs == [
        '[WorkflowOutputStorage] universalFS client unavailable for user 7 '
        '(universalFS is a PHP-only package, not ported)'
    ]


def test_get_user_universal_fs_api_key_config_only():
    assert svc(config={}).getUserUniversalFSApiKey(3) is None
    assert svc(config={'universalfs': {'api_key': 'k'}}).getUserUniversalFSApiKey(3) == 'k'


def test_save_to_storage_falls_back_to_local(tmp_path):
    s = svc(tmp_root=tmp_path)
    result = s.saveToStorage('s3', 'synergyaichatroot/f/out.json', '{"a":1}', 3)
    assert result == {'success': True}
    assert (tmp_path / '3' / 'synergyaichatroot' / 'f' / 'out.json').read_text() == '{"a":1}'


def test_list_from_storage_falls_back_to_local_empty(tmp_path):
    s = svc(tmp_root=tmp_path)
    assert s.listFromStorage('s3', 'synergyaichatroot/f', 'pat_', 3) == []


def test_read_from_storage_falls_back_to_local_not_found(tmp_path):
    s = svc(tmp_root=tmp_path)
    with pytest.raises(RuntimeError, match='File not found: synergyaichatroot/f/missing.json'):
        s.readFromStorage('s3', 'synergyaichatroot/f/missing.json', 3)


# ─── local fallback round trip (PHP 410-477) ───────────────────────────────

def test_local_fallback_save_list_read_round_trip(tmp_path):
    s = svc(tmp_root=tmp_path)

    save_result = s.saveToLocalFallback('synergyaichatroot/f/out_1.json', '{"x":1}', 3)
    assert save_result == {'success': True}

    read_result = s.readFromLocalFallback('synergyaichatroot/f/out_1.json', 3)
    assert read_result == '{"x":1}'

    list_result = s.listFromLocalFallback('synergyaichatroot/f', 'out_', 3)
    assert len(list_result) == 1
    entry = list_result[0]
    assert list(entry.keys()) == ['name', 'size', 'modified', 'path']
    assert entry['name'] == 'out_1.json'
    assert entry['size'] == len('{"x":1}')
    assert entry['path'] == 'synergyaichatroot/f/out_1.json'
    # Y-m-d H:i:s format
    import re
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', entry['modified'])


def test_local_fallback_list_filters_by_pattern_and_sorts_desc(tmp_path):
    s = svc(tmp_root=tmp_path)
    s.saveToLocalFallback('synergyaichatroot/f/other_1.json', 'x', 3)
    s.saveToLocalFallback('synergyaichatroot/f/out_1.json', 'x', 3)
    s.saveToLocalFallback('synergyaichatroot/f/out_2.json', 'x', 3)

    # Force distinct mtimes so descending order is unambiguous.
    base = tmp_path / '3' / 'synergyaichatroot' / 'f'
    os.utime(base / 'out_1.json', (1000, 1000))
    os.utime(base / 'out_2.json', (2000, 2000))

    result = s.listFromLocalFallback('synergyaichatroot/f', 'out_', 3)
    assert [f['name'] for f in result] == ['out_2.json', 'out_1.json']


def test_local_fallback_list_missing_dir_returns_empty(tmp_path):
    s = svc(tmp_root=tmp_path)
    assert s.listFromLocalFallback('synergyaichatroot/nope', 'out_', 3) == []


def test_local_fallback_read_missing_file_raises(tmp_path):
    s = svc(tmp_root=tmp_path)
    with pytest.raises(RuntimeError, match='File not found: synergyaichatroot/f/missing.json'):
        s.readFromLocalFallback('synergyaichatroot/f/missing.json', 3)


def test_local_fallback_default_base_path_matches_php_dir_relative():
    # PHP __DIR__ . '/../../../../storage/workflow_outputs' from
    # backend/src/AgentTeam/Services/WorkflowOutputStorage.php resolves to
    # <htdocs>/gpt/storage/workflow_outputs (verified via `php -r`).
    assert wos_module._DEFAULT_BASE_PATH.endswith('/gpt/storage/workflow_outputs')


# ─── saveOutput / listOutputs / getOutput full flow (PHP 58-202) ──────────

def _workflow_row(**overrides):
    row = {'id': 5, 'name': 'My Workflow', 'user_id': 3,
            'output_storage_enabled': 1, 'output_folder': None}
    row.update(overrides)
    return row


def test_save_output_workflow_not_found():
    db = FakeDb(one=[None])
    result = svc(db).saveOutput(5, 3, {'a': 1})
    assert result == {'success': False, 'error': 'Workflow not found'}


def test_save_output_storage_not_enabled():
    db = FakeDb(one=[_workflow_row(output_storage_enabled=0)])
    result = svc(db).saveOutput(5, 3, {'a': 1})
    assert result == {'success': False, 'error': 'Output storage not enabled for this workflow'}


def test_save_output_storage_not_configured():
    db = FakeDb(one=[_workflow_row(), {'storage_provider': 'local', 'storage_folder': None}])
    result = svc(db).saveOutput(5, 3, {'a': 1})
    assert result == {'success': False, 'error': 'Storage not configured'}


def test_save_output_success_writes_pretty_unicode_json(tmp_path, monkeypatch):
    monkeypatch.setattr(wos_module, '_generate_timestamp', lambda: '2026-03-31_19-45-30')
    db = FakeDb(one=[_workflow_row(), {'storage_provider': 'local', 'storage_folder': 'myfolder'}])
    s = svc(db, tmp_root=tmp_path)

    result = s.saveOutput(5, 3, {'msg': 'héllo/wörld', 'n': 1})

    assert list(result.keys()) == ['success', 'filename', 'path', 'provider']
    assert result['success'] is True
    assert result['filename'] == 'My_Workflow_2026-03-31_19-45-30.json'
    assert result['path'] == 'synergyaichatroot/myfolder/My_Workflow_2026-03-31_19-45-30.json'
    assert result['provider'] == 'local'

    written = (tmp_path / '3' / 'synergyaichatroot' / 'myfolder'
               / 'My_Workflow_2026-03-31_19-45-30.json').read_text(encoding='utf-8')
    assert written == '{\n    "msg": "héllo\\/wörld",\n    "n": 1\n}'
    assert json.loads(written.replace('\\/', '/')) == {'msg': 'héllo/wörld', 'n': 1}


def test_list_outputs_storage_not_configured():
    db = FakeDb(one=[_workflow_row(), {'storage_provider': 'local', 'storage_folder': None}])
    result = svc(db).listOutputs(5, 3)
    assert result == {'success': True, 'files': [], 'message': 'Storage not configured'}


def test_list_outputs_after_save(tmp_path, monkeypatch):
    monkeypatch.setattr(wos_module, '_generate_timestamp', lambda: '2026-03-31_19-45-30')
    db = FakeDb(one=[
        _workflow_row(), {'storage_provider': 'local', 'storage_folder': 'myfolder'},
        _workflow_row(), {'storage_provider': 'local', 'storage_folder': 'myfolder'},
    ])
    s = svc(db, tmp_root=tmp_path)
    s.saveOutput(5, 3, {'a': 1})

    result = s.listOutputs(5, 3)
    assert result['success'] is True
    assert result['provider'] == 'local'
    assert result['folder'] == 'myfolder'
    assert [f['name'] for f in result['files']] == ['My_Workflow_2026-03-31_19-45-30.json']


def test_get_output_workflow_not_found():
    db = FakeDb(one=[None])
    result = svc(db).getOutput(5, 3, 'out.json')
    assert result == {'success': False, 'error': 'Workflow not found'}


def test_get_output_storage_not_configured():
    db = FakeDb(one=[_workflow_row(), {'storage_provider': 'local', 'storage_folder': None}])
    result = svc(db).getOutput(5, 3, 'out.json')
    assert result == {'success': False, 'error': 'Storage not configured'}


def test_get_output_file_not_found_returns_error_no_log(tmp_path, monkeypatch):
    logs = []
    monkeypatch.setattr(wos_module, 'error_log', lambda msg: logs.append(msg))
    db = FakeDb(one=[_workflow_row(), {'storage_provider': 'local', 'storage_folder': 'myfolder'}])
    s = svc(db, tmp_root=tmp_path)

    result = s.getOutput(5, 3, 'missing.json')

    assert result == {
        'success': False,
        'error': 'File not found: synergyaichatroot/myfolder/missing.json',
    }
    # PHP's getOutput catch block (196-201) does not error_log — the only
    # log line here is getUniversalFSClient's routine no-key message.
    assert logs == ['[WorkflowOutputStorage] No universalFS API key configured for user 3']


def test_save_output_then_get_output_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(wos_module, '_generate_timestamp', lambda: '2026-03-31_19-45-30')
    db = FakeDb(one=[
        _workflow_row(), {'storage_provider': 'local', 'storage_folder': 'myfolder'},
        _workflow_row(), {'storage_provider': 'local', 'storage_folder': 'myfolder'},
    ])
    s = svc(db, tmp_root=tmp_path)
    save_result = s.saveOutput(5, 3, {'a': 1})

    get_result = s.getOutput(5, 3, save_result['filename'])
    assert get_result['success'] is True
    assert get_result['filename'] == save_result['filename']
    assert json.loads(get_result['content']) == {'a': 1}
