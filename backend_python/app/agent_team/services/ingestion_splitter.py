"""Pure-Python recursive character text splitter — the interpreter's splitter node.

A faithful port of langchain's RecursiveCharacterTextSplitter algorithm (the
same one vendored to Python in langchain_runner/ingestion_splitter.py, which
is parity-tested against langchain). Output is intended to match
`RecursiveCharacterTextSplitter(chunk_size, chunk_overlap).split_text(text)`
with library defaults: keep_separator="start", is_separator_regex=False,
strip_whitespace=True, length_function=len (code points -> mb_strlen).

The two lowerings stay faithful: the compiler emits the Python splitter, the
interpreter runs this port -- same chunks either way.

Ported from backend/src/AgentTeam/Services/IngestionSplitter.php.
"""
from __future__ import annotations

import re

from app.support.phpcompat import php_trim


class IngestionSplitter:
    DEFAULT_SEPARATORS = ["\n\n", "\n", " ", ""]

    @staticmethod
    def recursiveSplit(text: str, chunkSize: int = 1000, overlap: int = 150) -> list[str]:
        """Split text into chunks. Mirrors recursive_split() in the Python vendor.

        Raises ValueError (PHP's \\InvalidArgumentException) when overlap > chunkSize.
        """
        if overlap > chunkSize:
            raise ValueError(
                f"Got a larger chunk overlap ({overlap}) than chunk size ({chunkSize}), should be smaller."
            )
        return IngestionSplitter._splitText(text, IngestionSplitter.DEFAULT_SEPARATORS, chunkSize, overlap)

    @staticmethod
    def _len(s: str) -> int:
        """Code-point length (matches Python len() on str, and PHP's mb_strlen)."""
        return len(s)

    @staticmethod
    def _splitWithRegex(text: str, sepEscaped: str) -> list[str]:
        """Mirrors _split_text_with_regex with keep_separator truthy ("start"):
        each separator is attached to the piece that FOLLOWS it. `sepEscaped` is
        an already-quoted regex (or '' for character split)."""
        if sepEscaped != '':
            parts = re.split('(' + sepEscaped + ')', text)
            n = len(parts)
            splits: list[str] = []
            i = 1
            while i < n:
                nxt = parts[i + 1] if i + 1 < n else ''
                splits.append(parts[i] + nxt)
                i += 2
            if n % 2 == 0:
                splits.append(parts[n - 1])
            splits.insert(0, parts[0])
        else:
            splits = list(text)
        return [s for s in splits if s != '']

    @staticmethod
    def _joinDocs(docs: list[str], separator: str) -> str | None:
        """Mirrors _join_docs (separator-join + PHP trim; '' -> None)."""
        text = php_trim(separator.join(docs))
        return text if text != '' else None

    @staticmethod
    def _mergeSplits(splits: list[str], separator: str, chunkSize: int, chunkOverlap: int) -> list[str]:
        """Mirrors TextSplitter._merge_splits (length_function = len). With the
        default keep_separator the merge separator is '' (separator_len 0)."""
        separatorLen = IngestionSplitter._len(separator)
        docs: list[str] = []
        currentDoc: list[str] = []
        total = 0

        for d in splits:
            lenD = IngestionSplitter._len(d)
            if total + lenD + (separatorLen if len(currentDoc) > 0 else 0) > chunkSize:
                if len(currentDoc) > 0:
                    doc = IngestionSplitter._joinDocs(currentDoc, separator)
                    if doc is not None:
                        docs.append(doc)
                    while (
                        total > chunkOverlap
                        or (
                            total + lenD + (separatorLen if len(currentDoc) > 0 else 0) > chunkSize
                            and total > 0
                        )
                    ):
                        total -= IngestionSplitter._len(currentDoc[0]) + (
                            separatorLen if len(currentDoc) > 1 else 0
                        )
                        currentDoc.pop(0)
            currentDoc.append(d)
            total += lenD + (separatorLen if len(currentDoc) > 1 else 0)

        doc = IngestionSplitter._joinDocs(currentDoc, separator)
        if doc is not None:
            docs.append(doc)
        return docs

    @staticmethod
    def _splitText(text: str, separators: list[str], chunkSize: int, chunkOverlap: int) -> list[str]:
        """Mirrors RecursiveCharacterTextSplitter._split_text (is_separator_regex=False)."""
        finalChunks: list[str] = []

        # Choose the separator: the last, unless an earlier one occurs in text.
        separator = separators[-1]
        newSeparators: list[str] = []
        for i, s in enumerate(separators):
            sEscaped = re.escape(s)
            if s == '':
                separator = s
                break
            if re.search(sEscaped, text) is not None:
                separator = s
                newSeparators = separators[i + 1:]
                break

        sepEscaped = re.escape(separator)
        splits = IngestionSplitter._splitWithRegex(text, sepEscaped)

        # Merge short pieces; recurse into pieces still longer than chunk_size.
        goodSplits: list[str] = []
        mergeSeparator = ''  # keep_separator => merge with ''
        for s in splits:
            if IngestionSplitter._len(s) < chunkSize:
                goodSplits.append(s)
            else:
                if goodSplits:
                    merged = IngestionSplitter._mergeSplits(goodSplits, mergeSeparator, chunkSize, chunkOverlap)
                    finalChunks.extend(merged)
                    goodSplits = []
                if not newSeparators:
                    finalChunks.append(s)
                else:
                    other = IngestionSplitter._splitText(s, newSeparators, chunkSize, chunkOverlap)
                    finalChunks.extend(other)
        if goodSplits:
            merged = IngestionSplitter._mergeSplits(goodSplits, mergeSeparator, chunkSize, chunkOverlap)
            finalChunks.extend(merged)
        return finalChunks
