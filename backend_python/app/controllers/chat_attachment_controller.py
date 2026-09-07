"""Port of Controllers/ChatAttachmentController.php.

Chat Attachment Controller

Accepts files uploaded by the user via the chat prompt's attach button or
drag-drop. Stores bytes to disk (backend/storage/chat-uploads/<userId>/<uuid>)
and metadata to the `chat_attachments` table. Returns a numeric id the
frontend sends alongside the next chat message so ChatController can load
the file and forward it in provider-specific shape (PDF block for Claude,
inline_data for Gemini, Files API upload for Grok/Kimi, etc.).

This controller only handles storage. Per-provider dispatch is Phase 3.

PHP resolves the storage root from `__DIR__`; here it comes from
`config['chat_upload_root']` (env `CHAT_UPLOAD_ROOT`), whose default is the
same physical directory PHP writes to.
"""
from __future__ import annotations

import json
import os
import shutil
import uuid

from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_intval, php_strval

# PHP's `finfo_file(FILEINFO_MIME_TYPE, ...)` replacement: byte signatures for
# every binary type in ALLOWED_MIME, in the order libmagic tests them.
_MAGIC = (
    (b'%PDF-', 'application/pdf'),
    (b'\x89PNG\r\n\x1a\n', 'image/png'),
    (b'\xff\xd8\xff', 'image/jpeg'),
    (b'GIF87a', 'image/gif'),
    (b'GIF89a', 'image/gif'),
    (b'PK\x03\x04', 'application/zip'),          # OOXML docx/xlsx/pptx container
    (b'PK\x05\x06', 'application/zip'),
    (b'PK\x07\x08', 'application/zip'),
    (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'application/x-ole-storage'),   # legacy doc/xls/ppt
)


class ChatAttachmentController:
    #: MIME allowlist. Office formats (docx/xlsx/pptx + legacy doc/xls) are
    #: accepted. As of 2026-05-08 the frontend attachment-converter (Pyodide)
    #: is the primary text-extraction path; AttachmentDispatcher's library
    #: branches are kept as a fallback for legacy clients.
    ALLOWED_MIME = {
        'application/pdf': 'pdf',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'text/csv': 'csv',
        'text/html': 'html',
        'application/json': 'json',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        'application/vnd.ms-powerpoint': 'ppt',
    }

    #: Hard ceiling on a single upload. Per-package caps can narrow this
    #: further in a future phase (capabilities.max_upload_mb).
    MAX_BYTES = 50 * 1024 * 1024   # 50 MB

    def __init__(self, db, config):
        self.db = db
        self.storageRoot = php_strval(config.get('chat_upload_root') or '')

    def upload(self, request) -> dict:
        """POST /api/v1/chat/upload  (multipart/form-data)

        Field: `file` (single) — we accept one upload at a time; the frontend
        POSTs once per selected/dropped file so per-file errors don't take the
        whole batch down.
        """
        userId = request.get('user_id') if request.get('user_id') is not None else None
        if not userId or not is_numeric(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        userIdInt = php_intval(userId)

        files = request.get('files') or {}
        upload = files.get('file')
        if not upload or not isinstance(upload, dict):
            return {'success': False, 'error': 'No file field', 'status_code': 400}

        error = upload.get('error') if upload.get('error') is not None else 4   # UPLOAD_ERR_NO_FILE
        if error != 0:   # UPLOAD_ERR_OK
            return {
                'success': False,
                'error': 'Upload failed (error code ' + str(php_intval(error)) + ')',
                'status_code': 400,
            }

        size = php_intval(upload.get('size') if upload.get('size') is not None else 0)
        if size <= 0:
            return {'success': False, 'error': 'Empty file', 'status_code': 400}
        if size > self.MAX_BYTES:
            return {
                'success': False,
                'error': 'File exceeds ' + str(self.MAX_BYTES // 1024 // 1024) + ' MB limit',
                'status_code': 413,
            }

        # Detect the real MIME from the bytes (not from the browser-supplied
        # type, which can be spoofed or misreported).
        tmpPath = php_strval(upload.get('tmp_name') if upload.get('tmp_name') is not None else '')
        if not tmpPath or not os.path.isfile(tmpPath):
            return {'success': False, 'error': 'Temporary upload file missing', 'status_code': 500}
        detectedMime = self._detectMime(
            tmpPath, php_strval(upload.get('name') if upload.get('name') is not None else ''))
        if detectedMime not in self.ALLOWED_MIME:
            return {
                'success': False,
                'error': f'Unsupported file type: {detectedMime}. '
                         'Allowed: PDF, PNG/JPEG/WebP/GIF, plain text, Markdown, CSV, HTML, JSON. '
                         '(Office documents will be supported in a later release.)',
                'status_code': 415,
            }

        # Build per-user storage directory.
        userDir = self.storageRoot + '/' + str(userIdInt)
        if not os.path.isdir(userDir):
            try:
                os.makedirs(userDir, mode=0o755, exist_ok=True)
            except OSError:
                pass
            if not os.path.isdir(userDir):
                return {'success': False, 'error': 'Storage init failed', 'status_code': 500}

        uuid_ = self._uuidv4()
        ext = self.ALLOWED_MIME[detectedMime]
        storedName = uuid_ + '.' + ext
        storedPath = userDir + '/' + storedName

        try:
            shutil.move(tmpPath, storedPath)
        except OSError as e:
            error_log('[ChatAttachmentController] move_uploaded_file failed: ' + str(e))
            return {'success': False, 'error': 'Failed to persist upload', 'status_code': 500}

        # Sanitize the display name — strip path separators, cap length.
        origName = os.path.basename(
            php_strval(upload.get('name') if upload.get('name') is not None else 'file'))
        raw = origName.encode('utf-8', errors='replace')
        if len(raw) > 250:
            origName = raw[:250].decode('utf-8', errors='replace')

        try:
            id_ = self.db.insert(
                'INSERT INTO chat_attachments (user_id, original_name, stored_path, mime_type, size_bytes)\n'
                '                 VALUES (:uid, :name, :path, :mime, :size)',
                {
                    ':uid': userIdInt,
                    ':name': origName,
                    ':path': storedPath,
                    ':mime': detectedMime,
                    ':size': size,
                },
            )
            id_ = php_intval(id_)
        except Exception as e:  # noqa: BLE001
            # Roll back the disk write so we don't leak orphan files.
            try:
                os.unlink(storedPath)
            except OSError:
                pass
            error_log('[ChatAttachmentController] DB insert failed: ' + str(e))
            return {'success': False, 'error': 'Failed to record upload', 'status_code': 500}

        return {
            'success': True,
            'attachment': {
                'id': id_,
                'name': origName,
                'mime_type': detectedMime,
                'size': size,
            },
        }

    def _detectMime(self, path: str, filename: str) -> str:
        """Best-effort MIME detection using byte-sniffing (PHP: fileinfo), with a
        fallback to the filename extension for cases fileinfo is pessimistic
        about (markdown/csv, OOXML Office which fileinfo sees as generic zip).
        """
        mime = self._sniff(path)
        mime = mime.lower() if isinstance(mime, str) else None

        ext = os.path.splitext(filename)[1].lstrip('.').lower()

        # fileinfo frequently returns text/plain for md/csv/html/json —
        # refine based on extension when it's in the allowlist.
        if mime == 'text/plain' or mime == 'application/octet-stream' or mime is None:
            if ext == 'md':
                return 'text/markdown'
            if ext == 'csv':
                return 'text/csv'
            if ext == 'html':
                return 'text/html'
            if ext == 'json':
                return 'application/json'
            if ext == 'txt':
                return 'text/plain'

        # OOXML Office (docx/xlsx/pptx) are ZIP containers — fileinfo
        # identifies them as application/zip. Disambiguate by extension.
        if mime == 'application/zip' or mime == 'application/x-zip-compressed':
            if ext == 'docx':
                return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            if ext == 'xlsx':
                return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            if ext == 'pptx':
                return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

        # Legacy Office (CFB/OLE2) — fileinfo sees application/x-ole-storage
        # or similar; extension is the authoritative disambiguator.
        if (mime == 'application/x-ole-storage'
                or mime == 'application/cdfv2'
                or mime == 'application/cdfv2-corrupt'):
            if ext == 'doc':
                return 'application/msword'
            if ext == 'xls':
                return 'application/vnd.ms-excel'
            if ext == 'ppt':
                return 'application/vnd.ms-powerpoint'

        # Normalize image/jpg (occasional) to image/jpeg.
        if mime == 'image/jpg':
            return 'image/jpeg'

        return mime or 'application/octet-stream'

    @staticmethod
    def _sniff(path: str) -> str | None:
        """The byte sniffer standing in for PHP's `finfo`. Recognises every
        binary type in ALLOWED_MIME by signature; anything that decodes as text
        without NUL bytes goes to _sniffText (libmagic's text family: svg/xml/
        json/html/plain, which _detectMime then refines by extension exactly as
        PHP does), everything else `application/octet-stream`.
        """
        try:
            with open(path, 'rb') as fh:
                head = fh.read(4096)
        except OSError:
            return None
        if head == b'':
            return 'application/x-empty'
        for signature, mime in _MAGIC:
            if head.startswith(signature):
                return mime
        if head.startswith(b'RIFF') and head[8:12] == b'WEBP':
            return 'image/webp'
        if b'\x00' in head:
            return 'application/octet-stream'
        try:
            head.decode('utf-8')
        except UnicodeDecodeError:
            # A multibyte character may straddle the 4096-byte cut; only treat
            # the file as binary when the failure isn't at the very end.
            try:
                head[:-4].decode('utf-8')
            except UnicodeDecodeError:
                return 'application/octet-stream'
        return ChatAttachmentController._sniffText(head)

    @staticmethod
    def _sniffText(head: bytes) -> str:
        """libmagic's text-family classification, calibrated against the XAMPP
        php binary's `finfo` on this box:

            <svg …> / <?xml …?><svg …>   → image/svg+xml   (document must start with it)
            <?xml …?> (not svg)          → text/xml
            valid JSON (leading ws ok)   → application/json
            <html / <head / <body /
            <!DOCTYPE html anywhere      → text/html       (libmagic searches the block)
            anything else readable       → text/plain

        `image/svg+xml` and `text/xml` are NOT in ALLOWED_MIME and are not
        rescued by PHP's extension fallback (196-214), so such uploads 415 on
        both backends.
        """
        text = head.decode('utf-8', errors='replace')
        stripped = text.lstrip()
        low = stripped.lower()

        rest = low
        if low.startswith('<?xml'):
            end = low.find('?>')
            rest = low[end + 2:].lstrip() if end != -1 else ''
        if rest.startswith('<svg') or rest.startswith('<!doctype svg'):
            return 'image/svg+xml'
        if low.startswith('<?xml'):
            return 'text/xml'

        if stripped[:1] in ('{', '['):
            try:
                json.loads(stripped)
                return 'application/json'
            except ValueError:
                pass

        haystack = low[:4096]
        for token in ('<!doctype html', '<html', '<head', '<body'):
            if token in haystack:
                return 'text/html'

        return 'text/plain'

    @staticmethod
    def _uuidv4() -> str:
        return str(uuid.uuid4())
