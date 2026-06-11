<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use PDO;
use Smalot\PdfParser\Parser as PdfParser;
use PhpOffice\PhpWord\IOFactory as WordIOFactory;
use PhpOffice\PhpSpreadsheet\IOFactory as SpreadsheetIOFactory;
use PhpOffice\PhpPresentation\IOFactory as PresentationIOFactory;
use Throwable;

/**
 * Attachment Dispatcher
 *
 * Loads chat_attachments rows by id (with ownership check), reads bytes from
 * disk, and turns them into a chunk of text suitable for prepending to a
 * chat message — plus routes images and (for some providers) PDFs to native
 * provider dispatch.
 *
 * As of 2026-05-08, the FRONTEND attachment-converter (Pyodide-based, in
 * frontend/assets/js/attachment-converter.js) is the primary path for binary
 * docs (.docx/.pptx/.xlsx/.pdf). It runs in the browser, produces Markdown,
 * and prepends it to the outgoing message text BEFORE the request reaches
 * this dispatcher. Phase 3 of chat.js strips converted attachment IDs from
 * `attachment_ids`, so under normal operation this dispatcher only sees:
 *
 *   - image attachments → native per-provider dispatch (image_attachments)
 *   - PDFs on native-PDF providers → native dispatch (pdf_attachments)
 *   - text-native files (txt/md/csv/json/html) → read verbatim
 *
 * The phpoffice/* and smalot/pdfparser library paths in extractText() are
 * retained as a safety net for legacy / non-converter-aware clients (stale
 * cached JS, direct API callers, future paths). They are no longer the
 * primary extraction route. Workflow node remote docs still use the PDF
 * path here; that migration is a separate follow-up.
 */
class AttachmentDispatcher
{
    private PDO $db;

    /** Cap each attachment's extracted text to keep request budgets sane. */
    private const MAX_TEXT_PER_FILE = 100_000; // characters

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Providers that can ingest PDFs natively (preserving charts/figures)
     * via inline base64 in the message body. For these, the dispatcher hands
     * the raw bytes off in `pdf_attachments`; for others it falls back to
     * server-side text extraction so the LLM still sees the document content.
     */
    private const NATIVE_PDF_PROVIDERS = ['claude', 'gemini', 'openai'];

    /**
     * Build the per-request attachment payload.
     *
     * Routes each attachment by MIME and the active provider:
     *  - Images → `image_attachments` (always native).
     *  - PDF + provider supports native PDF (Claude, Gemini) → `pdf_attachments`.
     *  - PDF + other provider → text-extracted into `prefix` (current behaviour).
     *  - Office / text family → text-extracted into `prefix`.
     *
     * @param array<int> $attachmentIds
     * @param int $userId Owner check — only attachments belonging to this
     *                    user are loaded; foreign ids are silently skipped.
     * @param string|null $provider Active provider name (e.g. "claude"). Used
     *                              to decide PDF routing; null falls back to
     *                              text extraction for everything.
     * @return array{prefix: string, image_attachments: array<int,array{mime_type:string,data:string,name:string}>, pdf_attachments: array<int,array{mime_type:string,data:string,name:string}>, notes: array<string>}
     */
    public function buildPrefix(array $attachmentIds, int $userId, ?string $provider = null, bool $skillModeActive = false): array
    {
        $attachmentIds = array_values(array_filter(
            array_map('intval', $attachmentIds),
            fn($id) => $id > 0,
        ));
        // DIAGNOSTIC: confirm that the elision branch will or won't fire.
        // We've seen test cases where skill_metadata was set in the request
        // but the user_msg_len at the provider was huge (78K+) — which can
        // only happen if skillModeActive=false reached this dispatcher
        // (elision skipped) or some other code path is inlining the doc.
        // This log nails which.
        error_log("[AttachmentDispatcher] buildPrefix called — attachment_count: "
            . count($attachmentIds) . ", provider: " . ($provider ?? 'null')
            . ", skillModeActive: " . ($skillModeActive ? 'true (will elide)' : 'false (will inline)'));
        if (empty($attachmentIds)) {
            return ['prefix' => '', 'image_attachments' => [], 'pdf_attachments' => [], 'notes' => []];
        }

        $placeholders = implode(',', array_fill(0, count($attachmentIds), '?'));
        $sql = "SELECT id, original_name, stored_path, mime_type, size_bytes
                FROM chat_attachments
                WHERE user_id = ? AND deleted_at IS NULL AND id IN ($placeholders)";
        $stmt = $this->db->prepare($sql);
        $stmt->execute(array_merge([$userId], $attachmentIds));
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if (empty($rows)) {
            return ['prefix' => '', 'image_attachments' => [], 'pdf_attachments' => [], 'notes' => []];
        }

        $supportsNativePdf = $provider !== null
            && in_array(strtolower($provider), self::NATIVE_PDF_PROVIDERS, true);

        $blocks = [];
        $images = [];
        $pdfs = [];
        $notes = [];
        foreach ($rows as $row) {
            $name = (string) $row['original_name'];
            $mime = (string) $row['mime_type'];
            $path = (string) $row['stored_path'];

            if (!is_file($path)) {
                $notes[] = "Attachment '{$name}' missing on disk; skipped.";
                continue;
            }

            // Images: read bytes, base64-encode, hand off for per-provider
            // native dispatch via $options['image_attachments'].
            if (str_starts_with($mime, 'image/')) {
                $bytes = @file_get_contents($path);
                if ($bytes === false) {
                    $notes[] = "Image '{$name}' could not be read; skipped.";
                    continue;
                }
                $images[] = [
                    'mime_type' => $mime,
                    'data' => base64_encode($bytes),
                    'name' => $name,
                ];
                continue;
            }

            // PDFs: if the active provider supports native PDF, hand the bytes
            // off so charts/figures/diagrams survive (text extraction would
            // lose them). Otherwise fall through to extractText below.
            if ($mime === 'application/pdf' && $supportsNativePdf) {
                $bytes = @file_get_contents($path);
                if ($bytes === false) {
                    $notes[] = "PDF '{$name}' could not be read; skipped.";
                    continue;
                }
                $pdfs[] = [
                    'mime_type' => $mime,
                    'data' => base64_encode($bytes),
                    'name' => $name,
                ];
                continue;
            }

            // Skill-mode short-reference: when a folder-backed skill is the
            // expected handler for this turn (skill_metadata set or
            // available_skills non-empty), the attachment is also pre-written
            // to /scratch/<filename> by the frontend's B3 dispatch and read
            // by the script directly. Inlining the full text here is then
            // pure waste: a 78 KB HTML adds ~20K input tokens on every turn,
            // tempts the model to inline-respond instead of calling the
            // skill, and makes the auto-routing decision noisier. Replace
            // the body with a short reference + size hint; the skill catalog
            // (in the run_skill_script tool description) tells the model
            // which skill to call to actually process the file.
            if ($skillModeActive) {
                $sizeBytes = (int) ($row['size_bytes'] ?? 0);
                $blocks[] = "### {$name} ({$sizeBytes} bytes, mime: {$mime})\n"
                    . "[Pre-staged at /scratch/{$name} for skill-script access. "
                    . "Pass this path to run_skill_script via argv (e.g. -i /scratch/{$name}). "
                    . "Full content NOT inlined here to save tokens.]";
                continue;
            }

            try {
                $text = $this->extractText($path, $mime);
            } catch (Throwable $e) {
                error_log("[AttachmentDispatcher] Extract failed for {$name}: " . $e->getMessage());
                $notes[] = "Could not read '{$name}'; skipped.";
                continue;
            }

            $text = $this->truncate($text);
            if ($text === '') {
                $notes[] = "Attachment '{$name}' contained no readable text; skipped.";
                continue;
            }

            $blocks[] = "### {$name}\n{$text}";
        }

        $prefix = '';
        if (!empty($blocks)) {
            $header = $skillModeActive
                ? "[The user attached the following document(s). They are pre-staged on the script filesystem under /scratch/ — call run_skill_script with the appropriate path in argv to process them.]\n\n"
                : "[The user attached the following document(s); use them as authoritative context for the message that follows.]\n\n";
            $prefix = $header
                . implode("\n\n---\n\n", $blocks)
                . "\n\n---\n\n";
        }

        return [
            'prefix' => $prefix,
            'image_attachments' => $images,
            'pdf_attachments' => $pdfs,
            'notes' => $notes,
        ];
    }

    /**
     * Pull text from the file. PDF via smalot/pdfparser; Office docs via the
     * phpoffice/* family; everything else read verbatim as UTF-8.
     *
     * NOTE: this is now a fallback path. The frontend attachment-converter
     * normally handles all binary formats client-side and strips their IDs
     * from `attachment_ids` before the request hits this class. Under normal
     * operation, the office-format branches below only run for legacy
     * clients (stale cached JS) or non-UI API callers.
     */
    private function extractText(string $path, string $mime): string
    {
        if ($mime === 'application/pdf') {
            $parser = new PdfParser();
            $pdf = $parser->parseFile($path);
            return trim($pdf->getText());
        }

        if ($mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            || $mime === 'application/msword') {
            return $this->extractDocxText($path, $mime);
        }

        if ($mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            || $mime === 'application/vnd.ms-excel') {
            return $this->extractXlsxText($path);
        }

        if ($mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            || $mime === 'application/vnd.ms-powerpoint') {
            return $this->extractPptxText($path, $mime);
        }

        // Plain-text family. file_get_contents handles them all uniformly;
        // we trust the upload-time MIME allowlist to keep this safe.
        $bytes = @file_get_contents($path);
        if ($bytes === false) return '';
        // Strip BOM if present.
        if (str_starts_with($bytes, "\xEF\xBB\xBF")) {
            $bytes = substr($bytes, 3);
        }
        return $bytes;
    }

    /**
     * Extract text from DOCX (or legacy DOC) via phpoffice/phpword.
     * Walks the section tree and stitches Text/TextRun/ListItem/Table content
     * together into a readable paragraph stream. Images are not extracted.
     */
    private function extractDocxText(string $path, string $mime): string
    {
        $reader = $mime === 'application/msword' ? 'MsDoc' : 'Word2007';
        $phpWord = WordIOFactory::load($path, $reader);

        $out = [];
        foreach ($phpWord->getSections() as $section) {
            foreach ($section->getElements() as $element) {
                $txt = $this->walkWordElement($element);
                if ($txt !== '') $out[] = $txt;
            }
        }
        return trim(implode("\n", $out));
    }

    /**
     * Recursive walker for PhpWord element tree. Handles the common leaf
     * elements (Text, TextRun, ListItem, Link, Title) plus Table/TableRow/
     * TableCell/Section containers.
     */
    private function walkWordElement($el): string
    {
        if ($el instanceof \PhpOffice\PhpWord\Element\Text) {
            return (string) $el->getText();
        }
        if ($el instanceof \PhpOffice\PhpWord\Element\Link) {
            return (string) $el->getText();
        }
        if ($el instanceof \PhpOffice\PhpWord\Element\Title) {
            return (string) $el->getText();
        }
        if ($el instanceof \PhpOffice\PhpWord\Element\ListItem) {
            return '- ' . $el->getTextObject()->getText();
        }
        if ($el instanceof \PhpOffice\PhpWord\Element\TextRun) {
            $parts = [];
            foreach ($el->getElements() as $child) {
                $parts[] = $this->walkWordElement($child);
            }
            return trim(implode('', $parts));
        }
        if ($el instanceof \PhpOffice\PhpWord\Element\Table) {
            $rows = [];
            foreach ($el->getRows() as $row) {
                $cells = [];
                foreach ($row->getCells() as $cell) {
                    $cellText = [];
                    foreach ($cell->getElements() as $child) {
                        $cellText[] = $this->walkWordElement($child);
                    }
                    $cells[] = trim(implode(' ', $cellText));
                }
                $rows[] = '| ' . implode(' | ', $cells) . ' |';
            }
            return implode("\n", $rows);
        }
        return '';
    }

    /**
     * Extract data from XLSX (or legacy XLS) via phpoffice/phpspreadsheet.
     * Each sheet becomes a markdown-style table; the first row is treated as
     * a header. Empty cells are omitted from the stream.
     */
    private function extractXlsxText(string $path): string
    {
        $spreadsheet = SpreadsheetIOFactory::load($path);
        $out = [];

        foreach ($spreadsheet->getAllSheets() as $sheet) {
            $title = $sheet->getTitle();
            $rows = $sheet->toArray(null, true, true, false);
            if (empty($rows)) continue;

            $out[] = "## Sheet: {$title}";
            foreach ($rows as $i => $row) {
                // Skip completely-empty rows.
                $nonEmpty = array_filter($row, fn($v) => $v !== null && $v !== '');
                if (empty($nonEmpty)) continue;

                $cells = array_map(fn($v) => (string)($v ?? ''), $row);
                $out[] = '| ' . implode(' | ', $cells) . ' |';
                // Insert a separator after the first non-empty row (markdown header).
                if ($i === 0 && count($out) > 1) {
                    $out[] = '| ' . implode(' | ', array_fill(0, count($cells), '---')) . ' |';
                }
            }
            $out[] = '';
        }
        return trim(implode("\n", $out));
    }

    /**
     * Extract text from PPTX via phpoffice/phppresentation. Walks slides and
     * extracts RichText elements. Images/shapes with no text are skipped.
     */
    private function extractPptxText(string $path, string $mime): string
    {
        // PhpPresentation currently only has a PowerPoint2007 reader in stable
        // releases; legacy .ppt would need a different tool. We still accept
        // the upload but return empty for .ppt, letting the dispatcher emit
        // a "no readable text" note.
        if ($mime === 'application/vnd.ms-powerpoint') {
            return '';
        }

        $reader = PresentationIOFactory::createReader('PowerPoint2007');
        $pres = $reader->load($path);

        $out = [];
        foreach ($pres->getAllSlides() as $i => $slide) {
            $slideNum = $i + 1;
            $lines = [];
            foreach ($slide->getShapeCollection() as $shape) {
                if ($shape instanceof \PhpOffice\PhpPresentation\Shape\RichText) {
                    foreach ($shape->getParagraphs() as $p) {
                        $t = trim((string) $p->getPlainText());
                        if ($t !== '') $lines[] = $t;
                    }
                }
            }
            if (!empty($lines)) {
                $out[] = "## Slide {$slideNum}\n" . implode("\n", $lines);
            }
        }
        return trim(implode("\n\n", $out));
    }

    private function truncate(string $text): string
    {
        if (mb_strlen($text) <= self::MAX_TEXT_PER_FILE) {
            return $text;
        }
        return mb_substr($text, 0, self::MAX_TEXT_PER_FILE)
            . "\n\n[…document truncated at " . self::MAX_TEXT_PER_FILE . " characters…]";
    }
}
