"""Unit tests for the Task 5b document-reading methods of
app.agent_team.services.graph_workflow_runner.GraphWorkflowRunner:
`buildDocumentsContext` (real since Task 5a; exercised here end-to-end with
real leaves), `getDocumentImages`, `readDocumentContent`, `readFileRaw`,
`extractPdfText`, `basicPdfTextExtract`, `isImageFile`,
`getDocumentStorageAdapter` (always None -- universalFS local-fallback
ruling), `getUserStorageProvider`, `getDocumentLocalPath`.

No PHP oracle exists for these (same `find backend/tests -iname
'*GraphWorkflowRunner*'` empty result documented in
test_graph_workflow_runner_core.py's module docstring), so cases are written
from the PHP source directly (GraphWorkflowRunner.php 2862-3155) plus the
Task 5b brief's own test list: a tmp local-storage root with pdf/txt/png
fixtures (exact text blocks), and `basicPdfTextExtract` on a hand-built
minimal PDF stream.
"""
from __future__ import annotations

import zlib

from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner


# ---------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------

class FakeDb:
    def fetch_one(self, sql, params=None):
        return None

    def fetch_all(self, sql, params=None):
        return []

    def insert(self, sql, params=None):
        return 1

    def execute(self, sql, params=None):
        return 1


class FakeGraphRepository:
    def findStartNode(self, workflow_id):
        return None

    def getGraph(self, workflow_id):
        return {'nodes': [], 'edges': []}


def _make_runner(tmp_path, userId=7, extra_config=None):
    config = {'storage_path': str(tmp_path)}
    if extra_config:
        config.update(extra_config)
    runner = GraphWorkflowRunner(FakeDb(), agentRepository=None, agentRunner=None,
                                  graphRepository=FakeGraphRepository(), config=config)
    runner.currentUserId = userId
    return runner


def _node(config: dict) -> dict:
    return {'id': 1, 'node_type': 'agent', 'config': config, 'agent_id': None, 'drawflow_node_id': None}


def _build_minimal_pdf(text: str) -> bytes:
    """A hand-built, byte-offset-correct minimal one-page PDF (no external
    PDF-writer library is a project dependency) -- verified against pypdf
    directly (returns exactly `text` from page.extract_text()) before use
    here. One Helvetica Tj text-showing operator, no compression."""
    objs = []
    objs.append(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
    objs.append(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
    objs.append(
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
    )
    content = f"BT /F1 24 Tf 10 100 Td ({text}) Tj ET".encode('latin-1')
    objs.append(b"4 0 obj\n<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream\nendobj\n")
    objs.append(b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")

    header = b"%PDF-1.4\n"
    body = b""
    offsets = [0]
    pos = len(header)
    for o in objs:
        offsets.append(pos)
        body += o
        pos += len(o)

    xref_pos = len(header) + len(body)
    n = len(objs) + 1
    xref = b"xref\n0 %d\n" % n
    xref += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        xref += ("%010d 00000 n \n" % off).encode('ascii')

    trailer = b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (n, xref_pos)
    return header + body + xref + trailer


# ---------------------------------------------------------------------------
# isImageFile (PHP 3061-3064)
# ---------------------------------------------------------------------------

def test_is_image_file(tmp_path):
    runner = _make_runner(tmp_path)
    assert runner._isImageFile('image/png') is True
    assert runner._isImageFile('image/jpeg') is True
    assert runner._isImageFile('text/plain') is False
    assert runner._isImageFile('application/pdf') is False
    assert runner._isImageFile('') is False


# ---------------------------------------------------------------------------
# getDocumentLocalPath / getUserStorageProvider (PHP 3127-3155)
# ---------------------------------------------------------------------------

def test_get_document_local_path_uses_configured_storage_path(tmp_path):
    runner = _make_runner(tmp_path)
    assert runner._getDocumentLocalPath('docs/a.txt') == str(tmp_path) + '/docs/a.txt'
    # ltrim($relativePath, '/') -- leading slash stripped, not a full trim.
    assert runner._getDocumentLocalPath('/docs/a.txt') == str(tmp_path) + '/docs/a.txt'


def test_get_document_local_path_default_base_is_gpt_storage(tmp_path):
    runner = GraphWorkflowRunner(FakeDb(), None, None, FakeGraphRepository(), config={})
    from app.config import PHP_BACKEND
    assert runner._getDocumentLocalPath('x.txt') == str(PHP_BACKEND.parent / 'storage') + '/x.txt'


def test_get_user_storage_provider_prefers_user_row(tmp_path):
    class Db(FakeDb):
        def fetch_one(self, sql, params=None):
            return {'storage_provider': 'gdrive'}
    runner = GraphWorkflowRunner(Db(), None, None, FakeGraphRepository(), config={'default_storage_provider': 's3'})
    assert runner._getUserStorageProvider(7) == 'gdrive'


def test_get_user_storage_provider_falls_back_to_config_chain(tmp_path):
    runner = GraphWorkflowRunner(FakeDb(), None, None, FakeGraphRepository(),
                                  config={'storage': {'default_provider': 'onedrive'}})
    assert runner._getUserStorageProvider(7) == 'onedrive'

    runner2 = GraphWorkflowRunner(FakeDb(), None, None, FakeGraphRepository(), config={'default_storage_provider': 's3'})
    assert runner2._getUserStorageProvider(7) == 's3'

    runner3 = GraphWorkflowRunner(FakeDb(), None, None, FakeGraphRepository(), config={'storage_provider': 'gcs'})
    assert runner3._getUserStorageProvider(7) == 'gcs'

    runner4 = GraphWorkflowRunner(FakeDb(), None, None, FakeGraphRepository(), config={})
    assert runner4._getUserStorageProvider(7) == 'local'


# ---------------------------------------------------------------------------
# getDocumentStorageAdapter -- always None (universalFS local-fallback ruling)
# ---------------------------------------------------------------------------

def test_get_document_storage_adapter_always_none(tmp_path):
    runner = _make_runner(tmp_path)
    assert runner._getDocumentStorageAdapter(7) is None
    assert runner._getDocumentStorageAdapter() is None  # falls back to currentUserId


def test_get_document_storage_adapter_no_user_id_logs_and_returns_none(tmp_path):
    runner = _make_runner(tmp_path)
    runner.currentUserId = None
    assert runner._getDocumentStorageAdapter() is None


# ---------------------------------------------------------------------------
# readFileRaw -- local fallback (PHP 2966-2996)
# ---------------------------------------------------------------------------

def test_read_file_raw_reads_from_local_fallback(tmp_path):
    (tmp_path / 'docs').mkdir()
    (tmp_path / 'docs' / 'a.txt').write_bytes(b'raw bytes here')
    runner = _make_runner(tmp_path)

    content = runner._readFileRaw({'path': 'docs/a.txt'})
    assert content == b'raw bytes here'


def test_read_file_raw_prefers_full_path_over_path(tmp_path):
    (tmp_path / 'x.txt').write_bytes(b'full path wins')
    (tmp_path / 'wrong.txt').write_bytes(b'should not be read')
    runner = _make_runner(tmp_path)

    content = runner._readFileRaw({'path': 'wrong.txt', 'fullPath': 'x.txt'})
    assert content == b'full path wins'


def test_read_file_raw_returns_none_when_no_path_given(tmp_path):
    runner = _make_runner(tmp_path)
    assert runner._readFileRaw({}) is None


def test_read_file_raw_returns_none_when_file_missing(tmp_path):
    runner = _make_runner(tmp_path)
    assert runner._readFileRaw({'path': 'missing.txt'}) is None


# ---------------------------------------------------------------------------
# readDocumentContent -- storage='local' branch (PHP 2906-2939)
# ---------------------------------------------------------------------------

def test_read_document_content_local_storage_uses_scratch_reference(tmp_path):
    runner = _make_runner(tmp_path)
    runner.scratchFilesByDocId['doc1'] = {'path': '/scratch/a.csv', 'mime_type': 'text/csv', 'size': 42}

    result = runner._readDocumentContent({'id': 'doc1', 'name': 'a.csv', 'storage': 'local'})

    assert '/scratch/a.csv' in result
    assert 'text/csv' in result
    assert '42 bytes' in result
    assert 'Do not paste or restate the file content' in result


def test_read_document_content_local_storage_uses_inline_documents(tmp_path):
    runner = _make_runner(tmp_path)
    runner.inlineDocuments['doc2'] = 'inline body text'

    result = runner._readDocumentContent({'id': 'doc2', 'name': 'b.txt', 'storage': 'local'})
    assert result == 'inline body text'


def test_read_document_content_local_storage_no_inline_falls_back_to_message(tmp_path):
    runner = _make_runner(tmp_path)
    result = runner._readDocumentContent({'id': 'doc3', 'name': 'c.txt', 'storage': 'local'})
    assert "stored locally on user's machine" in result
    assert 'c.txt' in result


# ---------------------------------------------------------------------------
# readDocumentContent -- remote/text branch (PHP 2942-2960)
# ---------------------------------------------------------------------------

def test_read_document_content_remote_text_file(tmp_path):
    (tmp_path / 'docs').mkdir()
    (tmp_path / 'docs' / 'notes.txt').write_text('plain text body', encoding='utf-8')
    runner = _make_runner(tmp_path)

    result = runner._readDocumentContent({
        'name': 'notes.txt', 'mimeType': 'text/plain', 'storage': 'remote', 'path': 'docs/notes.txt',
    })
    assert result == 'plain text body'


def test_read_document_content_remote_returns_empty_when_unreadable(tmp_path):
    runner = _make_runner(tmp_path)
    result = runner._readDocumentContent({'name': 'gone.txt', 'mimeType': 'text/plain', 'path': 'gone.txt'})
    assert result == ''


def test_read_document_content_invalid_utf8_falls_back_to_latin1(tmp_path):
    (tmp_path / 'bin.txt').write_bytes(b'\xff\xfe not valid utf-8')
    runner = _make_runner(tmp_path)
    result = runner._readDocumentContent({'name': 'bin.txt', 'mimeType': 'text/plain', 'path': 'bin.txt'})
    assert result == '\xff\xfe not valid utf-8'  # latin-1 round-trip, never raises


# ---------------------------------------------------------------------------
# extractPdfText -- pypdf primary path (PHP 3001-3029, pypdf per constraints.md)
# ---------------------------------------------------------------------------

def test_extract_pdf_text_uses_pypdf_for_a_real_pdf(tmp_path):
    (tmp_path / 'doc.pdf').write_bytes(_build_minimal_pdf('Hello PDF'))
    runner = _make_runner(tmp_path)

    text = runner._extractPdfText({'mimeType': 'application/pdf', 'path': 'doc.pdf'})
    assert text == 'Hello PDF'


def test_extract_pdf_text_unreadable_returns_placeholder(tmp_path):
    runner = _make_runner(tmp_path)
    text = runner._extractPdfText({'mimeType': 'application/pdf', 'path': 'missing.pdf'})
    assert text == '[PDF content could not be read]'


def test_read_document_content_dispatches_pdf_to_extract_pdf_text(tmp_path):
    (tmp_path / 'doc.pdf').write_bytes(_build_minimal_pdf('Routed via readDocumentContent'))
    runner = _make_runner(tmp_path)

    result = runner._readDocumentContent({'mimeType': 'application/pdf', 'path': 'doc.pdf', 'name': 'doc.pdf'})
    assert result == 'Routed via readDocumentContent'


# ---------------------------------------------------------------------------
# basicPdfTextExtract -- regex fallback on a hand-built minimal PDF stream
# (PHP 3034-3056, the brief's own required case).
# ---------------------------------------------------------------------------

def test_basic_pdf_text_extract_regex_scan_on_uncompressed_stream(tmp_path):
    runner = _make_runner(tmp_path)
    raw = b"%PDF-1.4 junk\nstream\n(Hello World) (foo)\nendstream\ntrailing junk"
    assert runner._basicPdfTextExtract(raw) == 'Hello World foo'


def test_basic_pdf_text_extract_decompresses_zlib_stream(tmp_path):
    runner = _make_runner(tmp_path)
    compressed = zlib.compress(b"(compressed text)")
    raw = b"stream\n" + compressed + b"\nendstream"
    assert runner._basicPdfTextExtract(raw) == 'compressed text'


def test_basic_pdf_text_extract_multiple_streams_concatenate_with_newline(tmp_path):
    runner = _make_runner(tmp_path)
    raw = b"stream\n(First) \nendstream junk between streams stream\n(Second)\nendstream"
    assert runner._basicPdfTextExtract(raw) == 'First\nSecond'


def test_basic_pdf_text_extract_no_streams_returns_placeholder(tmp_path):
    runner = _make_runner(tmp_path)
    assert runner._basicPdfTextExtract(b"no pdf streams in here at all") == (
        '[PDF text extraction limited - install pdftotext for better results]'
    )


def test_extract_pdf_text_falls_back_to_basic_extract_when_pypdf_fails(tmp_path):
    """A byte blob that is not a parseable PDF (pypdf raises) but DOES
    contain a stream/endstream pair with literal-string text -- proves the
    extractPdfText -> basicPdfTextExtract fallback chain end to end."""
    (tmp_path / 'broken.pdf').write_bytes(b"not really a pdf\nstream\n(Fallback text) \nendstream\n")
    runner = _make_runner(tmp_path)

    text = runner._extractPdfText({'mimeType': 'application/pdf', 'path': 'broken.pdf'})
    assert text == 'Fallback text'


# ---------------------------------------------------------------------------
# getDocumentImages (PHP 2866-2901)
# ---------------------------------------------------------------------------

def test_get_document_images_base64_encodes_remote_images(tmp_path):
    (tmp_path / 'pic.png').write_bytes(b'\x89PNG\r\n\x1a\nfake png bytes')
    runner = _make_runner(tmp_path)
    node = _node({'documents': [
        {'name': 'pic.png', 'mimeType': 'image/png', 'storage': 'remote', 'path': 'pic.png'},
    ]})

    images = runner._getDocumentImages(node)

    assert len(images) == 1
    assert images[0]['type'] == 'image'
    assert images[0]['source']['media_type'] == 'image/png'
    import base64
    assert base64.b64decode(images[0]['source']['data']) == b'\x89PNG\r\n\x1a\nfake png bytes'


def test_get_document_images_skips_local_storage_images(tmp_path):
    runner = _make_runner(tmp_path)
    node = _node({'documents': [
        {'name': 'local.png', 'mimeType': 'image/png', 'storage': 'local'},
    ]})
    assert runner._getDocumentImages(node) == []


def test_get_document_images_skips_non_images(tmp_path):
    runner = _make_runner(tmp_path)
    node = _node({'documents': [
        {'name': 'a.txt', 'mimeType': 'text/plain', 'storage': 'remote', 'path': 'a.txt'},
    ]})
    assert runner._getDocumentImages(node) == []


# ---------------------------------------------------------------------------
# buildDocumentsContext end to end (real since Task 5a; exercised here with
# real leaves) -- exact text blocks per the brief's test list.
# ---------------------------------------------------------------------------

def test_build_documents_context_exact_text_with_pdf_txt_and_image(tmp_path):
    (tmp_path / 'notes.txt').write_text('some notes', encoding='utf-8')
    (tmp_path / 'report.pdf').write_bytes(_build_minimal_pdf('PDF body text'))
    (tmp_path / 'photo.png').write_bytes(b'\x89PNG fake bytes')
    runner = _make_runner(tmp_path)

    node = _node({'documents': [
        {'name': 'notes.txt', 'mimeType': 'text/plain', 'storage': 'remote', 'path': 'notes.txt'},
        {'name': 'report.pdf', 'mimeType': 'application/pdf', 'storage': 'remote', 'path': 'report.pdf'},
        {'name': 'photo.png', 'mimeType': 'image/png', 'storage': 'remote', 'path': 'photo.png'},
    ]})

    result = runner._buildDocumentsContext(node)

    assert result == (
        "## Attached Documents\n"
        "\n"
        "### notes.txt\n```\nsome notes\n```\n"
        "\n"
        "### report.pdf\n```\nPDF body text\n```\n"
        "\n"
        "\n_Note: 1 image(s) attached (processed separately if model supports vision)_\n"
    )


def test_build_documents_context_empty_when_no_documents(tmp_path):
    runner = _make_runner(tmp_path)
    node = _node({})
    assert runner._buildDocumentsContext(node) == ''


def test_build_documents_context_error_block_when_document_unreadable(tmp_path):
    """readDocumentContent for a PDF that doesn't exist on disk raises no
    exception itself (extractPdfText's own guard returns a placeholder
    string), so this exercises PHP's other error path: an unhandled
    exception from a leaf surfaces as a "[Error: ...]" block rather than
    aborting the whole context build. A local-storage doc with a name field
    that breaks Python f-string formatting would just render literally, so
    instead this proves the catch-and-continue by monkeypatching a leaf to
    raise, matching PHP's `try { ... } catch (\\Exception $e) { ... }`
    (PHP 2844-2852) around readDocumentContent."""
    runner = _make_runner(tmp_path)

    def _boom(doc):
        raise RuntimeError('disk exploded')
    runner._readDocumentContent = _boom  # type: ignore[method-assign]

    node = _node({'documents': [{'name': 'x.txt', 'mimeType': 'text/plain', 'path': 'x.txt'}]})
    result = runner._buildDocumentsContext(node)

    assert result == "## Attached Documents\n\n### x.txt\n[Error: Could not read document]\n"
