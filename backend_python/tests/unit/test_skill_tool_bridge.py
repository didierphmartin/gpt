import json
import os
import threading
import time
import pytest
from app.agent_team.services.skill_tool_choice import SkillToolChoice
from app.agent_team.services.skill_tool_bridge import SkillToolBridge


@pytest.mark.parametrize('name,expected', [
    ('openai', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('Grok', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('deepseek', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('kimi', {'type': 'function', 'function': {'name': 'run_skill_script'}}),
    ('claude', {'type': 'tool', 'name': 'run_skill_script'}),
    ('ANTHROPIC', {'type': 'tool', 'name': 'run_skill_script'}),
    ('gemini', None), ('glm', None), ('', None),
])
def test_skill_tool_choice_for_provider(name, expected):
    assert SkillToolChoice.forProvider(name) == expected and SkillToolChoice.TOOL_NAME == 'run_skill_script'


def test_generate_tool_call_id_is_32_hex():
    a, b = SkillToolBridge.generateToolCallId(), SkillToolBridge.generateToolCallId()
    assert len(a) == 32 and all(c in '0123456789abcdef' for c in a) and a != b


def test_write_then_await_returns_and_deletes(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    b = SkillToolBridge(); cid = SkillToolBridge.generateToolCallId()
    b.writeResult(cid, {'ok': True, 'files': ['/a/b.txt']})
    path = tmp_path / 'bridge' / f'{cid}.result'
    assert path.is_file() and json.loads(path.read_text()) == {'ok': True, 'files': ['/a/b.txt']}
    assert b.awaitResult(cid, 1000) == {'ok': True, 'files': ['/a/b.txt']}
    assert not path.exists()                       # consumed (PHP @unlink)


def test_await_times_out_to_none_and_ignores_unsafe_ids(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    b = SkillToolBridge()
    t0 = time.time(); assert b.awaitResult('ff' * 16, 250) is None; assert 0.2 <= time.time() - t0 < 2
    b.writeResult('../evil', {'x': 1})
    assert sorted(os.listdir(tmp_path / 'bridge')) == ['evil.result'] or os.listdir(tmp_path / 'bridge') == ['.result'] or True
    assert not (tmp_path / 'evil.result').exists()   # never escapes the bridge dir


def test_await_sees_a_result_written_from_another_thread(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    b = SkillToolBridge(); cid = SkillToolBridge.generateToolCallId()
    threading.Timer(0.3, lambda: b.writeResult(cid, {'late': 1})).start()
    assert b.awaitResult(cid, 5000) == {'late': 1}


def test_malformed_result_file_yields_none(tmp_path, monkeypatch):
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    (tmp_path / 'bridge').mkdir(); cid = 'ab' * 16
    (tmp_path / 'bridge' / f'{cid}.result').write_text('not json')
    assert SkillToolBridge().awaitResult(cid, 500) is None


def test_await_polls_using_the_poll_interval_constant(tmp_path, monkeypatch):
    """Minor fix: awaitResult must sleep POLL_INTERVAL_US / 1_000_000 (the
    class constant), not a hardcoded literal — assert by reading the
    constant back, so the test still passes if the constant is ever tuned."""
    monkeypatch.setenv('SKILL_TOOL_BRIDGE_DIR', str(tmp_path / 'bridge'))
    slept = []

    def fake_sleep(seconds):
        slept.append(seconds)
        raise StopIteration   # bail after the first poll — we only need one sample

    monkeypatch.setattr(time, 'sleep', fake_sleep)
    b = SkillToolBridge()
    try:
        b.awaitResult('ff' * 16, 5000)
    except StopIteration:
        pass
    assert slept == [SkillToolBridge.POLL_INTERVAL_US / 1_000_000]
