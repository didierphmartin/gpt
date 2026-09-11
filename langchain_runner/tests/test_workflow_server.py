import os, sys, socket, time
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
    """An UNCHANGED package is reused: the live process is still serving the
    same modules it imported at boot, so respawning would only cost a second.
    """
    _pkg(tmp_path, monkeypatch)
    try:
        first = runner._start_workflow_server("demo_modular")
        assert first["url"].startswith("http://127.0.0.1:")
        assert first["reused"] is False
        again = runner._start_workflow_server("demo_modular")
        assert again["url"] == first["url"]
        assert again["reused"] is True
        assert again["pid"] == first["pid"]
    finally:
        assert runner._stop_workflow_server("demo_modular")["stopped"] is True
    # The port is free again.
    port = int(first["url"].rsplit(":", 1)[1].strip("/"))
    with socket.socket() as s:
        s.bind(("127.0.0.1", port))


def test_start_respawns_when_the_package_was_recompiled(tmp_path, monkeypatch):
    """Finding 1 regression. Python imports the graph and the agent modules
    once, at import time, so a server started before a recompile serves the
    OLD graph forever -- every Run after an edit would silently execute the
    previous compile. Touching any *.py under the package must therefore
    retire the live process and spawn a fresh one.
    """
    scripts = _pkg(tmp_path, monkeypatch, name="edited_modular")
    first = None
    try:
        first = runner._start_workflow_server("edited_modular")
        assert first["reused"] is False
        # Simulate a recompile: the generator rewrites every file in place.
        node = scripts / "edited_modular" / "agents" / "node_a.py"
        node.parent.mkdir(parents=True, exist_ok=True)
        node.write_text("# regenerated\n")
        os.utime(node, (time.time() + 5, time.time() + 5))

        again = runner._start_workflow_server("edited_modular")
        assert again["reused"] is False, "a recompiled package must not reuse the live server"
        assert again["pid"] != first["pid"]
        assert again["url"] != first["url"]
        # The superseded process is gone, not orphaned holding its port.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                with socket.socket() as s:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    s.bind(("127.0.0.1", int(first["url"].rsplit(":", 1)[1].strip("/"))))
                break
            except OSError:
                time.sleep(0.1)
        else:
            pytest.fail("the stale workflow server is still holding its port")
    finally:
        runner._stop_workflow_server("edited_modular")


# The two stubs below patch socket.getfqdn() inside the *child* process to a
# constant before starting http.server.HTTPServer -- on this machine that
# call alone takes ~35s (DNS/mDNS configuration), which would make every
# test using these stubs slow without exercising anything relevant to the
# fix under test. This is scoped to the child subprocess only; it has no
# effect on the runner or on _pkg's stub above.
_FAST_BIND = (
    "import socket as _socket\n"
    "_socket.getfqdn = lambda *a, **k: 'localhost'\n"
)


def _pkg_verbose(tmp_path, monkeypatch, name="verbose_modular"):
    """A stub whose child writes well over a pipe's kernel buffer (commonly
    ~64KB) to stdout before it starts serving -- a direct trigger for
    Finding 1 (an unread PIPE deadlocks permanently once that buffer fills).
    """
    scripts = tmp_path / "scripts"
    (scripts / name).mkdir(parents=True)
    (scripts / name / "api.py").write_text(
        "import argparse, json, http.server, sys\n"
        + _FAST_BIND +
        "ap = argparse.ArgumentParser(); ap.add_argument('--host', default='127.0.0.1')\n"
        "ap.add_argument('--port', type=int, default=8710); a = ap.parse_args()\n"
        "for _ in range(2000):\n"
        "    print('x' * 100)\n"
        "sys.stdout.flush()\n"
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


def test_start_survives_more_than_64kb_of_child_stdout(tmp_path, monkeypatch):
    """Finding 1 regression. Before the fix, the child was spawned with
    stdout=PIPE and nothing ever drained it, so a child emitting over
    ~64KB before serving would deadlock on write() and never reach
    readiness -- this would time out at the 60s deadline instead of
    succeeding quickly.
    """
    _pkg_verbose(tmp_path, monkeypatch)
    t0 = time.monotonic()
    try:
        result = runner._start_workflow_server("verbose_modular")
        elapsed = time.monotonic() - t0
        assert result["reused"] is False
        assert result["url"].startswith("http://127.0.0.1:")
        assert elapsed < 30, f"took {elapsed:.1f}s -- looks like the child stalled on stdout"
    finally:
        runner._stop_workflow_server("verbose_modular")


def _pkg_stubborn(tmp_path, monkeypatch, name="stubborn_modular"):
    """A stub that ignores SIGTERM, forcing _stop_workflow_server's kill()
    fallback -- the path Finding 3's missing second proc.wait() affected.
    """
    scripts = tmp_path / "scripts"
    (scripts / name).mkdir(parents=True)
    (scripts / name / "api.py").write_text(
        "import argparse, json, http.server, signal\n"
        + _FAST_BIND +
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
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


def test_stop_reaps_a_killed_child_no_zombie(tmp_path, monkeypatch):
    """Finding 3 regression. proc.kill() alone doesn't reap the process --
    without a second proc.wait() the child lingers as a zombie until
    something else collects it. Force the kill fallback with a child that
    ignores SIGTERM, then confirm os.waitpid reports it already reaped
    (ChildProcessError / ECHILD) rather than still sitting there.
    """
    _pkg_stubborn(tmp_path, monkeypatch)
    first = runner._start_workflow_server("stubborn_modular")
    pid = first["pid"]
    result = runner._stop_workflow_server("stubborn_modular")
    assert result["stopped"] is True
    with pytest.raises(ChildProcessError):
        os.waitpid(pid, os.WNOHANG)
