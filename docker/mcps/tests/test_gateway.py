import http.client
import json
import shutil
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import supervisor
from mcphost import gateway
from mcphost.registry import Registry


class Backend(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _echo(self):
        if "chunked" in (self.headers.get("Transfer-Encoding") or ""):
            body = b""
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    break
                body += self.rfile.read(size)
                self.rfile.readline()
            body = body.decode()
        else:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n).decode() if n else ""
        path, _, query = self.path.partition("?")
        if path == "/sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for i in (1, 2):
                chunk = f"data: {i}\n\n".encode()
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
                if i == 1:
                    time.sleep(2)
            self.wfile.write(b"0\r\n\r\n")
            return
        data = json.dumps({"method": self.command, "path": path, "query": query, "body": body,
                           "host": self.headers.get("Host"), "x": self.headers.get("X-Custom")}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = _echo


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        self.backend.daemon_threads = True
        threading.Thread(target=self.backend.serve_forever, daemon=True).start()
        self.registry = Registry(self.root)
        self.registry.add("ok_server", "ok", None)
        data = self.registry.load()
        data["ok_server"]["port"] = self.backend.server_address[1]
        self.registry._save(data)
        self.registry.add("stopped_server", "stopped", None)   # registered, nothing listens on its port
        self.srv = gateway.make_server(self.registry, port=0)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        for s in (self.srv, self.backend):
            s.shutdown()
            s.server_close()
        shutil.rmtree(self.root, ignore_errors=True)

    def request(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request(method, path, body, headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, data

    def test_routes_by_folder_and_keeps_path_and_query(self):
        status, raw = self.request("POST", "/ok_server/mcp?x=1", b'{"a":1}', {"X-Custom": "yes"})
        j = json.loads(raw)
        self.assertEqual(status, 201)
        self.assertEqual({k: j[k] for k in ("method", "path", "query", "body")},
                         {"method": "POST", "path": "/mcp", "query": "x=1", "body": '{"a":1}'})
        self.assertEqual(j["x"], "yes")
        self.assertEqual(j["host"], f"127.0.0.1:{self.backend.server_address[1]}")

    def test_other_methods_and_bare_folder(self):
        self.assertEqual(json.loads(self.request("DELETE", "/ok_server/a/b")[1])["path"], "/a/b")
        self.assertEqual(json.loads(self.request("GET", "/ok_server")[1])["path"], "/")

    def test_chunked_request_body(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request("POST", "/ok_server/mcp", iter([b"ab", b"cd"]), {"Transfer-Encoding": "chunked"}, encode_chunked=True)
        r = c.getresponse()
        self.assertEqual(json.loads(r.read())["body"], "abcd")
        c.close()

    def test_streams_before_close(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        t0 = time.monotonic()
        c.request("GET", "/ok_server/sse")
        r = c.getresponse()
        first = r.readline()
        self.assertEqual(first, b"data: 1\n")
        self.assertLess(time.monotonic() - t0, 1.5)
        rest = r.read()
        self.assertIn(b"data: 2", rest)
        c.close()

    def test_unknown_and_down(self):
        self.assertEqual(self.request("GET", "/nope/mcp")[0], 404)
        self.assertEqual(self.request("GET", "/stopped_server/mcp")[0], 502)

    def test_root_and_empty_segment_are_404(self):
        self.assertEqual(self.request("GET", "/")[0], 404)
        self.assertEqual(self.request("GET", "//mcp")[0], 404)

    def test_server_installed_after_start_is_routable(self):
        self.registry.add("late", "late", None)
        data = self.registry.load()
        data["late"]["port"] = self.backend.server_address[1]
        self.registry._save(data)
        self.assertEqual(self.request("GET", "/late/x")[0], 201)


class SupervisorTest(unittest.TestCase):
    def test_build_starts_both_servers_and_stops(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        app = supervisor.build(root, "tok", control_port=0, gateway_port=0)
        app.start()
        try:
            for srv in (app.control, app.gateway):
                c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=10)
                c.request("GET", "/servers" if srv is app.control else "/")
                r = c.getresponse()
                r.read()
                c.close()
                self.assertEqual(r.status, 401 if srv is app.control else 404)
        finally:
            app.stop()
        self.assertFalse(app.control_thread.is_alive())
        self.assertFalse(app.gateway_thread.is_alive())

    def test_token_from_env_then_file(self):
        with mock.patch.dict("os.environ", {"MCPS_TOKEN": "fromenv"}):
            self.assertEqual(supervisor.read_token("/nonexistent", wait=0), "fromenv")
        f = Path(tempfile.mkdtemp()) / "secrets.env"
        self.addCleanup(shutil.rmtree, f.parent, True)
        f.write_text('OTHER=1\nMCPS_TOKEN="filetok"\n')
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(supervisor.read_token(f, wait=0), "filetok")
            with self.assertRaises(SystemExit):
                supervisor.read_token(f.parent / "missing", wait=0)


if __name__ == "__main__":
    unittest.main()
