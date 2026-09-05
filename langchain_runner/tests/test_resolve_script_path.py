import os, sys, pathlib, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main as runner


def _scripts(tmp_path, monkeypatch):
    scripts = tmp_path / "scripts"
    (scripts / "demo_a2a" / "agents").mkdir(parents=True)
    (scripts / "flat.py").write_text("print(1)")
    (scripts / "demo_a2a" / "orchestrator.py").write_text("print(2)")
    (scripts / "demo_a2a" / "agents" / "1_a.py").write_text("print(3)")
    monkeypatch.setattr(runner, "SCRIPTS_DIR", scripts)
    return scripts


def test_flat_file_still_resolves(tmp_path, monkeypatch):
    scripts = _scripts(tmp_path, monkeypatch)
    assert runner._resolve_script_path("flat.py") == (scripts / "flat.py").resolve()


def test_one_folder_level_resolves(tmp_path, monkeypatch):
    scripts = _scripts(tmp_path, monkeypatch)
    assert runner._resolve_script_path("demo_a2a/orchestrator.py") == (scripts / "demo_a2a" / "orchestrator.py").resolve()


@pytest.mark.parametrize("bad", ["../x.py", "demo_a2a/agents/1_a.py", ".hidden/x.py", "/abs/x.py", "demo_a2a/orchestrator.txt", "a\\b.py"])
def test_bad_paths_rejected(tmp_path, monkeypatch, bad):
    _scripts(tmp_path, monkeypatch)
    with pytest.raises((ValueError, FileNotFoundError)):
        runner._resolve_script_path(bad)
