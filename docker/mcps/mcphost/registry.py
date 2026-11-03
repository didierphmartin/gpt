"""servers.json: which server folders are hosted, on which port, enabled or not."""
import json
import os
import tempfile
from pathlib import Path

PORT_FIRST = 9101
PORT_LAST = 9199


class RegistryError(Exception):
    pass


class Registry:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.file = self.root / "servers.json"

    def load(self) -> dict:
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        return data if isinstance(data, dict) else {}

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
        data = self.load()
        if folder not in data:
            raise RegistryError(f"unknown folder: {folder}")
        data[folder]["enabled"] = bool(enabled)
        self._save(data)

    def remove(self, folder: str) -> None:
        data = self.load()
        if data.pop(folder, None) is not None:
            self._save(data)
