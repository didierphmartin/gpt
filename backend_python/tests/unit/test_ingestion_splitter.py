"""Ported from backend/scripts/test-ingestion-splitter.php (same inputs, same
expected chunk lists -- captured via `php backend/scripts/...` and pinned as
literals, since chunking arithmetic must produce IDENTICAL chunk boundaries
to the PHP port, not just equivalent-looking output).

IngestionSplitter is a pure-PHP/pure-Python port of langchain's
RecursiveCharacterTextSplitter (keep_separator="start", length_function=len
== code-point count, i.e. mb_strlen). The PHP oracle script cross-checks
against the langchain_runner Python vendor at parity-test time; here we pin
IngestionSplitter's own PHP output directly (`php -r`, 2026-09-07) so this
port's chunk boundaries match PHP byte-for-byte, including on multibyte
text (accents, CJK, emoji) where a byte-length bug would silently shift
every boundary.
"""
from __future__ import annotations

import pathlib

import pytest

from app.agent_team.services.ingestion_splitter import IngestionSplitter

FIXTURES = pathlib.Path(__file__).resolve().parents[3] / 'backend' / 'tests' / 'fixtures'

# --- the same SAMPLES / CASES matrix as the PHP script's Python-vendor parity
# check, but the pinned literals are IngestionSplitter::recursiveSplit's OWN
# PHP output (`php backend/scripts/test-ingestion-splitter.php`'s harness
# builds these against the langchain_runner vendor; captured here directly
# from the PHP class via `php -r` so this is a same-input/same-output port
# check, not a re-derivation).
SAMPLES = [
    "Hello world. This is a test.\n\nA second paragraph with more words in it, "
    "long enough to force splitting across several chunks when the size is small.",
    "abcdefghij klmnopqrst uvwxyz0123 4567890123\n4567890123 4567890123",
    "Line one\nLine two\nLine three\n\nNew block here with a fairly long run of "
    "text that keeps going and going so that the splitter has real work to do "
    "and must merge and overlap pieces.",
    "no separators here just one very long token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
]
CASES = [(50, 0), (50, 10), (100, 20), (20, 5)]

EXPECTED_MATRIX = {
    (0, 50, 0): [
        "Hello world. This is a test.",
        "A second paragraph with more words in it, long",
        "enough to force splitting across several chunks",
        "when the size is small.",
    ],
    (0, 50, 10): [
        "Hello world. This is a test.",
        "A second paragraph with more words in it, long",
        "it, long enough to force splitting across several",
        "several chunks when the size is small.",
    ],
    (0, 100, 20): [
        "Hello world. This is a test.",
        "A second paragraph with more words in it, long enough to force splitting "
        "across several chunks when",
        "several chunks when the size is small.",
    ],
    (0, 20, 5): [
        "Hello world. This is",
        "is a test.",
        "A second paragraph",
        "with more words in",
        "in it, long enough",
        "to force splitting",
        "across several",
        "chunks when the",
        "the size is small.",
    ],
    (1, 50, 0): [
        "abcdefghij klmnopqrst uvwxyz0123 4567890123",
        "4567890123 4567890123",
    ],
    (1, 50, 10): [
        "abcdefghij klmnopqrst uvwxyz0123 4567890123",
        "4567890123 4567890123",
    ],
    (1, 100, 20): [
        "abcdefghij klmnopqrst uvwxyz0123 4567890123\n4567890123 4567890123",
    ],
    (1, 20, 5): [
        "abcdefghij",
        "klmnopqrst",
        "uvwxyz0123",
        "4567890123",
        "4567890123",
        "4567890123",
    ],
    (2, 50, 0): [
        "Line one\nLine two\nLine three",
        "New block here with a fairly long run of text",
        "that keeps going and going so that the splitter",
        "has real work to do and must merge and overlap",
        "pieces.",
    ],
    (2, 50, 10): [
        "Line one\nLine two\nLine three",
        "New block here with a fairly long run of text",
        "of text that keeps going and going so that the",
        "that the splitter has real work to do and must",
        "and must merge and overlap pieces.",
    ],
    (2, 100, 20): [
        "Line one\nLine two\nLine three",
        "New block here with a fairly long run of text that keeps going and going "
        "so that the splitter has",
        "the splitter has real work to do and must merge and overlap pieces.",
    ],
    (2, 20, 5): [
        "Line one\nLine two",
        "Line three",
        "New block here with",
        "with a fairly long",
        "long run of text",
        "text that keeps",
        "going and going so",
        "so that the",
        "the splitter has",
        "has real work to do",
        "do and must merge",
        "and overlap pieces.",
    ],
    (3, 50, 0): [
        "no separators here just one very long token",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    (3, 50, 10): [
        "no separators here just one very long token",
        "token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    (3, 100, 20): [
        "no separators here just one very long token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    (3, 20, 5): [
        "no separators here",
        "here just one very",
        "very long token",
        "aaaaaaaaaaaaaaaaaaa",
        "aaaaaaaaaaaaaaaaaaaa",
    ],
}


@pytest.mark.parametrize('si,cs,ov', [(si, cs, ov) for si in range(4) for cs, ov in CASES])
def test_recursive_split_matrix_matches_php(si, cs, ov):
    got = IngestionSplitter.recursiveSplit(SAMPLES[si], cs, ov)
    assert got == EXPECTED_MATRIX[(si, cs, ov)]


def test_overlap_greater_than_chunk_size_raises():
    with pytest.raises(ValueError):
        IngestionSplitter.recursiveSplit("some text here", 20, 30)


def test_overlap_equal_to_chunk_size_does_not_raise():
    IngestionSplitter.recursiveSplit("some text here", 20, 20)  # must not raise


def test_produces_multiple_chunks():
    chunks = IngestionSplitter.recursiveSplit(SAMPLES[0], 50, 10)
    assert len(chunks) > 1


def test_no_empty_chunks():
    chunks = IngestionSplitter.recursiveSplit(SAMPLES[0], 50, 10)
    assert all(c.strip() != '' for c in chunks)


def test_short_text_single_chunk():
    assert IngestionSplitter.recursiveSplit("tiny", 1000, 100) == ["tiny"]


def test_empty_text_no_chunks():
    assert IngestionSplitter.recursiveSplit("", 100, 10) == []


# --- multibyte parity (accents / CJK / emoji) -- pinned from `php -r` against
# IngestionSplitter::recursiveSplit(), 2026-09-07. Code-point length (not byte
# length) drives every boundary, so a mb_strlen-vs-strlen bug would show up
# here as a shifted or truncated chunk.
def test_multibyte_accents_chunk_40_8():
    text = (
        "Héllo wörld — café naïve.\n\nSéance café résumé — a longer paragraph with accented Löwe characters, "
        "enough to force splitting across chunks when the size is small: Zürich, Málaga, São Paulo."
    )
    assert IngestionSplitter.recursiveSplit(text, 40, 8) == [
        "Héllo wörld — café naïve.",
        "Séance café résumé — a longer paragraph",
        "with accented Löwe characters, enough",
        "enough to force splitting across chunks",
        "chunks when the size is small: Zürich,",
        "Zürich, Málaga, São Paulo.",
    ]


def test_multibyte_accents_chunk_20_5():
    text = (
        "Héllo wörld — café naïve.\n\nSéance café résumé — a longer paragraph with accented Löwe characters, "
        "enough to force splitting across chunks when the size is small: Zürich, Málaga, São Paulo."
    )
    assert IngestionSplitter.recursiveSplit(text, 20, 5) == [
        "Héllo wörld — café",
        "café naïve.",
        "Séance café résumé",
        "— a longer",
        "paragraph with",
        "with accented Löwe",
        "Löwe characters,",
        "enough to force",
        "splitting across",
        "chunks when the",
        "the size is small:",
        "Zürich, Málaga, São",
        "São Paulo.",
    ]


def test_multibyte_cjk_chunk_20_5():
    text = (
        "こんにちは世界。これはテストです。\n\n二番目の段落はもう少し長く、複数のチャンクに分割されるように十分な"
        "長さの文章です。日本語のテキストを分割します。"
    )
    assert IngestionSplitter.recursiveSplit(text, 20, 5) == [
        "こんにちは世界。これはテストです。",
        "二番目の段落はもう少し長く、複数のチャ",
        "複数のチャンクに分割されるように十分な長",
        "に十分な長さの文章です。日本語のテキスト",
        "のテキストを分割します。",
    ]


def test_multibyte_cjk_chunk_10_2():
    text = (
        "こんにちは世界。これはテストです。\n\n二番目の段落はもう少し長く、複数のチャンクに分割されるように十分な"
        "長さの文章です。日本語のテキストを分割します。"
    )
    assert IngestionSplitter.recursiveSplit(text, 10, 2) == [
        "こんにちは世界。これ",
        "これはテストです。",
        "二番目の段落はもう",
        "もう少し長く、複数の",
        "数のチャンクに分割さ",
        "割されるように十分な",
        "分な長さの文章です。",
        "す。日本語のテキスト",
        "ストを分割します。",
    ]


def test_multibyte_emoji_chunk_25_5():
    text = (
        "Emoji test 🎉🚀 with mixed scripts: café ☕ Zürich 東京 — a run of text long enough to split "
        "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂 more padding here to exceed size."
    )
    assert len(text) == 132  # code-point length, matches PHP mb_strlen($text,'UTF-8')
    assert IngestionSplitter.recursiveSplit(text, 25, 5) == [
        "Emoji test 🎉🚀 with mixed",
        "scripts: café ☕ Zürich",
        "東京 — a run of text long",
        "long enough to split",
        "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂 more padding",
        "here to exceed size.",
    ]


# --- real-world text: the loader-sample.pdf fixture, extracted via pypdf
# (the loader/splitter no longer decode PDFs themselves -- langfs does that
# server-side -- so this exercises the splitter's own trim/merge behaviour on
# realistic messy extraction output: long runs of whitespace-padded blank
# lines after the real content). Chunks pinned via `php -r` against
# IngestionSplitter::recursiveSplit() fed the SAME pypdf-extracted text.
def test_pdf_fixture_text_chunks_200_30():
    pypdf = pytest.importorskip('pypdf')
    reader = pypdf.PdfReader(str(FIXTURES / 'loader-sample.pdf'))
    text = ''.join(p.extract_text() or '' for p in reader.pages)
    assert len(text) == 5021
    assert IngestionSplitter.recursiveSplit(text, 200, 30) == [
        "Hello PDF world                                                                 \nSecond line here"
    ]


def test_pdf_fixture_text_chunks_500_50():
    pypdf = pytest.importorskip('pypdf')
    reader = pypdf.PdfReader(str(FIXTURES / 'loader-sample.pdf'))
    text = ''.join(p.extract_text() or '' for p in reader.pages)
    assert IngestionSplitter.recursiveSplit(text, 500, 50) == [
        "Hello PDF world                                                                 \nSecond line here"
    ]
