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
import json
import logging
import os
import sys

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

    Guards against path traversal: the resolved path must live under the
    scripts directory. Raises ValueError on a bad filename, FileNotFoundError
    if the file doesn't exist.
    """
    # Reject anything that looks like a path (slashes, drive letters, etc.).
    # Generated filenames are always plain like "workflow_42_my-skill.py".
    if not filename or "/" in filename or "\\" in filename or filename.startswith("."):
        raise ValueError(f"Invalid script filename: {filename!r}")
    if not filename.endswith(".py"):
        raise ValueError(f"Only .py files can be executed: {filename!r}")
    candidate = (SCRIPTS_DIR / filename).resolve()
    scripts_root = SCRIPTS_DIR.resolve()
    if scripts_root not in candidate.parents and candidate != scripts_root:
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

    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload=True)
