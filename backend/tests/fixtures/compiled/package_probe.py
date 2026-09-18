"""Execute an emitted package: start its server, run one turn, read the answer.

Usage: python package_probe.py <folder-name-under-scripts>

Exits 0 only if a terminal `done` frame arrives with a non-empty output. This is
the only check that can see an import-time failure -- api.py imports workflow.py,
and these scripts have only ever run as __main__.
"""
import json
import sys
import time
import urllib.request

RUNNER = "http://127.0.0.1:8765"


def post(path, body):
    req = urllib.request.Request(
        RUNNER + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def main(folder):
    started = post("/api/workflow-server/start", {"folder": folder})
    base = started["url"].rstrip("/")
    print(f"[probe] server at {base}", flush=True)

    run = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{base}/runs", data=json.dumps({"prompt": "say hello"}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"), timeout=60).read())
    run_id = run["run_id"]
    print(f"[probe] run {run_id}", flush=True)

    deadline = time.time() + 300
    with urllib.request.urlopen(f"{base}/runs/{run_id}/events", timeout=300) as stream:
        for raw in stream:
            if time.time() > deadline:
                print("[probe] FAIL timed out with no terminal frame", flush=True)
                return 1
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:].strip())
            if "error" in ev:
                print(f"[probe] FAIL error frame: {ev['error']}", flush=True)
                return 1
            if ev.get("status") == "completed":
                out = ev.get("output") or ""
                print(f"[probe] done, {len(out)} chars", flush=True)
                return 0 if out.strip() else 1
    print("[probe] FAIL stream ended with no terminal frame", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
