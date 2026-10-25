"""Port of backend/src/AgentTeam/Services/StartDocumentStore.php.

Reads a Start document for the modular package, only from the requesting user's own document storage
(where WorkflowController.uploadNodeDocument writes it): <ROOT_FOLDER>/<user folder>/<doc path>, through
the user's universalFS adapter, else under a local storage root with realpath containment.

The Start config is saved by the client, so its `path` is untrusted: an absolute path, a `..` segment, a
backslash or a document kept on the user's machine (storage "local") is never read. `fullPath` is ignored.
"""
from __future__ import annotations

import os
from typing import Callable


class StartDocumentStore:
    ROOT_FOLDER = 'synergyaichatroot'

    def __init__(self, userFolder: str, adapterFactory: Callable[[], object | None] | None = None,
                 localRoot: str | None = None):
        """userFolder: users.storage_folder, else "user_<id>"; adapterFactory connects the user's universalFS
        adapter (may return None), called once on first read; localRoot: the local storage root."""
        self.userFolder = userFolder
        self.adapterFactory = adapterFactory
        self.localRoot = localRoot
        self._adapter = None
        self._connected = False

    @staticmethod
    def safeSegments(path: str) -> list | None:
        """path split into safe segments (no empty, ".", ".." segment, no "\\", no NUL, not absolute), else None."""
        if path == '' or path.startswith('/') or '\\' in path or '\0' in path:
            return None
        parts = path.split('/')
        for p in parts:
            if p in ('', '.', '..'):
                return None
        return parts

    def read(self, doc: dict) -> bytes | None:
        """The document's bytes, or None when it is not in this user's storage (or cannot be read)."""
        if (doc.get('storage') if doc.get('storage') is not None else 'remote') == 'local':
            return None   # kept on the user's machine: the server never had it
        path = doc.get('path')
        rel = self.safeSegments('' if path is None else str(path))
        folder = self.safeSegments(self.userFolder)
        if rel is None or folder is None:
            return None
        full = self.ROOT_FOLDER + '/' + '/'.join(folder) + '/' + '/'.join(rel)
        adapter = self._adapterOnce()
        if adapter is not None:
            try:
                data = adapter.read('/' + full)
                if isinstance(data, (bytes, str)):
                    return data if isinstance(data, bytes) else data.encode('utf-8')
            except Exception:  # noqa: BLE001 -- fall through to the local root, as the runner does
                pass
        if self.localRoot is None:
            return None
        baseCand = self.localRoot + '/' + self.ROOT_FOLDER + '/' + '/'.join(folder)
        targetCand = self.localRoot + '/' + full
        if not os.path.exists(baseCand) or not os.path.exists(targetCand):
            return None
        base = os.path.realpath(baseCand)
        target = os.path.realpath(targetCand)
        if not target.startswith(base + os.sep) or not os.path.isfile(target):
            return None
        try:
            with open(target, 'rb') as f:
                return f.read()
        except OSError:
            return None

    def _adapterOnce(self):
        if not self._connected:
            self._connected = True
            try:
                self._adapter = self.adapterFactory() if self.adapterFactory is not None else None
            except Exception:  # noqa: BLE001
                self._adapter = None
        return self._adapter
