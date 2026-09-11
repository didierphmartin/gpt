import os, sys, socket
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main as runner


def _pkg(tmp_path, monkeypatch, name="demo_modular"):
    scripts = tmp_path / "scripts"
    (scripts / name).mkdir(parents=True)
    # A stand-in for the generated api.py: serves the identity endpoint only.
    # protocol_version='HTTP/1.1' (+ Content-Length) keeps the connection alive so the
    # *client* is the active TCP closer, not this server's listening port -- otherwise
    # the port sits in TIME_WAIT after the process is killed and the "port is free
    # again" check below fails spuriously.
    (scripts / name / "api.py").write_text(
        "import argparse, json, http.server\n"
        "ap = argparse.ArgumentParser(); ap.add_argument('--host', default='127.0.0.1')\n"
        "ap.add_argument('--port', type=int, default=8710); a = ap.parse_args()\n"
        "CARD = json.dumps({'workflow_id': 44, 'name': 'Demo', 'version': '44-x', 'protocol': 'run/1'}).encode()\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    protocol_version = 'HTTP/1.1'\n"
        "    def do_GET(self):\n"
        "        self.send_response(200 if self.path == '/.well-known/workflow.json' else 404)\n"
        "        self.send_header('Content-Type', 'application/json')\n"
        "        self.send_header('Content-Length', str(len(CARD))); self.end_headers()\n"
        "        self.wfile.write(CARD)\n"
        "    def log_message(self, *a): pass\n"
        "http.server.HTTPServer((a.host, a.port), H).serve_forever()\n"
    )
    monkeypatch.setattr(runner, "SCRIPTS_DIR", scripts)
    return scripts


def test_resolve_package_dir_refuses_traversal_and_missing_api(tmp_path, monkeypatch):
    _pkg(tmp_path, monkeypatch)
    assert runner._resolve_package_dir("demo_modular").name == "demo_modular"
    for bad in ("../etc", "demo_modular/agents", "nope", ".hidden"):
        with pytest.raises(ValueError):
            runner._resolve_package_dir(bad)


def test_start_serves_and_is_reused_then_stopped(tmp_path, monkeypatch):
    _pkg(tmp_path, monkeypatch)
    try:
        first = runner._start_workflow_server("demo_modular")
        assert first["url"].startswith("http://127.0.0.1:")
        assert first["reused"] is False
        again = runner._start_workflow_server("demo_modular")
        assert again["url"] == first["url"]
        assert again["reused"] is True
    finally:
        assert runner._stop_workflow_server("demo_modular")["stopped"] is True
    # The port is free again.
    port = int(first["url"].rsplit(":", 1)[1].strip("/"))
    with socket.socket() as s:
        s.bind(("127.0.0.1", port))
