"""Control API: the JSON-over-HTTP surface the backend relays to (install, settings, source, lifecycle)."""
import base64
import binascii
import hmac
import json
import os
import re
import shutil
import subprocess
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from . import envfile
from .paths import is_safe_rel_path, is_safe_segment
from .procs import LOG_NAME

MAX_BODY = 50 * 1024 * 1024
INSTALL_TIMEOUT = 900
LOG_LINES = 50
FOLDER_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
MANIFEST = "synergyai-mcp.json"

# copied from workflow-package.js (DEFAULT_EXCLUDES)
DEFAULT_EXCLUDES = ['.venv/', 'venv/', 'node_modules/', 'vendor/', '__pycache__/', 'dist/', 'build/', '.git/', 'log/', 'logs/', 'tests/', 'docs/', '.env', '*.sqlite*', '*.log',
                    '*.pem', '*.key', '*.p12', '*.pfx', 'credentials*.json', 'token*.json', '*secret*']
# never shipped whatever the manifest says
ALWAYS_EXCLUDES = ['.env', '.venv/', 'data/', 'server.log*']


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.extra = status, extra


def _glob_re(g: str):
    return re.compile("^" + ".*".join(re.escape(p) for p in g.split("*")) + "$")


def _matches(path: str, pattern: str) -> bool:
    """"dir/" = that directory name at any depth; no "/" = basename at any depth; inner "/" = whole path."""
    segs = path.split("/")
    if pattern.endswith("/"):
        return pattern[:-1] in segs[:-1]
    if "/" in pattern:
        return bool(_glob_re(pattern).match(path))
    return bool(_glob_re(pattern).match(segs[-1]))


def select_server_files(paths: list, manifest: dict | None) -> list:
    """Twin of selectServerFiles: include (if any), then exclude + defaults."""
    manifest = manifest if isinstance(manifest, dict) else {}
    inc = manifest.get("include")
    include = inc if isinstance(inc, list) and inc else None
    exc = manifest.get("exclude")
    exclude = DEFAULT_EXCLUDES + ALWAYS_EXCLUDES + (exc if isinstance(exc, list) else [])
    out = []
    for p in paths:
        segs = p.split("/")
        if any(s.startswith(".") for s in segs[:-1]):
            continue
        if segs[-1].startswith(".") and segs[-1] != ".env.example":
            continue
        if any(_matches(p, x) for x in exclude):
            continue
        if include is None or any(_matches(p, x) for x in include):
            out.append(p)
    return out


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return ""


def _manifest(d: Path) -> dict:
    try:
        m = json.loads(_read(d / MANIFEST) or "{}")
    except ValueError:
        return {}
    return m if isinstance(m, dict) else {}


class Control:
    def __init__(self, root, registry, manager):
        self.root, self.registry, self.manager = Path(root), registry, manager
        self._lock = threading.Lock()
        self._installing = {}   # folder -> display name while its install runs

    # ---- helpers ----
    def _folder(self, folder: str) -> Path:
        if not FOLDER_RE.match(folder) or not is_safe_segment(folder):
            raise ApiError(400, "unsafe folder name")
        return self.root / folder

    def _known(self, folder: str) -> Path:
        d = self._folder(folder)
        if self.registry.get(folder) is None:
            raise ApiError(404, "unknown server")
        return d

    def _state(self, folder: str) -> str:
        with self._lock:
            if folder in self._installing:
                return "installing"
        return self.manager.state(folder)

    # ---- routes ----
    def list_servers(self) -> list:
        out = []
        for folder, e in self.registry.load().items():
            out.append({"folder": folder, "name": e.get("name"), "port": e.get("port"), "enabled": e.get("enabled", True),
                        "installed_by": e.get("installed_by"), "state": self._state(folder),
                        "log": self.manager.log_tail(folder, LOG_LINES)})
        with self._lock:
            building = dict(self._installing)
        for folder, name in building.items():
            if folder not in {s["folder"] for s in out}:
                out.append({"folder": folder, "name": name, "port": None, "enabled": True, "installed_by": None,
                            "state": "installing", "log": self.manager.log_tail(folder, LOG_LINES)})
        return out

    def install(self, folder: str, body: dict):
        d = self._folder(folder)
        files, env = body.get("files"), body.get("env", {})
        if not isinstance(files, dict) or not isinstance(env, dict):
            raise ApiError(400, "files and env must be objects")
        decoded = {}
        for rel, b64 in files.items():
            if not is_safe_rel_path(rel):
                raise ApiError(400, f"unsafe path: {rel}")
            try:
                decoded[rel] = base64.b64decode(b64, validate=True)
            except (binascii.Error, TypeError, ValueError):
                raise ApiError(400, f"bad content for {rel}")
        try:
            env_text = envfile.merge("", env)
        except ValueError as e:
            raise ApiError(400, str(e))
        with self._lock:
            if folder in self._installing or d.exists() or self.registry.get(folder) is not None:
                raise ApiError(409, "folder already exists")
            d.mkdir(parents=True)   # claims the folder; a racing install now sees it
            self._installing[folder] = str(body.get("name") or folder)
        try:
            return self._do_install(folder, d, body, decoded, env_text)
        finally:
            with self._lock:
                self._installing.pop(folder, None)

    def _do_install(self, folder, d, body, decoded, env_text):
        try:
            for rel, data in decoded.items():
                p = d / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                if rel.endswith(".sh"):
                    p.chmod(0o755)   # a browser upload carries no mode bits, and start is usually ./run.sh
            (d / ".env").write_text(env_text, encoding="utf-8")
            manifest = _manifest(d)
            cmd = manifest.get("install")
            if isinstance(cmd, str) and cmd.strip():
                if not self._run_install(d, cmd):
                    log = self.manager.log_tail(folder, LOG_LINES)
                    shutil.rmtree(d, ignore_errors=True)
                    raise ApiError(422, "install-failed", log=log)
            name = body.get("name") or manifest.get("name") or folder
            entry = self.registry.add(folder, name, body.get("installed_by"))
        except ApiError:
            raise
        except BaseException:
            shutil.rmtree(d, ignore_errors=True)
            raise
        self.manager.start(folder)
        return 201, {"folder": folder, "port": entry["port"], "state": self.manager.state(folder)}

    def _run_install(self, d: Path, cmd: str) -> bool:
        env = dict(os.environ)
        env.update(envfile.parse(_read(d / ".env")))
        with open(d / LOG_NAME, "ab") as log:
            proc = subprocess.Popen(["bash", "-c", cmd], cwd=d, env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                return proc.wait(INSTALL_TIMEOUT) == 0
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, 9)
                except (ProcessLookupError, PermissionError):
                    pass
                proc.wait()
                log.write(b"[supervisor] install timed out\n")
                return False

    def restart(self, folder: str):
        self._known(folder)
        if not self.registry.get(folder).get("enabled", True):
            raise ApiError(409, "disabled")
        self.manager.restart(folder)
        return 200, {"state": self.manager.state(folder)}

    def set_enabled(self, folder: str, body: dict):
        self._known(folder)
        if not isinstance(body.get("enabled"), bool):
            raise ApiError(400, "enabled must be true or false")
        self.registry.set_enabled(folder, body["enabled"])
        if body["enabled"]:
            self.manager.start(folder)
        else:
            self.manager.stop(folder)
        return 200, {"enabled": body["enabled"], "state": self.manager.state(folder)}

    def _fields(self, d: Path) -> list:
        return envfile.fields(_manifest(d), _read(d / ".env.example"))

    def get_settings(self, folder: str):
        d = self._known(folder)
        current = envfile.parse(_read(d / ".env"))
        out = []
        for f in self._fields(d):
            item = dict(f, filled=bool(current.get(f["name"])))
            if not f["secret"]:
                item["value"] = current.get(f["name"], "")
            out.append(item)
        return 200, {"fields": out}

    def put_settings(self, folder: str, body: dict):
        d = self._known(folder)
        values = body.get("values")
        if not isinstance(values, dict):
            raise ApiError(400, "values must be an object")
        fields = self._fields(d)
        secret = {f["name"] for f in fields if f["secret"]}
        declared = {f["name"] for f in fields}
        undeclared_secret = {k for k in values if k not in declared and envfile.SECRET_FIELD_RE.search(k)}
        blank_keeps = secret | undeclared_secret   # a blank value leaves these unchanged
        keep = {k: v for k, v in values.items() if not (v == "" and k in blank_keeps)}
        try:
            text = envfile.merge(_read(d / ".env"), keep)
        except ValueError as e:
            raise ApiError(400, str(e))
        (d / ".env").write_text(text, encoding="utf-8")
        if self.registry.get(folder).get("enabled", True):
            self.manager.restart(folder)
        current = envfile.parse(text)
        return 200, {"missing": [f["name"] for f in fields if f["required"] and not current.get(f["name"])]}

    def source(self, folder: str):
        d = self._known(folder)
        paths = []
        for dirpath, dirnames, filenames in os.walk(d):
            rel_dir = Path(dirpath).relative_to(d)
            dirnames[:] = [n for n in dirnames if not (Path(dirpath, n).is_symlink() or n in (".venv", "data", ".git"))]
            for n in filenames:
                if Path(dirpath, n).is_file() and not Path(dirpath, n).is_symlink():
                    paths.append((rel_dir / n).as_posix())
        keep = select_server_files(paths, _manifest(d))
        return 200, {"files": {p: base64.b64encode((d / p).read_bytes()).decode("ascii") for p in sorted(keep)}}

    def delete(self, folder: str):
        d = self._known(folder)
        self.manager.stop(folder)
        try:
            shutil.rmtree(d)
        except OSError as e:
            raise ApiError(500, f"cannot remove the folder: {e}")
        self.registry.remove(folder)
        return 200, {"deleted": folder}


def make_server(root, registry, manager, token, port=9000, host="127.0.0.1") -> ThreadingHTTPServer:
    ctl = Control(root, registry, manager)
    want = ("Bearer " + token).encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):   # no request logging: bodies and paths stay out of the logs
            pass

        def _send(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise ApiError(400, "bad Content-Length")
            if n > MAX_BODY:
                self.close_connection = True
                raise ApiError(413, "body too large")
            if n == 0:
                return {}
            try:
                body = json.loads(self.rfile.read(n))
            except ValueError:
                raise ApiError(400, "body is not JSON")
            if not isinstance(body, dict):
                raise ApiError(400, "body must be an object")
            return body

        def _route(self, method):
            try:
                got = (self.headers.get("Authorization") or "").encode()
                if not hmac.compare_digest(got, want):
                    self.close_connection = True
                    raise ApiError(401, "unauthorized")
                parts = [p for p in urlsplit(self.path).path.split("/") if p]
                if parts == ["servers"] and method == "GET":
                    return self._send(200, ctl.list_servers())
                if len(parts) >= 2 and parts[0] == "servers":
                    folder, sub = parts[1], parts[2:]
                    if not sub and method == "DELETE":
                        return self._send(*ctl.delete(folder))
                    if len(sub) == 1:
                        a = (method, sub[0])
                        if a == ("POST", "install"):
                            return self._send(*ctl.install(folder, self._body()))
                        if a == ("POST", "restart"):
                            return self._send(*ctl.restart(folder))
                        if a == ("POST", "enabled"):
                            return self._send(*ctl.set_enabled(folder, self._body()))
                        if a == ("GET", "settings"):
                            return self._send(*ctl.get_settings(folder))
                        if a == ("PUT", "settings"):
                            return self._send(*ctl.put_settings(folder, self._body()))
                        if a == ("GET", "source"):
                            return self._send(*ctl.source(folder))
                raise ApiError(404, "not found")
            except ApiError as e:
                self.close_connection = True   # the request body may be unread
                self._send(e.status, {"error": str(e), **e.extra})
            except Exception:
                traceback.print_exc()   # stderr; never the request body
                self._send(500, {"error": "internal error"})

        def do_GET(self): self._route("GET")
        def do_POST(self): self._route("POST")
        def do_PUT(self): self._route("PUT")
        def do_DELETE(self): self._route("DELETE")

    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv
