"""A minimal MCP server for the ADK E2E test: logs every request, answers two tools."""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]
RESULTS = {"next_mail": {"subject": "test 50", "id": "m1"}, "move_mail": {"ok": True}, "wait_for_new": None}
NEXT = [0]    # next_mail calls so far
WAITS = [0]   # wait_for_new: "ready" on the first call, then a 1 s wait and "timeout"
if len(sys.argv) > 3 and sys.argv[3] == "empty":
    RESULTS["next_mail"] = None   # no new mail: the tool answers null
if len(sys.argv) > 3 and sys.argv[3] == "claim":
    RESULTS["next_mail"] = {"subject": "my car claim", "id": "m2"}


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path.endswith("/systemone"):   # a fake TypeSafe Jev: "claim" in the request -> B, else unclear
            with open(LOG, "a") as f:
                f.write(json.dumps({"method": "jev", "request": req.get("state", {}).get("request"),
                                    "criteria": sorted(req["questions"]["route"]["criteria"]),
                                    "headers": {k.lower(): v for k, v in self.headers.items()}}) + "\n")
            choice = "B" if "claim" in str(req.get("state", {}).get("request", "")) else "unclear"
            data = json.dumps({"answers": {"route": {"choice": choice, "confidence": 0.97}}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        params = req.get("params") or {}
        with open(LOG, "a") as f:
            f.write(json.dumps({"method": req.get("method"), "tool": params.get("name"), "args": params.get("arguments"),
                                "headers": {k.lower(): v for k, v in self.headers.items()}}) + "\n")
        if req.get("method") == "initialize":
            body = {"jsonrpc": "2.0", "id": req.get("id"), "result": {"protocolVersion": "2024-11-05", "capabilities": {}}}
        elif req.get("method") == "tools/call":
            res = RESULTS.get(params.get("name"))
            if params.get("name") == "next_mail":   # one new mail, handed out once (a drain asks again)
                NEXT[0] += 1
                res = RESULTS["next_mail"] if NEXT[0] == 1 else None
            if params.get("name") == "wait_for_new":
                WAITS[0] += 1
                if WAITS[0] > 1:
                    import time
                    time.sleep(1)
                res = {"status": "ready" if WAITS[0] == 1 else "timeout"}
            body = {"jsonrpc": "2.0", "id": req.get("id"),
                    "result": {"content": [{"type": "text", "text": json.dumps(res)}], **({"structuredContent": res} if res is not None else {})}
                    if params.get("name") in RESULTS else {"isError": True, "content": [{"type": "text", "text": "no such tool"}]}}
        else:
            self.send_response(202); self.end_headers(); return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


from http.server import ThreadingHTTPServer
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
