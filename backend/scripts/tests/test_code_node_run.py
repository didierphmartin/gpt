"""code_node_run.py: the harness over stdin/stdout, MCP calls with each server's stored headers."""
import json
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / "backend" / "scripts" / "code_node_run.py"
HARNESS_DIR = ROOT / "frontend" / "assets" / "py"
sys.path.insert(0, str(RUNNER.parent))


class FakeMcp(BaseHTTPRequestHandler):
    seen = []   # (method, headers dict)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeMcp.seen.append((body.get("method"), dict(self.headers)))
        match body.get("method"):
            case "initialize":
                result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}}
            case "tools/call":
                args = body["params"]["arguments"]
                if args.get("folder") == "Broken":
                    result = {"isError": True, "content": [{"type": "text", "text": "mailbox_locked"}]}
                else:
                    data = {"mail": None} if args.get("folder") == "Empty" else {"mail": {"id": "m1", "subject": "Hi"}}
                    result = {"content": [{"type": "text", "text": json.dumps(data)}]}
            case _:
                result = {}
        out = json.dumps({"jsonrpc": "2.0", "id": body.get("id"), "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


POLL = '''
def run(input, call_tool):
    r = call_tool("outlook", "poll_new_mail", {"folder": input})
    if r.get("mail") is None:
        return {"route": "no_mail", "output": None}
    return {"route": "new_mail", "output": r["mail"]}
'''


class CodeNodeRun(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(("127.0.0.1", 0), FakeMcp)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.httpd.server_port}/mcp"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def run_node(self, req):
        p = subprocess.run([sys.executable, str(RUNNER), str(HARNESS_DIR)], input=json.dumps(req),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def req(self, folder, **kw):
        base = {"source": POLL, "exits": ["new_mail", "no_mail", "error"], "timeout_s": 10,
                "parents": [{"name": "start", "text": folder, "start": True}], "user_prompt": folder,
                "servers": {"outlook": {"url": self.url, "headers": {"X-Outlook-Account": "k-123"}}}}
        base.update(kw)
        return base

    def test_new_mail_route_and_output(self):
        res = self.run_node(self.req("Inbox"))
        self.assertTrue(res["ok"])
        self.assertEqual(res["route"], "new_mail")
        self.assertEqual(json.loads(res["output_text"]), {"id": "m1", "subject": "Hi"})

    def test_no_mail_route(self):
        res = self.run_node(self.req("Empty"))
        self.assertEqual((res["route"], res["output_text"]), ("no_mail", "null"))

    def test_stored_headers_reach_the_server(self):
        FakeMcp.seen.clear()
        self.run_node(self.req("Inbox"))
        calls = [h for m, h in FakeMcp.seen if m == "tools/call"]
        self.assertEqual(calls[0].get("X-Outlook-Account"), "k-123")

    def test_tool_error_result_takes_error_exit(self):
        res = self.run_node(self.req("Broken"))
        self.assertTrue(res["ok"])
        self.assertEqual(res["route"], "error")
        self.assertIn("mailbox_locked", res["output_text"])

    def test_unreachable_server_takes_error_exit(self):
        res = self.run_node(self.req("Inbox", servers={"outlook": {"url": "http://127.0.0.1:9/mcp", "headers": {}}}))
        self.assertEqual(res["route"], "error")
        self.assertIn("outlook", res["output_text"])

    def test_timeout(self):
        slow = "def run(input, call_tool):\n    while True:\n        pass\n"
        res = self.run_node(self.req("Inbox", source=slow, timeout_s=1))
        self.assertEqual(res["route"], "error")
        self.assertIn("timed out", res["output_text"])


class VersionGuard(unittest.TestCase):
    def test_old_python_message_names_interpreter_and_override(self):
        import code_node_run
        out = json.loads(code_node_run.old_python_result((3, 9, 6), "/usr/bin/python3"))
        self.assertFalse(out["ok"])
        self.assertIn("/usr/bin/python3", out["error"])
        self.assertIn("CODE_NODE_PYTHON", out["error"])
        self.assertIn("3.10", out["error"])

    def test_entry_module_has_no_match_statement(self):
        # the entry file must still parse on 3.9 so the guard can run there
        import ast
        tree = ast.parse(RUNNER.read_text(), feature_version=(3, 9))
        self.assertTrue(tree)


if __name__ == "__main__":
    unittest.main()
