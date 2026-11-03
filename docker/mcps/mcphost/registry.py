"""servers.json: which server folders are hosted, on which port, enabled or not."""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

PORT_FIRST = 9101
PORT_LAST = 9199


class RegistryError(Exception):
    pass


class Registry:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.file = self.root / "servers.json"
        self._lock = threading.Lock()   # held across each load-modify-save

    def load(self) -> dict:
        """The registered servers; a corrupt file reads as none (logged) and stays as is until the next write."""
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (ValueError, OSError) as e:   # JSONDecodeError and UnicodeDecodeError are ValueErrors
            print(f"[supervisor] cannot read {self.file}: {e}", file=sys.stderr)
            return {}
        if not isinstance(data, dict):
            return {}
        return {k: v for k, v in data.items() if isinstance(v, dict)}

    def _save(self, data: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".servers.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, self.file)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise

    def get(self, folder: str) -> dict | None:
        return self.load().get(folder)

    def add(self, folder: str, name: str, installed_by) -> dict:
        with self._lock:
            data = self.load()
            if folder in data:
                raise RegistryError(f"folder already registered: {folder}")
            used = {s.get("port") for s in data.values()}
            port = next((p for p in range(PORT_FIRST, PORT_LAST + 1) if p not in used), None)
            if port is None:
                raise RegistryError("no free port")
            data[folder] = {"name": name, "port": port, "enabled": True, "installed_by": installed_by}
            self._save(data)
            return data[folder]

    def set_enabled(self, folder: str, enabled: bool) -> None:
        with self._lock:
            data = self.load()
            if folder not in data:
                raise RegistryError(f"unknown folder: {folder}")
            data[folder]["enabled"] = bool(enabled)
            self._save(data)

    def remove(self, folder: str) -> None:
        with self._lock:
            data = self.load()
            if data.pop(folder, None) is not None:
                self._save(data)
