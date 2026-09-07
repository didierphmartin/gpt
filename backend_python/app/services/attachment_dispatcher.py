"""Port of Services/AttachmentDispatcher.php.

Attachment Dispatcher

Loads chat_attachments rows by id (with ownership check), reads bytes from
disk, and turns them into a chunk of text suitable for prepending to a
chat message — plus routes images and (for some providers) PDFs to native
provider dispatch.

As of 2026-05-08, the FRONTEND attachment-converter (Pyodide-based, in
frontend/assets/js/attachment-converter.js) is the primary path for binary
docs (.docx/.pptx/.xlsx/.pdf). It runs in the browser, produces Markdown,
and prepends it to the outgoing message text BEFORE the request reaches
this dispatcher. Phase 3 of chat.js strips converted attachment IDs from
`attachment_ids`, so under normal operation this dispatcher only sees:

  - image attachments → native per-provider dispatch (image_attachments)
  - PDFs on native-PDF providers → native dispatch (pdf_attachments)
  - text-native files (txt/md/csv/json/html) → read verbatim

The library paths in _extractText() are retained as a safety net for legacy /
non-converter-aware clients (stale cached JS, direct API callers, future
paths). They are no longer the primary extraction route. Workflow node remote
docs still use the PDF path here; that migration is a separate follow-up.

PHP uses smalot/pdfparser + the phpoffice/* family; this port uses pypdf,
python-docx, openpyxl and python-pptx. The block layout, headers, separators
and truncation marker are byte-identical; the extracted text of a given
document can differ between the two library families.
"""
from __future__ import annotations

import base64
import os

from app.support.logger import error_log
from app.support.phpcompat import mb_substr, php_empty, php_intval, php_strval


class AttachmentDispatcher:
    #: Cap each attachment's extracted text to keep request budgets sane.
    MAX_TEXT_PER_FILE = 100_000   # characters

    #: Providers that can ingest PDFs natively (preserving charts/figures)
    #: via inline base64 in the message body. For these, the dispatcher hands
    #: the raw bytes off in `pdf_attachments`; for others it falls back to
    #: server-side text extraction so the LLM still sees the document content.
    NATIVE_PDF_PROVIDERS = ['claude', 'gemini', 'openai']

    def __init__(self, db):
        self.db = db

    def buildPrefix(self, attachmentIds: list, userId: int, provider: str | None = None,
                    skillModeActive: bool = False) -> dict:
        """Build the per-request attachment payload.

        Routes each attachment by MIME and the active provider:
         - Images → `image_attachments` (always native).
         - PDF + provider supports native PDF (Claude, Gemini) → `pdf_attachments`.
         - PDF + other provider → text-extracted into `prefix` (current behaviour).
         - Office / text family → text-extracted into `prefix`.
        """
        if isinstance(attachmentIds, dict):
            attachmentIds = list(attachmentIds.values())
        attachmentIds = [id_ for id_ in (php_intval(x) for x in attachmentIds) if id_ > 0]
        # DIAGNOSTIC: confirm that the elision branch will or won't fire.
        # We've seen test cases where skill_metadata was set in the request
        # but the user_msg_len at the provider was huge (78K+) — which can
        # only happen if skillModeActive=false reached this dispatcher
        # (elision skipped) or some other code path is inlining the doc.
        # This log nails which.
        error_log('[AttachmentDispatcher] buildPrefix called — attachment_count: '
                  + str(len(attachmentIds)) + ', provider: ' + (provider if provider is not None else 'null')
                  + ', skillModeActive: ' + ('true (will elide)' if skillModeActive else 'false (will inline)'))
        if php_empty(attachmentIds):
            return {'prefix': '', 'image_attachments': [], 'pdf_attachments': [], 'notes': []}

        placeholders = ','.join(['?'] * len(attachmentIds))
        sql = ("SELECT id, original_name, stored_path, mime_type, size_bytes\n"
               "                FROM chat_attachments\n"
               f"                WHERE user_id = ? AND deleted_at IS NULL AND id IN ({placeholders})")
        rows = self.db.fetch_all(sql, [userId] + attachmentIds)

        if php_empty(rows):
            return {'prefix': '', 'image_attachments': [], 'pdf_attachments': [], 'notes': []}

        supportsNativePdf = provider is not None and provider.lower() in self.NATIVE_PDF_PROVIDERS

        blocks = []
        images = []
        pdfs = []
        notes = []
        for row in rows:
            name = php_strval(row['original_name'])
            mime = php_strval(row['mime_type'])
            path = php_strval(row['stored_path'])

            if not os.path.isfile(path):
                notes.append(f"Attachment '{name}' missing on disk; skipped.")
                continue

            # Images: read bytes, base64-encode, hand off for per-provider
            # native dispatch via options['image_attachments'].
            if mime.startswith('image/'):
                bytes_ = self._readFile(path)
                if bytes_ is None:
                    notes.append(f"Image '{name}' could not be read; skipped.")
                    continue
                images.append({
                    'mime_type': mime,
                    'data': base64.b64encode(bytes_).decode('ascii'),
                    'name': name,
                })
                continue

            # PDFs: if the active provider supports native PDF, hand the bytes
            # off so charts/figures/diagrams survive (text extraction would
            # lose them). Otherwise fall through to _extractText below.
            if mime == 'application/pdf' and supportsNativePdf:
                bytes_ = self._readFile(path)
                if bytes_ is None:
                    notes.append(f"PDF '{name}' could not be read; skipped.")
                    continue
                pdfs.append({
                    'mime_type': mime,
                    'data': base64.b64encode(bytes_).decode('ascii'),
                    'name': name,
                })
                continue

            # Skill-mode short-reference: when a folder-backed skill is the
            # expected handler for this turn (skill_metadata set or
            # available_skills non-empty), the attachment is also pre-written
            # to /scratch/<filename> by the frontend's B3 dispatch and read
            # by the script directly. Inlining the full text here is then
            # pure waste: a 78 KB HTML adds ~20K input tokens on every turn,
            # tempts the model to inline-respond instead of calling the
            # skill, and makes the auto-routing decision noisier. Replace
            # the body with a short reference + size hint; the skill catalog
            # (in the run_skill_script tool description) tells the model
            # which skill to call to actually process the file.
            if skillModeActive:
                sizeBytes = php_intval(row.get('size_bytes') if row.get('size_bytes') is not None else 0)
                blocks.append(f"### {name} ({sizeBytes} bytes, mime: {mime})\n"
                              f"[Pre-staged at /scratch/{name} for skill-script access. "
                              f"Pass this path to run_skill_script via argv (e.g. -i /scratch/{name}). "
                              "Full content NOT inlined here to save tokens.]")
                continue

            try:
                text = self._extractText(path, mime)
            except Exception as e:  # noqa: BLE001  (PHP: catch (Throwable $e))
                error_log(f'[AttachmentDispatcher] Extract failed for {name}: {e}')
                notes.append(f"Could not read '{name}'; skipped.")
                continue

            text = self._truncate(text)
            if text == '':
                notes.append(f"Attachment '{name}' contained no readable text; skipped.")
                continue

            blocks.append(f"### {name}\n{text}")

        prefix = ''
        if not php_empty(blocks):
            header = ("[The user attached the following document(s). They are pre-staged on the "
                      "script filesystem under /scratch/ — call run_skill_script with the "
                      "appropriate path in argv to process them.]\n\n") if skillModeActive else (
                     "[The user attached the following document(s); use them as authoritative "
                     "context for the message that follows.]\n\n")
            prefix = header + '\n\n---\n\n'.join(blocks) + '\n\n---\n\n'

        return {
            'prefix': prefix,
            'image_attachments': images,
            'pdf_attachments': pdfs,
            'notes': notes,
        }

    @staticmethod
    def _readFile(path: str) -> bytes | None:
        """`@file_get_contents($path)` — False (here: None) on failure."""
        try:
            with open(path, 'rb') as fh:
                return fh.read()
        except OSError:
            return None

    def _extractText(self, path: str, mime: str) -> str:
        """Pull text from the file. PDF via pypdf; Office docs via python-docx /
        openpyxl / python-pptx; everything else read verbatim as UTF-8.

        NOTE: this is now a fallback path. The frontend attachment-converter
        normally handles all binary formats client-side and strips their IDs
        from `attachment_ids` before the request hits this class. Under normal
        operation, the office-format branches below only run for legacy
        clients (stale cached JS) or non-UI API callers.
        """
        if mime == 'application/pdf':
            from pypdf import PdfReader
            reader = PdfReader(path)
            return '\n'.join((page.extract_text() or '') for page in reader.pages).strip()

        if (mime == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                or mime == 'application/msword'):
            return self._extractDocxText(path, mime)

        if (mime == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                or mime == 'application/vnd.ms-excel'):
            return self._extractXlsxText(path)

        if (mime == 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                or mime == 'application/vnd.ms-powerpoint'):
            return self._extractPptxText(path, mime)

        # Plain-text family. Reading the bytes handles them all uniformly;
        # we trust the upload-time MIME allowlist to keep this safe.
        bytes_ = self._readFile(path)
        if bytes_ is None:
            return ''
        # Strip BOM if present.
        if bytes_.startswith(b'\xEF\xBB\xBF'):
            bytes_ = bytes_[3:]
        return bytes_.decode('utf-8', errors='replace')

    def _extractDocxText(self, path: str, mime: str) -> str:
        """Extract text from DOCX (or legacy DOC) via python-docx.

        Walks the body tree and stitches paragraph / list / table content
        together into a readable paragraph stream. Images are not extracted.
        PHP reads legacy .doc with PhpWord's MsDoc reader; python-docx has no
        equivalent, so `application/msword` raises and the caller turns it
        into a "Could not read" note.
        """
        import docx
        from docx.oxml.ns import qn
        from docx.table import Table
        from docx.text.paragraph import Paragraph

        document = docx.Document(path)
        body = document.element.body

        out = []
        for child in body.iterchildren():
            if child.tag == qn('w:p'):
                element = Paragraph(child, document)
            elif child.tag == qn('w:tbl'):
                element = Table(child, document)
            else:
                continue
            txt = self._walkWordElement(element)
            if txt != '':
                out.append(txt)
        return '\n'.join(out).strip()

    def _walkWordElement(self, el) -> str:
        """Recursive walker for the python-docx element tree. Handles the common
        leaf elements (Paragraph — Text/TextRun/Title/Link in PhpWord terms,
        plus ListItem) and Table/row/cell containers."""
        from docx.table import Table, _Cell
        from docx.text.paragraph import Paragraph

        if isinstance(el, Paragraph):
            text = ''.join(run.text for run in el.runs).strip()
            style = getattr(getattr(el, 'style', None), 'name', '') or ''
            if text != '' and style.startswith('List'):
                return '- ' + text
            return text
        if isinstance(el, _Cell):
            return ' '.join(self._walkWordElement(child) for child in el.paragraphs).strip()
        if isinstance(el, Table):
            rows = []
            for row in el.rows:
                cells = [self._walkWordElement(cell) for cell in row.cells]
                rows.append('| ' + ' | '.join(cells) + ' |')
            return '\n'.join(rows)
        return ''

    def _extractXlsxText(self, path: str) -> str:
        """Extract data from XLSX via openpyxl. Each sheet becomes a
        markdown-style table; the first row is treated as a header. Empty rows
        are omitted from the stream. PHP reads legacy .xls with PhpSpreadsheet;
        openpyxl cannot, so it raises and the caller notes the file."""
        import openpyxl

        workbook = openpyxl.load_workbook(path, data_only=True)
        out = []

        for sheet in workbook.worksheets:
            title = sheet.title
            rows = [list(r) for r in sheet.iter_rows(values_only=True)]
            if php_empty(rows):
                continue

            out.append(f'## Sheet: {title}')
            for i, row in enumerate(rows):
                # Skip completely-empty rows.
                nonEmpty = [v for v in row if v is not None and v != '']
                if php_empty(nonEmpty):
                    continue

                cells = [php_strval(v if v is not None else '') for v in row]
                out.append('| ' + ' | '.join(cells) + ' |')
                # Insert a separator after the first non-empty row (markdown header).
                if i == 0 and len(out) > 1:
                    out.append('| ' + ' | '.join(['---'] * len(cells)) + ' |')
            out.append('')
        return '\n'.join(out).strip()

    def _extractPptxText(self, path: str, mime: str) -> str:
        """Extract text from PPTX via python-pptx. Walks slides and extracts
        text-frame shapes. Images/shapes with no text are skipped."""
        # PHP's PhpPresentation only has a PowerPoint2007 reader in stable
        # releases; legacy .ppt would need a different tool. We still accept
        # the upload but return empty for .ppt, letting the dispatcher emit
        # a "no readable text" note.
        if mime == 'application/vnd.ms-powerpoint':
            return ''

        from pptx import Presentation

        presentation = Presentation(path)

        out = []
        for i, slide in enumerate(presentation.slides):
            slideNum = i + 1
            lines = []
            for shape in slide.shapes:
                if getattr(shape, 'has_text_frame', False):
                    for paragraph in shape.text_frame.paragraphs:
                        t = php_strval(paragraph.text).strip()
                        if t != '':
                            lines.append(t)
            if not php_empty(lines):
                out.append(f'## Slide {slideNum}\n' + '\n'.join(lines))
        return '\n\n'.join(out).strip()

    def _truncate(self, text: str) -> str:
        if len(text) <= self.MAX_TEXT_PER_FILE:
            return text
        return (mb_substr(text, 0, self.MAX_TEXT_PER_FILE)
                + '\n\n[…document truncated at ' + str(self.MAX_TEXT_PER_FILE) + ' characters…]')
