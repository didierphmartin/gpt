"""Entry point: process manager + control API + gateway for the MCP servers under /mcps."""
import os
import signal
import sys
import threading
import time
from pathlib import Path

from mcphost import control, envfile, gateway
from mcphost.procs import Manager
from mcphost.registry import Registry

ROOT = Path(os.environ.get("MCPS_ROOT", "/mcps"))
SECRETS = "/run/gpt/secrets.env"
TOKEN_WAIT = 120
CONTROL_PORT = 9000
GATEWAY_PORT = 8790
TICK = 0.5


def read_token(secrets=SECRETS, wait=TOKEN_WAIT) -> str:
    """MCPS_TOKEN from the environment, else from the shared secrets file (which may appear after start)."""
    token = os.environ.get("MCPS_TOKEN")
    if token:
        return token
    deadline = time.monotonic() + wait
    while True:
        try:
            token = envfile.parse(Path(secrets).read_text(encoding="utf-8")).get("MCPS_TOKEN")
        except OSError:
            token = None
        if token:
            return token
        if time.monotonic() >= deadline:
            sys.exit("MCPS_TOKEN is not set and was not found in " + str(secrets))
        time.sleep(1)


class App:
    def __init__(self, manager, control_srv, gateway_srv, tick=TICK):
        self.manager, self.control, self.gateway, self.tick = manager, control_srv, gateway_srv, tick
        self._stopping = threading.Event()
        self.control_thread = threading.Thread(target=control_srv.serve_forever, daemon=True)
        self.gateway_thread = threading.Thread(target=gateway_srv.serve_forever, daemon=True)
        self.tick_thread = threading.Thread(target=self._tick_loop, daemon=True)

    def _tick_loop(self):
        while not self._stopping.wait(self.tick):
            try:
                self.manager.tick()
            except Exception:
                import traceback
                traceback.print_exc()

    def start(self):
        self.manager.start_all()
        for t in (self.control_thread, self.gateway_thread, self.tick_thread):
            t.start()

    def stop(self):
        self._stopping.set()
        for srv in (self.control, self.gateway):
            srv.shutdown()
            srv.server_close()
        self.tick_thread.join()
        self.manager.stop_all()
        self.control_thread.join()
        self.gateway_thread.join()


def build(root, token, control_port=CONTROL_PORT, gateway_port=GATEWAY_PORT, tick=TICK) -> App:
    root = Path(root)
    registry = Registry(root)   # one instance: its lock guards every read-modify-write
    manager = Manager(root, registry)
    return App(manager,
               control.make_server(root, registry, manager, token, port=control_port, host="0.0.0.0"),
               gateway.make_server(registry, port=gateway_port, host="0.0.0.0"), tick)


def main():
    root = ROOT
    root.mkdir(parents=True, exist_ok=True)
    app = build(root, read_token())
    done = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: done.set())
    app.start()
    done.wait()
    app.stop()


if __name__ == "__main__":
    main()
