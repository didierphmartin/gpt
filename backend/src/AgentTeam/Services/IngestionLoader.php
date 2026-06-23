<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The interpreter's file-read step: recursive list_files -> read_file ->
 * decode -> text. The PHP twin of the (compiler-side) ingestion_loader.py.
 *
 * The loader's job (per the execution-model spec): ENUMERATE the source — a
 * single file, or a folder walked RECURSIVELY through every nested subfolder —
 * and transform each file into plain TEXT for the next node (the splitter),
 * carrying the full path as provenance.
 *
 * Files are reached through the UniversalFS MCP server, but the two MCP tools
 * are INJECTED as callables so this class is unit-testable with no live server
 * and so MCPToolsLoader stays the single source of truth for how tools run:
 *
 *   listFiles(string $provider, string $path): array  // {"files":[{id,name,type}]}
 *   readFile(string $provider, string $fileId): string // raw bytes
 */
final class IngestionLoader
{
    /** Extension -> document type. Drives both the type filter and decode. */
    private const EXT_MAP = [
        'pdf'  => 'pdf',
        'docx' => 'word',
        'doc'  => 'word',
        'txt'  => 'text',
        'csv'  => 'csv',
        'html' => 'html',
        'htm'  => 'html',
    ];

    /** Map a filename / path to a document type, or null if unsupported. */
    public static function detectType(string $name): ?string
    {
        $dot = strrpos($name, '.');
        if ($dot === false) {
            return null;
        }
        $ext = strtolower(substr($name, $dot + 1));
        return self::EXT_MAP[$ext] ?? null;
    }

    /**
     * Decode raw file bytes to plain text. `$docType` of "auto" detects from
     * the extension.
     *
     * @throws \InvalidArgumentException on an unsupported / undetected type
     */
    public static function decode(string $name, string $data, string $docType = 'auto'): string
    {
        if ($docType === '' || $docType === 'auto') {
            $docType = self::detectType($name) ?? '';
        }

        switch ($docType) {
            case 'text':
            case 'csv':
                return $data;

            case 'pdf':
                return (new \Smalot\PdfParser\Parser())->parseContent($data)->getText();

            case 'word':
                return self::decodeDocx($data);

            case 'html':
                // HTML -> Markdown keeps headings/lists/links as readable text
                // (better for retrieval than flat tag-stripping); script/style
                // are dropped, unknown tags stripped.
                $converter = new \League\HTMLToMarkdown\HtmlConverter([
                    'strip_tags'   => true,
                    'remove_nodes' => 'script style',
                ]);
                return trim($converter->convert($data));

            default:
                throw new \InvalidArgumentException("unsupported file type for '{$name}'");
        }
    }

    /** Extract text from .docx bytes via the word/document.xml `<w:t>` runs. */
    private static function decodeDocx(string $data): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ufs_docx');
        file_put_contents($tmp, $data);
        $text = '';
        $zip = new \ZipArchive();
        if ($zip->open($tmp) === true) {
            $xml = $zip->getFromName('word/document.xml') ?: '';
            $zip->close();
            if (preg_match_all('/<w:t[^>]*>(.*?)<\/w:t>/s', $xml, $m)) {
                $text = implode('', array_map('html_entity_decode', $m[1]));
            }
        }
        @unlink($tmp);
        return $text;
    }

    /**
     * Enumerate the files the loader will process.
     *
     * The document type is always detected from the extension; `$allowedTypes`
     * is the loader form's CHECKBOX FILTER — the set of formats the user ticked
     * (e.g. ['pdf','word']). A file is kept only if its detected type is in that
     * set. An EMPTY set means "no restriction" — every supported type is kept.
     *
     * - Single file ($isDir=false): one descriptor, or none if its type is
     *   unsupported or filtered out.
     * - Folder ($isDir=true): RECURSIVELY walk every nested subfolder (any
     *   depth) via the injected $listFiles, keeping the files that pass the
     *   filter. Each descriptor's `source` is the full path. Symlink cycles are
     *   broken with a visited set; runaway depth is capped by $maxDepth.
     *
     * @param list<string> $allowedTypes ticked formats; [] = all supported
     * @return list<array{provider:string,file_id:string,name:string,source:string,doc_type:string}>
     */
    public static function enumerateFiles(
        callable $listFiles,
        string $provider,
        string $path,
        array $allowedTypes = [],
        bool $isDir = false,
        int $maxDepth = 64
    ): array {
        // The type to load a file as, or null if it should be skipped (either
        // unsupported, or not in the user's checkbox filter when one is set).
        $resolve = static function (string $name) use ($allowedTypes): ?string {
            $dt = self::detectType($name);
            if ($dt === null) {
                return null;
            }
            if ($allowedTypes !== [] && !in_array($dt, $allowedTypes, true)) {
                return null;
            }
            return $dt;
        };

        if (!$isDir) {
            $dt = $resolve(basename($path));
            if ($dt === null) {
                return [];
            }
            return [self::descriptor($provider, $path, basename($path), $dt)];
        }

        $out = [];
        $visited = [];

        $walk = function (string $folder, int $depth) use (
            &$walk, &$out, &$visited, $listFiles, $provider, $resolve, $maxDepth
        ): void {
            if ($depth > $maxDepth || isset($visited[$folder])) {
                return;
            }
            $visited[$folder] = true;
            $result = $listFiles($provider, $folder);
            foreach (($result['files'] ?? []) as $item) {
                $itemId = $item['id'] ?? null;
                $name = $item['name'] ?? ($itemId !== null ? basename($itemId) : '');
                if (($item['type'] ?? '') === 'folder') {
                    if ($itemId !== null) {
                        $walk($itemId, $depth + 1);
                    }
                } else {
                    $dt = $resolve($name);
                    if ($dt !== null && $itemId !== null) {
                        $out[] = self::descriptor($provider, $itemId, $name, $dt);
                    }
                }
            }
        };

        $walk($path, 0);
        return $out;
    }

    /**
     * @return array{provider:string,file_id:string,name:string,source:string,doc_type:string}
     */
    private static function descriptor(string $provider, string $fileId, string $name, string $docType): array
    {
        return [
            'provider' => $provider,
            'file_id'  => $fileId,
            'name'     => $name,
            'source'   => $fileId,   // full path = provenance for the store metadata
            'doc_type' => $docType,
        ];
    }

    /**
     * Read one enumerated file via the injected $readFile.
     *
     * The reader (langfs) already returns extracted TEXT, so no decode step is
     * needed — running decode() on already-text would mis-parse (e.g. treat a
     * PDF's extracted text as raw PDF bytes). decode() is retained for the legacy
     * base64/bytes path but is no longer used here.
     *
     * @param array{provider:string,file_id:string,name:string,doc_type:string} $descriptor
     */
    public static function loadFile(callable $readFile, array $descriptor): string
    {
        return $readFile($descriptor['provider'], $descriptor['file_id']);
    }

    /**
     * The loader's iterator: yield ['text' => ..., 'source' => ...] for each
     * file, reading + decoding lazily so the store can clock the loop one file
     * at a time.
     *
     * @param list<string> $allowedTypes ticked formats; [] = all supported
     * @return \Generator<int,array{text:string,source:string}>
     */
    public static function loadDocuments(
        callable $listFiles,
        callable $readFile,
        string $provider,
        string $path,
        array $allowedTypes = [],
        bool $isDir = false
    ): \Generator {
        foreach (self::enumerateFiles($listFiles, $provider, $path, $allowedTypes, $isDir) as $desc) {
            yield ['text' => self::loadFile($readFile, $desc), 'source' => $desc['source']];
        }
    }

    /**
     * Run ONE round of the loader: enumerate the source (cheap list walk), then
     * read + decode just the file at `$cursor` — the per-round semantics of the
     * interpreter (the store clocks the loop, one file fully to the end before
     * the next). The loader's Output tab shows this one file's text, refreshed
     * each round; the full event loop will drive the same `$cursor` forward.
     *
     * Returns the ordered `sources` so the caller can show "file k of N" and
     * step without re-deriving the list. `$cursor` out of range → no `current`
     * (exhausted). A decode failure surfaces as `current.error`.
     *
     * @param list<string> $allowedTypes
     * @return array{count:int,cursor:int,sources:list<string>,current:?array<string,mixed>}
     */
    public static function readRound(
        callable $listFiles,
        callable $readFile,
        string $provider,
        string $path,
        array $allowedTypes = [],
        bool $isDir = false,
        int $cursor = 0,
        int $maxChars = 20000
    ): array {
        $descs = self::enumerateFiles($listFiles, $provider, $path, $allowedTypes, $isDir);
        $count = count($descs);
        $sources = array_map(static fn(array $d): string => $d['source'], $descs);

        if ($count === 0 || $cursor < 0 || $cursor >= $count) {
            return ['count' => $count, 'cursor' => $cursor, 'sources' => $sources, 'current' => null];
        }

        $desc = $descs[$cursor];
        try {
            $text = self::loadFile($readFile, $desc);
            $chars = mb_strlen($text);
            $clipped = $chars > $maxChars;
            $current = [
                'source'  => $desc['source'],
                'type'    => $desc['doc_type'],
                'chars'   => $chars,
                'text'    => $clipped ? mb_substr($text, 0, $maxChars) : $text,
                'clipped' => $clipped,
            ];
        } catch (\Throwable $e) {
            $current = ['source' => $desc['source'], 'type' => $desc['doc_type'], 'error' => $e->getMessage()];
        }

        return ['count' => $count, 'cursor' => $cursor, 'sources' => $sources, 'current' => $current];
    }
}
