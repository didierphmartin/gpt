"""The interpreter's file-read step: recursive list_files -> read_file ->
decode -> text. The Python twin of the (compiler-side) ingestion_loader.py
(langchain_runner/ingestion_loader.py).

The loader's job (per the execution-model spec): ENUMERATE the source -- a
single file, or a folder walked RECURSIVELY through every nested subfolder --
and transform each file into plain TEXT for the next node (the splitter),
carrying the full path as provenance.

Files are reached through the UniversalFS/langfs MCP server, but the two MCP
tools are INJECTED as callables so this class is unit-testable with no live
server:

  listFiles(provider: str, path: str) -> dict   # {"files":[{id,name,type}]}
  readFile(provider: str, fileId: str) -> dict  # {"is_text": True, "data": str}

Ported from backend/src/AgentTeam/Services/IngestionLoader.php. NOTE: the
current PHP source has ALREADY dropped its local raw-bytes decode() path
(langfs now extracts text server-side) -- there is no `decode()` method to
port; `loadFile` throws when `readFile` doesn't return extracted text.
"""
from __future__ import annotations

import posixpath
from collections.abc import Callable, Generator

from app.support.phpcompat import mb_substr, php_empty, php_strval

_ASCII_UPPER_TO_LOWER = str.maketrans(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'
)


def _strtolower(s: str) -> str:
    """PHP strtolower(): byte-wise, ASCII A-Z only."""
    return s.translate(_ASCII_UPPER_TO_LOWER)


class IngestionLoader:
    """Extension -> document type. Drives both the type filter and decode."""
    _EXT_MAP = {
        'pdf': 'pdf',
        'docx': 'word',
        'doc': 'word',
        'txt': 'text',
        'csv': 'csv',
        'html': 'html',
        'htm': 'html',
    }

    @staticmethod
    def detectType(name: str) -> str | None:
        """Map a filename / path to a document type, or None if unsupported."""
        dot = name.rfind('.')
        if dot == -1:
            return None
        ext = _strtolower(name[dot + 1:])
        return IngestionLoader._EXT_MAP.get(ext)

    @staticmethod
    def enumerateFiles(
        listFiles: Callable[[str, str], dict],
        provider: str,
        path: str,
        allowedTypes: list[str] | None = None,
        isDir: bool = False,
        maxDepth: int = 64,
    ) -> list[dict]:
        """Enumerate the files the loader will process.

        The document type is always detected from the extension; `allowedTypes`
        is the loader form's CHECKBOX FILTER -- the set of formats the user
        ticked (e.g. ['pdf', 'word']). A file is kept only if its detected type
        is in that set. An EMPTY set means "no restriction" -- every supported
        type is kept.

        - Single file (isDir=False): one descriptor, or none if its type is
          unsupported or filtered out.
        - Folder (isDir=True): RECURSIVELY walk every nested subfolder (any
          depth) via the injected listFiles, keeping the files that pass the
          filter. Each descriptor's `source` is the full path. Symlink cycles
          are broken with a visited set; runaway depth is capped by maxDepth.
        """
        allowedTypes = allowedTypes if allowedTypes else []

        def resolve(name: str) -> str | None:
            dt = IngestionLoader.detectType(name)
            if dt is None:
                return None
            if allowedTypes and dt not in allowedTypes:
                return None
            return dt

        if not isDir:
            base = posixpath.basename(path)
            dt = resolve(base)
            if dt is None:
                return []
            return [IngestionLoader._descriptor(provider, path, base, dt)]

        out: list[dict] = []
        visited: dict[str, bool] = {}

        def walk(folder: str, depth: int) -> None:
            if depth > maxDepth or folder in visited:
                return
            visited[folder] = True
            result = listFiles(provider, folder)
            files = (result or {}).get('files') or []
            for item in files:
                itemId = item.get('id')
                name = item.get('name')
                if name is None:
                    name = posixpath.basename(itemId) if itemId is not None else ''
                if (item.get('type') or '') == 'folder':
                    if itemId is not None:
                        walk(itemId, depth + 1)
                else:
                    dt = resolve(name)
                    if dt is not None and itemId is not None:
                        out.append(IngestionLoader._descriptor(provider, itemId, name, dt))

        walk(path, 0)
        return out

    @staticmethod
    def _descriptor(provider: str, fileId: str, name: str, docType: str) -> dict:
        return {
            'provider': provider,
            'file_id': fileId,
            'name': name,
            'source': fileId,   # full path = provenance for the store metadata
            'doc_type': docType,
        }

    @staticmethod
    def loadFile(readFile: Callable[[str, str], dict], descriptor: dict) -> str:
        """Read one enumerated file via the injected readFile.

        langfs already extracts text server-side, returning {'is_text': True,
        'data': str} -- we pass it straight through. The legacy UniversalFS
        raw-bytes path (is_text=False + local decode) has been removed now
        that every storage server is a langfs/LangChain loader; a non-text
        response raises rather than being decoded here.
        """
        r = readFile(descriptor['provider'], descriptor['file_id'])
        if isinstance(r, dict) and not php_empty(r.get('is_text')):
            data = r.get('data')
            return php_strval(data) if data is not None else ''
        raise RuntimeError(
            f"read_file did not return extracted text for '{descriptor['name']}' — "
            "the legacy raw-bytes decode path was removed; use a langfs storage server (format=text)."
        )

    @staticmethod
    def loadDocuments(
        listFiles: Callable[[str, str], dict],
        readFile: Callable[[str, str], dict],
        provider: str,
        path: str,
        allowedTypes: list[str] | None = None,
        isDir: bool = False,
    ) -> Generator[dict, None, None]:
        """The loader's iterator: yield {'text': ..., 'source': ...} for each
        file, reading + decoding lazily so the store can clock the loop one
        file at a time."""
        for desc in IngestionLoader.enumerateFiles(listFiles, provider, path, allowedTypes, isDir):
            yield {'text': IngestionLoader.loadFile(readFile, desc), 'source': desc['source']}

    @staticmethod
    def readRound(
        listFiles: Callable[[str, str], dict],
        readFile: Callable[[str, str], dict],
        provider: str,
        path: str,
        allowedTypes: list[str] | None = None,
        isDir: bool = False,
        cursor: int = 0,
        maxChars: int = 20000,
    ) -> dict:
        """Run ONE round of the loader: enumerate the source (cheap list walk),
        then read + decode just the file at `cursor` -- the per-round semantics
        of the interpreter (the store clocks the loop, one file fully to the
        end before the next). The loader's Output tab shows this one file's
        text, refreshed each round; the full event loop drives the same
        `cursor` forward.

        Returns the ordered `sources` so the caller can show "file k of N" and
        step without re-deriving the list. `cursor` out of range -> no
        `current` (exhausted). A decode failure surfaces on `current.error`.
        """
        descs = IngestionLoader.enumerateFiles(listFiles, provider, path, allowedTypes, isDir)
        count = len(descs)
        sources = [d['source'] for d in descs]

        if count == 0 or cursor < 0 or cursor >= count:
            return {'count': count, 'cursor': cursor, 'sources': sources, 'current': None}

        desc = descs[cursor]
        try:
            text = IngestionLoader.loadFile(readFile, desc)
            chars = len(text)
            clipped = chars > maxChars
            current = {
                'source': desc['source'],
                'type': desc['doc_type'],
                'chars': chars,
                'text': mb_substr(text, 0, maxChars) if clipped else text,
                'clipped': clipped,
            }
        except Exception as e:
            current = {'source': desc['source'], 'type': desc['doc_type'], 'error': str(e)}

        return {'count': count, 'cursor': cursor, 'sources': sources, 'current': current}
