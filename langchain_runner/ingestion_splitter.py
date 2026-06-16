"""Pure-Python recursive character text splitter.

Vendored from `langchain-text-splitters` (MIT License) -- the split ALGORITHM
ONLY, transcribed so it runs with no langchain / langchain_core /
langchain_text_splitters runtime dependency. This lets the same splitting logic
run under Pyodide (browser Python), where langchain cannot load.

Output is intended to match
``RecursiveCharacterTextSplitter(chunk_size, chunk_overlap).split_text(text)``
exactly, with the library defaults: ``keep_separator=True``,
``is_separator_regex=False``, ``strip_whitespace=True``, ``length_function=len``.

Reference: langchain_text_splitters/character.py (RecursiveCharacterTextSplitter)
and langchain_text_splitters/base.py (TextSplitter._merge_splits / _join_docs).
"""

from __future__ import annotations

import re
from typing import List, Optional

DEFAULT_SEPARATORS = ["\n\n", "\n", " ", ""]


def _split_text_with_regex(text: str, separator: str, keep_separator: bool) -> List[str]:
    # Mirrors langchain's _split_text_with_regex with keep_separator truthy
    # (which RecursiveCharacterTextSplitter uses by default == "start").
    if separator:
        if keep_separator:
            # Parentheses keep the delimiters in the result; the "start"
            # behavior attaches each separator to the piece that follows it.
            splits_ = re.split(f"({separator})", text)
            splits = [splits_[i] + splits_[i + 1] for i in range(1, len(splits_), 2)]
            if len(splits_) % 2 == 0:
                splits += splits_[-1:]
            splits = [splits_[0], *splits]
        else:
            splits = re.split(separator, text)
    else:
        splits = list(text)
    return [s for s in splits if s]


def _join_docs(docs: List[str], separator: str, strip_whitespace: bool) -> Optional[str]:
    text = separator.join(docs)
    if strip_whitespace:
        text = text.strip()
    if text == "":
        return None
    return text


def _merge_splits(
    splits,
    separator: str,
    chunk_size: int,
    chunk_overlap: int,
    strip_whitespace: bool = True,
) -> List[str]:
    # Mirrors TextSplitter._merge_splits (length_function == len).
    separator_len = len(separator)

    docs: List[str] = []
    current_doc: List[str] = []
    total = 0
    for d in splits:
        len_ = len(d)
        if total + len_ + (separator_len if len(current_doc) > 0 else 0) > chunk_size:
            # (langchain logs a warning here when total > chunk_size; omitted.)
            if len(current_doc) > 0:
                doc = _join_docs(current_doc, separator, strip_whitespace)
                if doc is not None:
                    docs.append(doc)
                # Pop while we still exceed the overlap, or still don't fit.
                while total > chunk_overlap or (
                    total + len_ + (separator_len if len(current_doc) > 0 else 0)
                    > chunk_size
                    and total > 0
                ):
                    total -= len(current_doc[0]) + (
                        separator_len if len(current_doc) > 1 else 0
                    )
                    current_doc = current_doc[1:]
        current_doc.append(d)
        total += len_ + (separator_len if len(current_doc) > 1 else 0)
    doc = _join_docs(current_doc, separator, strip_whitespace)
    if doc is not None:
        docs.append(doc)
    return docs


def _split_text(
    text: str,
    separators: List[str],
    chunk_size: int,
    chunk_overlap: int,
    keep_separator: bool = True,
    strip_whitespace: bool = True,
) -> List[str]:
    # Mirrors RecursiveCharacterTextSplitter._split_text (is_separator_regex=False).
    final_chunks: List[str] = []
    # Get appropriate separator to use.
    separator = separators[-1]
    new_separators: List[str] = []
    for i, s_ in enumerate(separators):
        separator_ = re.escape(s_)
        if s_ == "":
            separator = s_
            break
        if re.search(separator_, text):
            separator = s_
            new_separators = separators[i + 1:]
            break

    separator_ = re.escape(separator)
    splits = _split_text_with_regex(text, separator_, keep_separator)

    # Now go merging things, recursively splitting longer texts.
    good_splits: List[str] = []
    merge_separator = "" if keep_separator else separator
    for s in splits:
        if len(s) < chunk_size:
            good_splits.append(s)
        else:
            if good_splits:
                merged_text = _merge_splits(
                    good_splits, merge_separator, chunk_size, chunk_overlap,
                    strip_whitespace,
                )
                final_chunks.extend(merged_text)
                good_splits = []
            if not new_separators:
                final_chunks.append(s)
            else:
                other_info = _split_text(
                    s, new_separators, chunk_size, chunk_overlap,
                    keep_separator, strip_whitespace,
                )
                final_chunks.extend(other_info)
    if good_splits:
        merged_text = _merge_splits(
            good_splits, merge_separator, chunk_size, chunk_overlap,
            strip_whitespace,
        )
        final_chunks.extend(merged_text)
    return final_chunks


def recursive_split(text, chunk_size=1000, overlap=150, separators=None):
    """Vendored from langchain RecursiveCharacterTextSplitter (MIT). Returns list[str]."""
    if separators is None:
        separators = list(DEFAULT_SEPARATORS)
    if overlap > chunk_size:
        raise ValueError(
            f"Got a larger chunk overlap ({overlap}) than chunk size "
            f"({chunk_size}), should be smaller."
        )
    return _split_text(text, separators, chunk_size, overlap)
