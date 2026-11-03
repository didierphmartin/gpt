"""Runs each hosted server as a child process: env assembly, log capture, back-off restarts."""
import json
import os
import signal
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

from . import envfile

BACKOFF_START = 1
BACKOFF_MAX = 300   # cap kept per spec, though MAX_FAILURES gives up after delays of 1+2+4+8 s
BACKOFF_RESET_AFTER = 600
MAX_FAILURES = 5
STOP_GRACE = 10
LOG_MAX = 5 * 1024 * 1024
LOG_NAME = "server.log"
HOST = "127.0.0.1"


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return ""


class _Log:
    """server.log with one rotated generation (server.log.1); written by one pump thread per child."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def write(self, text: str) -> None:
        data = text.encode("utf-8", "replace")
        with self._lock:
            try:
                size = self.path.stat().st_size
            except FileNotFoundError:
                size = 0
            if size and size + len(data) > LOG_MAX:
                os.replace(self.path, self.path.with_name(self.path.name + ".1"))
            with open(self.path, "ab") as f:
                f.write(data)


class Manager:
    def __init__(self, root: Path, registry, clock=time.monotonic):
        self.root = Path(root)
        self.registry = registry
        self.clock = clock
        self._lock = threading.RLock()
        self._procs = {}        # folder -> Popen (last one started)
        self._started = {}      # folder -> clock() at start
        self._failures = {}     # folder -> consecutive failed runs
        self._next_start = {}   # folder -> clock() time of the scheduled restart
        self._wanted = set()    # folders that should be running (started, not stopped, not crashed)
        self._crashed = set()
        self._pumps = {}
        self._guards = {}       # folder -> lock serialising its start/stop

    # ---- public ----
    def start(self, folder: str) -> None:
        with self._guard(folder), self._lock:
            if self._alive(folder):
                return
            self._failures[folder] = 0
            self._crashed.discard(folder)
            self._next_start.pop(folder, None)
            self._wanted.add(folder)
            self._spawn(folder)

    def stop(self, folder: str) -> None:
        # the global lock covers bookkeeping only; signalling and waiting happen outside it
        with self._guard(folder):
            with self._lock:
                victim = self._detach(folder)
            self._kill([victim])

    def restart(self, folder: str) -> None:
        self.stop(folder)
        self.start(folder)

    def state(self, folder: str) -> str:
        with self._lock:
            if folder in self._crashed:
                return "crashed"
            if self._alive(folder):
                return "running"
            return "starting" if folder in self._wanted else "stopped"

    def next_start(self, folder: str):
        with self._lock:
            return self._next_start.get(folder)

    def log_tail(self, folder: str, n: int = 50) -> list:
        try:
            with open(self.root / folder / LOG_NAME, encoding="utf-8", errors="replace") as f:
                return [l.rstrip("\n") for l in deque(f, maxlen=n)]
        except FileNotFoundError:
            return []

    def start_all(self) -> None:
        for folder, entry in self.registry.load().items():
            if entry.get("enabled", True):
                self.start(folder)

    def tick(self) -> None:
        """One supervision pass: reap exited children, schedule or perform back-off restarts."""
        with self._lock:
            now = self.clock()
            for folder in list(self._wanted):
                proc = self._procs.get(folder)
                if proc is not None and proc.poll() is not None and folder not in self._next_start:
                    self._on_exit(folder, now)
                due = self._next_start.get(folder)
                if due is not None and now >= due:
                    del self._next_start[folder]
                    self._spawn(folder)

    def stop_all(self) -> None:
        with self._lock:
            victims = [self._detach(f) for f in list(self._procs)]
        self._kill(victims)

    # ---- internals ----
    def _alive(self, folder: str) -> bool:
        proc = self._procs.get(folder)
        return proc is not None and proc.poll() is None

    def _on_exit(self, folder: str, now: float) -> None:
        if now - self._started.get(folder, now) >= BACKOFF_RESET_AFTER:
            self._failures[folder] = 0
        n = self._failures[folder] = self._failures.get(folder, 0) + 1
        if n >= MAX_FAILURES:
            self._wanted.discard(folder)
            self._crashed.add(folder)
            return
        self._next_start[folder] = now + min(BACKOFF_START * 2 ** (n - 1), BACKOFF_MAX)

    def _env(self, folder: str, manifest: dict) -> dict:
        d = self.root / folder
        example = _read(d / ".env.example")
        flds = [f["name"] for f in envfile.fields(manifest, example)]
        from_env = envfile.parse(_read(d / ".env"))
        env = dict(os.environ)
        env.update(from_env)
        host = manifest.get("host_env") or next((n for n in flds if n.endswith("_HOST")), None)
        port = manifest.get("port_env") or next((n for n in flds if n.endswith("_PORT")), None)
        if host:
            env[host] = HOST
        if port:
            env[port] = str(self.registry.get(folder)["port"])
        data = manifest.get("data_env")
        if not isinstance(data, list):
            names = flds + [f["name"] for f in envfile.fields(None, example)]
            data = [n for n in dict.fromkeys(names) if n.endswith("_DB_PATH")]
        for name in data:
            if not from_env.get(name):
                env[name] = str(d / "data" / (name.lower() + ".sqlite"))
        return env

    def _spawn(self, folder: str) -> None:
        d = self.root / folder
        log = _Log(d / LOG_NAME)
        try:
            manifest = json.loads(_read(d / "synergyai-mcp.json") or "{}")
            start = manifest.get("start") if isinstance(manifest, dict) else None
            if not start or not isinstance(start, str):
                raise ValueError("the server's manifest has no start command")
            if self.registry.get(folder) is None:
                raise ValueError("server is not registered")
            env = self._env(folder, manifest)
            (d / "data").mkdir(exist_ok=True)
            proc = subprocess.Popen(["bash", "-c", start], cwd=d, env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    start_new_session=True)
        except (ValueError, OSError) as e:
            log.write(f"[supervisor] cannot start: {e}\n")
            self._wanted.discard(folder)
            self._crashed.add(folder)
            return
        self._procs[folder] = proc
        self._started[folder] = self.clock()
        t = threading.Thread(target=self._pump, args=(proc, log), daemon=True)
        t.start()
        self._pumps[folder] = t

    @staticmethod
    def _pump(proc, log: _Log) -> None:
        for line in iter(proc.stdout.readline, b""):
            log.write(line.decode("utf-8", "replace"))
        proc.stdout.close()

    def _guard(self, folder: str):
        """Per-folder lock so a start never races a stop of the same server."""
        with self._lock:
            return self._guards.setdefault(folder, threading.Lock())

    def _detach(self, folder: str):
        """Forget the folder's process (caller holds the lock); returns (proc, pump) to kill outside it."""
        self._wanted.discard(folder)
        self._crashed.discard(folder)
        self._next_start.pop(folder, None)
        return self._procs.pop(folder, None), self._pumps.pop(folder, None)

    @classmethod
    def _kill(cls, victims: list) -> None:
        """SIGTERM every group first, then wait out the grace period once, SIGKILL stragglers, join pumps."""
        live = [p for p, _ in victims if p is not None and p.poll() is None]
        for p in live:
            cls._signal(p, signal.SIGTERM)
        deadline = time.monotonic() + STOP_GRACE
        for p in live:
            try:
                p.wait(max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                cls._signal(p, signal.SIGKILL)
                p.wait()
        for _, t in victims:
            if t is not None:
                t.join(2)

    @staticmethod
    def _signal(proc, sig) -> None:
        # only for a child not yet reaped: after reaping its pid (= group id) may belong to someone else
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
