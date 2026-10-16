"""A stand-in Outlook MCP server for the standalone end-to-end test: python fake_outlook_mcp.py <port>.

wait_for_new: first call -> ready (via event); later calls wait 0.2 s -> timeout.
poll_new_mail: first call -> one mail; later calls -> no mail.
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAIL = "From: jane@acme.com\nSubject: Claim for water damage\n\nPipe burst."
TOOLS = [
    {"name": "wait_for_new", "description": "Wait for new mail", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "poll_new_mail", "description": "Poll new mail", "inputSchema": {"type": "object", "properties": {}}},
]
calls = {"wait_for_new": 0, "poll_new_mail": 0}
lock = threading.Lock()


def answer(name):
    with lock:
        calls[name] += 1
        first = calls[name] == 1
    if name == "wait_for_new":
        if first:
            return {"status": "ready", "via": "event"}
        time.sleep(0.2)
        return {"status": "timeout"}
    return {"mail": MAIL} if first else {"mail": None}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        method = req.get("method")
        if method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            data = answer(req["params"]["name"])
            result = {"structuredContent": data, "content": [{"type": "text", "text": json.dumps(data)}]}
        elif method == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "fake-outlook", "version": "0"}}
        else:
            result = {}
        if req.get("id") is None:
            self.send_response(202)
            self.end_headers()
            return
        body = json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
