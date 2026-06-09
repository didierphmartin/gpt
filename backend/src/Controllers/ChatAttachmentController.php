<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;
use Exception;

/**
 * Chat Attachment Controller
 *
 * Accepts files uploaded by the user via the chat prompt's attach button or
 * drag-drop. Stores bytes to disk (backend/storage/chat-uploads/<userId>/<uuid>)
 * and metadata to the `chat_attachments` table. Returns a numeric id the
 * frontend sends alongside the next chat message so ChatController can load
 * the file and forward it in provider-specific shape (PDF block for Claude,
 * inline_data for Gemini, Files API upload for Grok/Kimi, etc.).
 *
 * This controller only handles storage. Per-provider dispatch is Phase 3.
 */
class ChatAttachmentController
{
    /**
     * MIME allowlist. Office formats (docx/xlsx/pptx + legacy doc/xls) are
     * accepted. As of 2026-05-08 the frontend attachment-converter (Pyodide)
     * is the primary text-extraction path; AttachmentDispatcher's phpoffice
     * branches are kept as a fallback for legacy clients.
     */
    private const ALLOWED_MIME = [
        'application/pdf'                                                         => 'pdf',
        'image/png'                                                               => 'png',
        'image/jpeg'                                                              => 'jpg',
        'image/webp'                                                              => 'webp',
        'image/gif'                                                               => 'gif',
        'text/plain'                                                              => 'txt',
        'text/markdown'                                                           => 'md',
        'text/csv'                                                                => 'csv',
        'text/html'                                                               => 'html',
        'application/json'                                                        => 'json',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
        'application/msword'                                                      => 'doc',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'       => 'xlsx',
        'application/vnd.ms-excel'                                                => 'xls',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' => 'pptx',
        'application/vnd.ms-powerpoint'                                           => 'ppt',
    ];

    /**
     * Hard ceiling on a single upload. Per-package caps can narrow this
     * further in a future phase (capabilities.max_upload_mb).
     */
    private const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

    private PDO $db;
    private string $storageRoot;

    public function __construct(PDO $db, array $_config)
    {
        $this->db = $db;
        $this->storageRoot = realpath(__DIR__ . '/../../storage/chat-uploads')
            ?: __DIR__ . '/../../storage/chat-uploads';
    }

    /**
     * POST /api/v1/chat/upload  (multipart/form-data)
     * Field: `file` (single) — we accept one upload at a time; the frontend
     * POSTs once per selected/dropped file so per-file errors don't take the
     * whole batch down.
     */
    public function upload(array $request): array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId || !is_numeric($userId)) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        $userIdInt = (int) $userId;

        if (empty($_FILES['file']) || !is_array($_FILES['file'])) {
            return ['success' => false, 'error' => 'No file field', 'status_code' => 400];
        }

        $upload = $_FILES['file'];
        if (($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            return [
                'success' => false,
                'error' => 'Upload failed (error code ' . (int)$upload['error'] . ')',
                'status_code' => 400,
            ];
        }

        $size = (int)($upload['size'] ?? 0);
        if ($size <= 0) {
            return ['success' => false, 'error' => 'Empty file', 'status_code' => 400];
        }
        if ($size > self::MAX_BYTES) {
            return [
                'success' => false,
                'error' => 'File exceeds ' . (self::MAX_BYTES / 1024 / 1024) . ' MB limit',
                'status_code' => 413,
            ];
        }

        // Detect the real MIME from the bytes (not from the browser-supplied
        // type, which can be spoofed or misreported).
        $tmpPath = $upload['tmp_name'] ?? '';
        if (!$tmpPath || !is_file($tmpPath)) {
            return ['success' => false, 'error' => 'Temporary upload file missing', 'status_code' => 500];
        }
        $detectedMime = $this->detectMime($tmpPath, (string)($upload['name'] ?? ''));
        if (!isset(self::ALLOWED_MIME[$detectedMime])) {
            return [
                'success' => false,
                'error' => "Unsupported file type: {$detectedMime}. "
                    . "Allowed: PDF, PNG/JPEG/WebP/GIF, plain text, Markdown, CSV, HTML, JSON. "
                    . "(Office documents will be supported in a later release.)",
                'status_code' => 415,
            ];
        }

        // Build per-user storage directory.
        $userDir = $this->storageRoot . '/' . $userIdInt;
        if (!is_dir($userDir)) {
            if (!@mkdir($userDir, 0755, true) && !is_dir($userDir)) {
                return ['success' => false, 'error' => 'Storage init failed', 'status_code' => 500];
            }
        }

        $uuid = $this->uuidv4();
        $ext = self::ALLOWED_MIME[$detectedMime];
        $storedName = $uuid . '.' . $ext;
        $storedPath = $userDir . '/' . $storedName;

        if (!move_uploaded_file($tmpPath, $storedPath)) {
            return ['success' => false, 'error' => 'Failed to persist upload', 'status_code' => 500];
        }

        // Sanitize the display name — strip path separators, cap length.
        $origName = basename((string)($upload['name'] ?? 'file'));
        if (strlen($origName) > 250) {
            $origName = substr($origName, 0, 250);
        }

        try {
            $stmt = $this->db->prepare(
                'INSERT INTO chat_attachments (user_id, original_name, stored_path, mime_type, size_bytes)
                 VALUES (:uid, :name, :path, :mime, :size)'
            );
            $stmt->execute([
                ':uid' => $userIdInt,
                ':name' => $origName,
                ':path' => $storedPath,
                ':mime' => $detectedMime,
                ':size' => $size,
            ]);
            $id = (int) $this->db->lastInsertId();
        } catch (Exception $e) {
            // Roll back the disk write so we don't leak orphan files.
            @unlink($storedPath);
            error_log('[ChatAttachmentController] DB insert failed: ' . $e->getMessage());
            return ['success' => false, 'error' => 'Failed to record upload', 'status_code' => 500];
        }

        return [
            'success' => true,
            'attachment' => [
                'id' => $id,
                'name' => $origName,
                'mime_type' => $detectedMime,
                'size' => $size,
            ],
        ];
    }

    /**
     * Best-effort MIME detection using fileinfo (byte-sniffing), with a
     * fallback to the filename extension for cases fileinfo is pessimistic
     * about (markdown/csv, OOXML Office which fileinfo sees as generic zip).
     */
    private function detectMime(string $path, string $filename): string
    {
        $mime = null;
        if (function_exists('finfo_open')) {
            $finfo = @finfo_open(FILEINFO_MIME_TYPE);
            if ($finfo) {
                $mime = @finfo_file($finfo, $path) ?: null;
                @finfo_close($finfo);
            }
        }
        $mime = is_string($mime) ? strtolower($mime) : null;

        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

        // fileinfo frequently returns text/plain for md/csv/html/json —
        // refine based on extension when it's in the allowlist.
        if ($mime === 'text/plain' || $mime === 'application/octet-stream' || $mime === null) {
            switch ($ext) {
                case 'md':   return 'text/markdown';
                case 'csv':  return 'text/csv';
                case 'html': return 'text/html';
                case 'json': return 'application/json';
                case 'txt':  return 'text/plain';
            }
        }

        // OOXML Office (docx/xlsx/pptx) are ZIP containers — fileinfo
        // identifies them as application/zip. Disambiguate by extension.
        if ($mime === 'application/zip' || $mime === 'application/x-zip-compressed') {
            switch ($ext) {
                case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
            }
        }

        // Legacy Office (CFB/OLE2) — fileinfo sees application/x-ole-storage
        // or similar; extension is the authoritative disambiguator.
        if ($mime === 'application/x-ole-storage'
            || $mime === 'application/cdfv2'
            || $mime === 'application/cdfv2-corrupt') {
            switch ($ext) {
                case 'doc': return 'application/msword';
                case 'xls': return 'application/vnd.ms-excel';
                case 'ppt': return 'application/vnd.ms-powerpoint';
            }
        }

        // Normalize image/jpg (occasional) to image/jpeg.
        if ($mime === 'image/jpg') return 'image/jpeg';

        return $mime ?: 'application/octet-stream';
    }

    private function uuidv4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
