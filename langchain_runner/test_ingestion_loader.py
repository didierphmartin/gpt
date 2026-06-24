"""Tests for ingestion_loader: the loader's file-read step
(recursive list_files -> read_file -> decode -> text).

Pure-Python kernel (mirrors ingestion_splitter): the MCP transport
(list_files / read_file) is INJECTED so the same logic runs under Pyodide
(browser) and in the compiled standalone script. Run with:

    .venv/bin/python test_ingestion_loader.py
"""
from __future__ import annotations

import io
import zipfile

from ingestion_loader import (
    detect_type, decode, enumerate_files, load_file, load_documents,
)


# ---------------------------------------------------------------------------
# A fake UniversalFS list_files backed by an in-memory tree: maps a folder
# path to the items directly under it. Mirrors the MCP shape
# {"files": [{"id", "name", "type": "file"|"folder"}, ...]}.
# ---------------------------------------------------------------------------
def fake_list_files(tree):
    def list_files(provider, path):
        return {"files": tree.get(path, [])}
    return list_files


def f(path):
    return {"id": path, "name": path.rsplit("/", 1)[-1], "type": "file"}


def d(path):
    return {"id": path, "name": path.rsplit("/", 1)[-1], "type": "folder"}


# ---------------------------------------------------------------------------
# Fixtures: build minimal real PDF / DOCX so decode is tested against the
# actual libraries (pypdf / docx2txt), not a mock.
# ---------------------------------------------------------------------------
def make_pdf(text: str) -> bytes:
    """A minimal single-page PDF whose one text run extracts to `text`."""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        None,  # content stream, filled below
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = b"BT /F1 24 Tf 100 700 Td (" + text.encode() + b") Tj ET"
    objs[3] = b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
    out = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref_pos = len(out)
    n = len(objs) + 1
    out += b"xref\n0 " + str(n).encode() + b"\n0000000000 65535 f \n"
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += b"trailer\n<< /Size " + str(n).encode() + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF\n"
    return out


def make_docx(text: str) -> bytes:
    """A minimal .docx (zip) with one paragraph containing `text`."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.'
            'wordprocessingml.document.main+xml"/></Types>',
        )
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>",
        )
    return buf.getvalue()


# ---------------------------------------------------------------------------
# detect_type
# ---------------------------------------------------------------------------
def test_detect_type():
    assert detect_type("report.pdf") == "pdf"
    assert detect_type("notes.PDF") == "pdf"          # case-insensitive
    assert detect_type("memo.docx") == "word"
    assert detect_type("memo.doc") == "word"
    assert detect_type("readme.txt") == "text"
    assert detect_type("data.csv") == "csv"
    assert detect_type("a/b/deep.pdf") == "pdf"       # path, not just name
    assert detect_type("archive.zip") is None          # unsupported
    assert detect_type("noext") is None
    print("detect_type OK")


# ---------------------------------------------------------------------------
# decode — the pure text formats first
# ---------------------------------------------------------------------------
def test_decode_text():
    assert decode("readme.txt", b"hello world") == "hello world"
    # utf-8 round-trips
    assert decode("u.txt", "café\nrésumé".encode("utf-8")) == "café\nrésumé"
    print("decode_text OK")


def test_decode_csv():
    assert decode("data.csv", b"x,y\n1,2\n3,4") == "x,y\n1,2\n3,4"
    print("decode_csv OK")


def test_decode_pdf():
    text = decode("report.pdf", make_pdf("Hello PDF world"))
    assert "Hello PDF world" in text, repr(text)
    print("decode_pdf OK")


def test_decode_word():
    text = decode("memo.docx", make_docx("Hello DOCX world"))
    assert "Hello DOCX world" in text, repr(text)
    print("decode_word OK")


def test_decode_auto_routes_by_extension():
    # doc_type defaults to "auto" -> picks the loader from the extension.
    assert decode("report.pdf", make_pdf("Auto PDF")).strip() == "Auto PDF"
    assert decode("notes.txt", b"plain") == "plain"
    print("decode_auto OK")


def test_decode_unsupported_raises():
    raised = False
    try:
        decode("archive.zip", b"PK\x03\x04")
    except ValueError:
        raised = True
    assert raised, "decode must raise ValueError on an unsupported extension"
    print("decode_unsupported OK")


# ---------------------------------------------------------------------------
# enumerate_files
# ---------------------------------------------------------------------------
def test_enumerate_single_file_auto():
    lf = fake_list_files({})  # not consulted for a single file
    items = enumerate_files(lf, "local", "doc.pdf", doc_type="auto", is_dir=False)
    assert len(items) == 1, items
    it = items[0]
    assert it["file_id"] == "doc.pdf"
    assert it["source"] == "doc.pdf"     # provenance = full path
    assert it["doc_type"] == "pdf"       # detected from the extension
    assert it["provider"] == "local"
    print("enumerate_single_auto OK")


def test_enumerate_single_file_explicit_forces_type():
    # Explicit type overrides the (here misleading) extension.
    lf = fake_list_files({})
    items = enumerate_files(lf, "local", "scan.bin", doc_type="pdf", is_dir=False)
    assert len(items) == 1
    assert items[0]["doc_type"] == "pdf"
    print("enumerate_single_explicit OK")


def _build_tree():
    # root/
    #   a.pdf  notes.txt  image.png(skip)
    #   sub/
    #     b.docx  deep/
    #               c.csv
    return {
        "root": [f("root/a.pdf"), f("root/notes.txt"), f("root/image.png"), d("root/sub")],
        "root/sub": [f("root/sub/b.docx"), d("root/sub/deep")],
        "root/sub/deep": [f("root/sub/deep/c.csv")],
    }


def test_enumerate_folder_recursive_auto():
    lf = fake_list_files(_build_tree())
    items = enumerate_files(lf, "local", "root", doc_type="auto", is_dir=True)
    by_source = {it["source"]: it["doc_type"] for it in items}
    assert by_source == {
        "root/a.pdf": "pdf",
        "root/notes.txt": "text",
        "root/sub/b.docx": "word",       # descends every nested subfolder
        "root/sub/deep/c.csv": "csv",    # ...at any depth
    }, by_source
    assert "root/image.png" not in by_source  # unsupported skipped
    print("enumerate_folder_auto OK")


def test_enumerate_folder_explicit_filters_by_extension():
    lf = fake_list_files(_build_tree())
    items = enumerate_files(lf, "local", "root", doc_type="pdf", is_dir=True)
    sources = sorted(it["source"] for it in items)
    assert sources == ["root/a.pdf"], sources  # only the matching extension
    assert all(it["doc_type"] == "pdf" for it in items)
    print("enumerate_folder_explicit OK")


def test_enumerate_cycle_guard():
    # A folder that lists an already-visited ancestor must not loop forever.
    tree = {
        "root": [f("root/a.pdf"), d("root/loop")],
        "root/loop": [f("root/loop/b.txt"), d("root")],  # back-edge to root
    }
    lf = fake_list_files(tree)
    items = enumerate_files(lf, "local", "root", doc_type="auto", is_dir=True)
    sources = sorted(it["source"] for it in items)
    assert sources == ["root/a.pdf", "root/loop/b.txt"], sources
    print("enumerate_cycle_guard OK")


# ---------------------------------------------------------------------------
# load_file / load_documents — read_file (injected) -> decode -> text
# ---------------------------------------------------------------------------
def fake_read_file(blobs):
    def read_file(provider, file_id):
        return blobs[file_id]
    return read_file


def test_load_file_reads_and_decodes():
    rf = fake_read_file({"root/notes.txt": b"hello from disk"})
    desc = enumerate_files(None, "local", "root/notes.txt",
                           doc_type="auto", is_dir=False)[0]
    assert load_file(rf, desc) == "hello from disk"
    print("load_file OK")


def test_load_documents_yields_text_and_source():
    tree = {
        "root": [f("root/a.txt"), f("root/b.csv"), f("root/skip.png"), d("root/sub")],
        "root/sub": [f("root/sub/c.txt")],
    }
    blobs = {
        "root/a.txt": b"alpha",
        "root/b.csv": b"x,y\n1,2",
        "root/sub/c.txt": b"gamma",
    }
    docs = list(load_documents(fake_list_files(tree), fake_read_file(blobs),
                               "local", "root", doc_type="auto", is_dir=True))
    by_source = {dchunk["source"]: dchunk["text"] for dchunk in docs}
    assert by_source == {
        "root/a.txt": "alpha",
        "root/b.csv": "x,y\n1,2",
        "root/sub/c.txt": "gamma",
    }, by_source
    print("load_documents OK")


def test_load_documents_pdf_end_to_end():
    blobs = {"root/r.pdf": make_pdf("End to end PDF")}
    tree = {"root": [f("root/r.pdf")]}
    docs = list(load_documents(fake_list_files(tree), fake_read_file(blobs),
                               "local", "root", doc_type="auto", is_dir=True))
    assert len(docs) == 1
    assert "End to end PDF" in docs[0]["text"]
    assert docs[0]["source"] == "root/r.pdf"
    print("load_documents_pdf OK")


if __name__ == "__main__":
    test_detect_type()
    test_decode_text()
    test_decode_csv()
    test_decode_pdf()
    test_decode_word()
    test_decode_auto_routes_by_extension()
    test_decode_unsupported_raises()
    test_enumerate_single_file_auto()
    test_enumerate_single_file_explicit_forces_type()
    test_enumerate_folder_recursive_auto()
    test_enumerate_folder_explicit_filters_by_extension()
    test_enumerate_cycle_guard()
    test_load_file_reads_and_decodes()
    test_load_documents_yields_text_and_source()
    test_load_documents_pdf_end_to_end()
    print("ALL OK")
