"""FastAPI JSON backend for the LangChain/LangGraph workflow runner.

Pure API — no HTML templating. The companion ``index.html`` file can be
opened directly in a browser (or served by any static host) and will call
these endpoints via CORS-enabled fetch.

Endpoints:
  POST /api/workflows/list   → list workflows from the PHP backend
  POST /api/run              → run a workflow; SSE stream of logs + result
  POST /api/run-file         → run a saved .py file from scripts/; SSE stdout/stderr
  GET  /health               → liveness

CLI:
  python main.py             → start the FastAPI server (uvicorn)
  python main.py run <file>  → run a script from scripts/ directly, no server
"""
from __future__ import annotations

import asyncio
import atexit
import json
import logging
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

import httpx
from dotenv import load_dotenv
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from code_generator import generate_code
from graph_builder import build_and_run
from workflow_loader import WorkflowLoader

load_dotenv(Path(__file__).resolve().parent / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="LangChain Workflow Runner")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ListReq(BaseModel):
    backend_url: str
    jwt: str


class RunReq(BaseModel):
    backend_url: str
    jwt: str
    workflow_id: int
    model: str = "claude-sonnet-4-5"


class GenerateReq(BaseModel):
    backend_url: str
    jwt: str
    workflow_id: int


class RunFileReq(BaseModel):
    """Request to execute a saved .py file from scripts/ as a subprocess."""
    filename: str
    # CLI arguments forwarded verbatim to the script. Most generated
    # scripts consume their prompt via " ".join(sys.argv[1:]) and fall
    # back to a baked DEFAULT_PROMPT (often empty) when none is given —
    # which is why this is essential for non-trivial runs.
    args: list[str] = []


# Filesystem layout for static-script execution. `scripts/` is the only
# location we'll execute .py files from — same folder the webapp's
# workflow editor writes generated files into. The resolved path is
# checked to live under SCRIPTS_DIR to defend against path traversal.
INSTALL_ROOT = Path(__file__).parent
SCRIPTS_DIR = INSTALL_ROOT / "scripts"
OUTPUTS_DIR = INSTALL_ROOT / "outputs"
INDEX_HTML = INSTALL_ROOT / "index.html"

# File extensions accepted by /api/outputs and /api/output. Anything
# else under outputs/ is ignored.
OUTPUT_EXTENSIONS = {".md", ".html", ".json", ".txt"}


@app.get("/")
async def root():
    return FileResponse(INDEX_HTML)


@app.get("/health")
async def health():
    return {"ok": True, "default_backend": os.getenv("GPT_BACKEND_URL", "")}


@app.post("/api/workflows/list")
async def workflows_list(req: ListReq):
    loader = WorkflowLoader(req.backend_url, req.jwt)
    try:
        items = await loader.list_workflows()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Backend error: {e}")
    return {
        "workflows": [
            {"id": w.get("id"), "name": w.get("name"), "description": w.get("description")}
            for w in items
            if w.get("id")
        ]
    }


@app.post("/api/run")
async def run_workflow(req: RunReq):
    queue: asyncio.Queue[tuple[str, str] | None] = asyncio.Queue()

    def log_sink(event: str, msg: str) -> None:
        try:
            queue.put_nowait((event, msg))
        except Exception:
            pass

    loader = WorkflowLoader(req.backend_url, req.jwt)

    async def worker():
        try:
            result = await build_and_run(
                workflow_id=req.workflow_id,
                user_prompt=None,  # resolved from workflow's start node
                loader=loader,
                log_sink=log_sink,
                model_name=req.model,
            )
            log_sink("result", json.dumps(result))
        except Exception as e:
            logging.exception("Workflow run failed")
            log_sink("error", str(e))
        finally:
            await queue.put(None)

    async def stream():
        task = asyncio.create_task(worker())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                event, msg = item
                yield f"event: {event}\ndata: {msg}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/generate")
async def generate_workflow(req: GenerateReq):
    loader = WorkflowLoader(req.backend_url, req.jwt)
    try:
        result = await generate_code(req.workflow_id, loader)
    except Exception as e:
        logging.exception("Code generation failed")
        raise HTTPException(status_code=500, detail=str(e))

    # Save generated file alongside the runner
    out_path = Path(__file__).parent / result["filename"]
    out_path.write_text(result["code"], encoding="utf-8")
    result["saved_to"] = str(out_path)

    # Include debug info about the start node for troubleshooting
    try:
        wf = await loader.get_workflow(req.workflow_id)
        graph = wf.get("graph") or {}
        nodes = graph.get("nodes") or []
        start = next((n for n in nodes if (n.get("node_type") or n.get("type") or (n.get("config") or {}).get("type")) == "start"), None)
        if start:
            result["_debug_start_node"] = {
                "keys": list(start.keys()),
                "config_keys": list((start.get("config") or {}).keys()),
                "data_keys": list((start.get("data") or {}).keys()) if start.get("data") else [],
                "config_prompt": (start.get("config") or {}).get("prompt", "<MISSING>"),
                "data_prompt": (start.get("data") or {}).get("prompt", "<MISSING>"),
                "raw_truncated": json.dumps(start, default=str)[:600],
            }
    except Exception:
        pass

    return result


def _resolve_script_path(filename: str) -> Path:
    """Resolve a filename into an absolute path under SCRIPTS_DIR.

    Accepts a plain file ("workflow.py") or ONE folder level
    ("workflow_a2a/orchestrator.py" -- the A2A compile mode's entry point).
    Guards against traversal: no backslashes, no leading dots in any segment,
    at most two segments, must end with .py, and the resolved path must stay
    under the scripts directory. Raises ValueError on a bad filename,
    FileNotFoundError if the file doesn't exist.
    """
    if not filename or "\\" in filename or filename.startswith("/"):
        raise ValueError(f"Invalid script filename: {filename!r}")
    segments = filename.split("/")
    if len(segments) > 2 or any((not s) or s.startswith(".") for s in segments):
        raise ValueError(f"Invalid script filename: {filename!r}")
    if not filename.endswith(".py"):
        raise ValueError(f"Only .py files can be executed: {filename!r}")
    candidate = SCRIPTS_DIR.joinpath(*segments).resolve()
    scripts_root = SCRIPTS_DIR.resolve()
    if scripts_root not in candidate.parents:
        raise ValueError(f"Path escapes scripts directory: {filename!r}")
    if not candidate.exists():
        raise FileNotFoundError(f"Script not found: {candidate}")
    return candidate


async def _stream_script_run(script_path: Path, args: list[str] | None = None):
    """Async generator: spawn `python -u <script> [args...]` and yield
    SSE frames for each stdout/stderr line until the subprocess exits.

    Environment: the parent runner's env (inherited), so API keys loaded
    from .env via load_dotenv() flow through to the subprocess.
    CWD: the install root (so relative paths like outputs/ resolve there).
    """
    # Add INSTALL_ROOT to PYTHONPATH so scripts in scripts/ can
    # `from script_io import write_output` without sys.path hacks. The
    # subprocess interpreter doesn't add the CWD to sys.path on its own.
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        str(INSTALL_ROOT) + (os.pathsep + existing if existing else "")
    )
    cmd: list[str] = [sys.executable, "-u", str(script_path), *(args or [])]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(INSTALL_ROOT),
        env=env,
    )

    async def pump(stream, event_name):
        # Read line-by-line so the client sees incremental output.
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip("\n")
            # SSE frames can't contain bare newlines in data; readline()
            # strips the trailing one, and any embedded ones become
            # multiple data: lines.
            for chunk in text.split("\n"):
                yield f"event: {event_name}\ndata: {chunk}\n\n"

    # Merge stdout + stderr streams while preserving order roughly. We
    # use asyncio.Queue as a fan-in so both pumps publish to the same
    # SSE stream.
    queue: asyncio.Queue = asyncio.Queue()

    async def feed(gen):
        async for item in gen:
            await queue.put(item)
        await queue.put(None)  # sentinel

    pumps = [
        asyncio.create_task(feed(pump(proc.stdout, "stdout"))),
        asyncio.create_task(feed(pump(proc.stderr, "stderr"))),
    ]

    pending = len(pumps)
    while pending > 0:
        item = await queue.get()
        if item is None:
            pending -= 1
            continue
        yield item

    rc = await proc.wait()
    yield f"event: exit\ndata: {rc}\n\n"


_SERVERS: dict[str, subprocess.Popen] = {}   # folder -> live workflow server process
_SERVERS_LOCK = threading.Lock()             # guards _SERVERS now that routes run it off-thread


def _resolve_package_dir(folder: str) -> Path:
    """Path-traversal-safe lookup of a compiled package under scripts/.

    One plain path segment holding an api.py. Mirrors _resolve_script_path's
    rules: no '..', no absolute paths, no dotfiles, no nesting.
    """
    if not folder or "/" in folder or "\\" in folder or folder.startswith("."):
        raise ValueError(f"Invalid workflow folder: {folder!r}")
    candidate = (SCRIPTS_DIR / folder).resolve()
    if SCRIPTS_DIR.resolve() not in candidate.parents:
        raise ValueError(f"Path escapes scripts directory: {folder!r}")
    if not (candidate / "api.py").is_file():
        raise ValueError(f"No api.py in {folder!r} — regenerate with 'Agents in separate files'")
    return candidate


def _free_port() -> int:
    """A port the OS says is free right now. Racy in theory; the child binds it immediately."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _read_log_tail(log_path: Path, limit: int = 2000) -> str:
    """Best-effort read of a workflow server's captured stdout/stderr, for
    crash diagnostics. Never raises -- the file may already be gone.
    """
    try:
        return log_path.read_text(encoding="utf-8", errors="replace")[-limit:]
    except OSError:
        return ""


def _newest_py_mtime(pkg: Path) -> float:
    """The newest mtime of any *.py under a compiled package, or 0.0 if the
    tree can't be walked. Used to decide whether a live server is serving
    stale code.
    """
    newest = 0.0
    try:
        for path in pkg.rglob("*.py"):
            try:
                newest = max(newest, path.stat().st_mtime)
            except OSError:
                continue
    except OSError:
        return 0.0
    return newest


def _start_workflow_server(folder: str) -> dict:
    """Start (or reuse) the run server for a compiled package. Returns {url, pid, reused}.

    A live process is reused only when the package on disk has not been
    recompiled since it booted. Python imports the graph and every agent
    module once, at import time, so a server started before a recompile
    keeps serving the OLD graph forever -- every Run after an edit would
    silently execute the previous compile. Comparing the card's version
    string cannot catch this (it is 'id-Ymd' and does not change within a
    day), so the test is the only thing that actually moves: the newest
    *.py mtime under the package vs. the moment the process was spawned.

    The child's stdout/stderr are redirected to a temp file, never to a
    pipe. A generated api.py prints a trace line per node/tool call/gate
    plus uvicorn's own logging for the server's entire (possibly long)
    lifetime, and nothing here ever drains a PIPE fd after startup -- a
    child that fills the kernel pipe buffer (commonly ~64KB) with nobody
    reading it deadlocks on its next write(), permanently, with no error
    and no exit code. A file has no such limit, and it doubles as the
    source for the crash-diagnostic tail below.
    """
    pkg = _resolve_package_dir(folder)
    stale: subprocess.Popen | None = None
    with _SERVERS_LOCK:
        proc = _SERVERS.get(folder)
        if proc is not None and proc.poll() is None:
            if _newest_py_mtime(pkg) <= getattr(proc, "_workflow_started", 0.0):
                return {"url": proc._workflow_url, "pid": proc.pid, "reused": True}
            # Recompiled since boot: this process is serving dead modules.
            stale = _SERVERS.pop(folder, None)
        port = _free_port()
        url = f"http://127.0.0.1:{port}/"
        log_fd, log_name = tempfile.mkstemp(prefix=f"workflow-{folder}-", suffix=".log")
        log_path = Path(log_name)
        started = time.time()
        with os.fdopen(log_fd, "wb") as log_file:
            proc = subprocess.Popen(
                [sys.executable, "-u", str(pkg / "api.py"), "--port", str(port)],
                cwd=str(pkg), stdout=log_file, stderr=subprocess.STDOUT,
            )
        proc._workflow_url = url
        proc._workflow_log = log_path
        proc._workflow_started = started
        _SERVERS[folder] = proc

    # Outside the lock: terminating the superseded process can take up to
    # the 5 s grace period, and nothing else needs to wait on it.
    if stale is not None:
        try:
            _terminate_workflow_proc(stale)
        except Exception:
            logging.exception("Failed to stop the stale workflow server for %r", folder)

    # The readiness wait itself happens outside the lock -- it can take up
    # to 60s, and holding the lock that long would stall every other
    # start/stop call (any folder) for the duration.
    deadline = time.monotonic() + 60
    while True:
        if proc.poll() is not None:
            out = _read_log_tail(proc._workflow_log)
            with _SERVERS_LOCK:
                if _SERVERS.get(folder) is proc:
                    _SERVERS.pop(folder, None)
            proc._workflow_log.unlink(missing_ok=True)
            raise RuntimeError(f"{folder}/api.py exited with code {proc.returncode} before serving {url}:\n{out}")
        try:
            if httpx.get(url + ".well-known/workflow.json", timeout=2).status_code == 200:
                break
        except Exception:
            pass
        if time.monotonic() > deadline:
            _stop_workflow_server(folder)
            raise RuntimeError(f"{folder}/api.py did not serve its identity at {url} within 60s")
        time.sleep(0.2)
    return {"url": url, "pid": proc.pid, "reused": False}


def _terminate_workflow_proc(proc: subprocess.Popen) -> bool:
    """Terminate one workflow server process (5 s grace, then kill), reap it
    so it never lingers as a zombie, and remove its log file. Returns whether
    a running process was actually signalled.
    """
    log_path: Path | None = getattr(proc, "_workflow_log", None)
    if proc.poll() is not None:
        # Already exited on its own (e.g. crashed after startup) -- nothing
        # to signal, but still clean up its log file.
        if log_path is not None:
            log_path.unlink(missing_ok=True)
        return False
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()  # reap -- kill() alone leaves a zombie until collected
    if log_path is not None:
        log_path.unlink(missing_ok=True)
    return True


def _stop_workflow_server(folder: str) -> dict:
    """Stop the run server for a package and forget it."""
    with _SERVERS_LOCK:
        proc = _SERVERS.pop(folder, None)
    if proc is None:
        return {"stopped": False}
    return {"stopped": _terminate_workflow_proc(proc)}


def _stop_all_workflow_servers() -> None:
    """Shutdown hook: stop every workflow server this runner started, so
    killing the runner doesn't orphan them holding their ports. Idempotent
    -- _stop_workflow_server pops from _SERVERS as it goes, so calling this
    more than once finds nothing left to do on the second call.
    """
    for folder in list(_SERVERS.keys()):
        try:
            _stop_workflow_server(folder)
        except Exception:
            logging.exception("Failed to stop workflow server %r during shutdown", folder)


atexit.register(_stop_all_workflow_servers)


@app.get("/api/scripts")
async def list_scripts():
    """List .py files available under scripts/.

    Returned newest-first so the picker UI naturally surfaces the
    most-recently-generated workflow scripts at the top.
    """
    if not SCRIPTS_DIR.exists():
        return {"scripts": []}
    items = []
    for entry in SCRIPTS_DIR.iterdir():
        if not entry.is_file() or entry.suffix != ".py":
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        items.append({
            "name": entry.name,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
        })
    items.sort(key=lambda e: e["mtime"], reverse=True)
    return {"scripts": items}


@app.get("/api/outputs")
async def list_outputs():
    """List output files (markdown / json / plain text) under outputs/.

    Newest-first ordering, same shape as /api/scripts. The UI uses this
    to populate the "past results" picker.
    """
    if not OUTPUTS_DIR.exists():
        return {"outputs": []}
    items = []
    for entry in OUTPUTS_DIR.iterdir():
        if not entry.is_file() or entry.suffix.lower() not in OUTPUT_EXTENSIONS:
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        items.append({
            "name": entry.name,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "kind": entry.suffix.lower().lstrip("."),
        })
    items.sort(key=lambda e: e["mtime"], reverse=True)
    return {"outputs": items}


def _resolve_output_path(filename: str) -> Path:
    """Path-traversal-safe lookup of an output file. Mirrors
    _resolve_script_path but for outputs/.
    """
    if not filename or "/" in filename or "\\" in filename or filename.startswith("."):
        raise ValueError(f"Invalid output filename: {filename!r}")
    if Path(filename).suffix.lower() not in OUTPUT_EXTENSIONS:
        raise ValueError(f"Unsupported output extension: {filename!r}")
    candidate = (OUTPUTS_DIR / filename).resolve()
    outputs_root = OUTPUTS_DIR.resolve()
    if outputs_root not in candidate.parents and candidate != outputs_root:
        raise ValueError(f"Path escapes outputs directory: {filename!r}")
    if not candidate.exists():
        raise FileNotFoundError(f"Output not found: {candidate}")
    return candidate


@app.get("/api/output")
async def get_output(name: str):
    """Read one output file by name. Returns the raw content plus a
    `kind` hint the UI uses to pick a renderer (markdown / json / text).
    """
    try:
        path = _resolve_output_path(name)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "name": path.name,
        "kind": path.suffix.lower().lstrip("."),
        "content": path.read_text(encoding="utf-8"),
        "mtime": path.stat().st_mtime,
    }


@app.post("/api/run-file")
async def run_file(req: RunFileReq):
    """Execute a saved .py file from scripts/ as a subprocess and stream
    stdout/stderr back over SSE.

    Companion to the workflow editor's "Run Python" button (Stage C).
    Stateless — every call respawns python; no caching of the script's
    module state.
    """
    try:
        script_path = _resolve_script_path(req.filename)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    return StreamingResponse(
        _stream_script_run(script_path, req.args),
        media_type="text/event-stream",
    )


@app.post("/api/workflow-server/start")
async def workflow_server_start(req: dict):
    """Start the compiled workflow's run server and return its URL.

    _start_workflow_server does blocking work (spawning a subprocess, then
    up to 60s of synchronous httpx polling) -- run it in a thread so it
    doesn't stall the event loop, and with it every other in-flight
    request (e.g. someone else's /api/run-file SSE stream).
    """
    try:
        return await asyncio.to_thread(_start_workflow_server, str(req.get("folder") or ""))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/workflow-server/stop")
async def workflow_server_stop(req: dict):
    """Stop the compiled workflow's run server.

    _stop_workflow_server blocks for up to 5s waiting on the child --
    same reasoning as the start route above.
    """
    return await asyncio.to_thread(_stop_workflow_server, str(req.get("folder") or ""))


def _cli_run(filename: str, extra_args: list[str] | None = None) -> int:
    """CLI entry: execute a script from scripts/ and pipe its output to
    the caller's terminal. Returns the script's exit code so shells can
    chain on it. extra_args are forwarded verbatim to the script.
    """
    try:
        script_path = _resolve_script_path(filename)
    except (ValueError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    import subprocess
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        str(INSTALL_ROOT) + (os.pathsep + existing if existing else "")
    )
    proc = subprocess.run(
        [sys.executable, "-u", str(script_path), *(extra_args or [])],
        cwd=str(INSTALL_ROOT),
        env=env,
    )
    return proc.returncode


if __name__ == "__main__":
    # CLI dispatch — `python main.py run <file>` runs a saved script
    # without starting the server. Any other invocation (including just
    # `python main.py`) starts the FastAPI service as before.
    if len(sys.argv) >= 3 and sys.argv[1] == "run":
        sys.exit(_cli_run(sys.argv[2], sys.argv[3:]))

    import uvicorn

    # The reloader is OPT-IN (`--reload`), not the default, because this
    # process lives in an INSTALL, not a checkout: the editable source is
    # the repo's langchain_runner/, and setup.py copies it here. Watching
    # is therefore useless — and actively harmful. uvicorn's reloader
    # watches the working directory recursively, and `scripts/` sits
    # inside it: every compile the workflow editor writes there (a Run is
    # a write of a whole package) restarted this server mid-click. That
    # cost three things at once — the /health probe the editor fires right
    # after writing could land in the restart window and report the runner
    # down ("Start the local runner first" over a perfectly good runner),
    # an in-flight run died with its server, and every workflow server
    # already spawned was orphaned: the new process starts with an empty
    # _SERVERS, so nothing can stop them and they hold their ports until
    # killed by hand. Pass --reload only when editing main.py in place.
    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload="--reload" in sys.argv[1:])
