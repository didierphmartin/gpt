<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Pure-PHP recursive character text splitter — the interpreter's splitter node.
 *
 * A faithful port of langchain's RecursiveCharacterTextSplitter algorithm (the
 * same one vendored to Python in langchain_runner/ingestion_splitter.py, which
 * is parity-tested against langchain). Output is intended to match
 * `RecursiveCharacterTextSplitter(chunk_size, chunk_overlap).split_text(text)`
 * with library defaults: keep_separator="start", is_separator_regex=False,
 * strip_whitespace=True, length_function=len (code points → mb_strlen).
 *
 * The two lowerings stay faithful: the compiler emits the Python splitter, the
 * interpreter runs this PHP port — same chunks either way.
 */
final class IngestionSplitter
{
    private const DEFAULT_SEPARATORS = ["\n\n", "\n", " ", ""];

    /**
     * Split text into chunks. Mirrors recursive_split() in the Python vendor.
     *
     * @return list<string>
     * @throws \InvalidArgumentException when overlap > chunkSize
     */
    public static function recursiveSplit(string $text, int $chunkSize = 1000, int $overlap = 150): array
    {
        if ($overlap > $chunkSize) {
            throw new \InvalidArgumentException(
                "Got a larger chunk overlap ({$overlap}) than chunk size ({$chunkSize}), should be smaller."
            );
        }
        return self::splitText($text, self::DEFAULT_SEPARATORS, $chunkSize, $overlap);
    }

    /** Code-point length (matches Python len() on str). */
    private static function len(string $s): int
    {
        return mb_strlen($s, 'UTF-8');
    }

    /**
     * Mirrors _split_text_with_regex with keep_separator truthy ("start"):
     * each separator is attached to the piece that FOLLOWS it. `$sepEscaped` is
     * an already-quoted regex (or '' for character split).
     *
     * @return list<string>
     */
    private static function splitWithRegex(string $text, string $sepEscaped): array
    {
        if ($sepEscaped !== '') {
            $parts = preg_split('/(' . $sepEscaped . ')/u', $text, -1, PREG_SPLIT_DELIM_CAPTURE);
            $parts = $parts === false ? [$text] : $parts;
            $splits = [];
            for ($i = 1, $n = count($parts); $i < $n; $i += 2) {
                $splits[] = $parts[$i] . ($parts[$i + 1] ?? '');
            }
            if (count($parts) % 2 === 0) {
                $splits[] = $parts[count($parts) - 1];
            }
            array_unshift($splits, $parts[0]);
        } else {
            $splits = mb_str_split($text, 1, 'UTF-8');
        }
        return array_values(array_filter($splits, static fn(string $s): bool => $s !== ''));
    }

    /** Mirrors _join_docs (separator-join + optional strip; '' → null). */
    private static function joinDocs(array $docs, string $separator): ?string
    {
        $text = trim(implode($separator, $docs));
        return $text === '' ? null : $text;
    }

    /**
     * Mirrors TextSplitter._merge_splits (length_function = len). With the
     * default keep_separator the merge separator is '' (separator_len 0).
     *
     * @param list<string> $splits
     * @return list<string>
     */
    private static function mergeSplits(array $splits, string $separator, int $chunkSize, int $chunkOverlap): array
    {
        $separatorLen = self::len($separator);
        $docs = [];
        $currentDoc = [];
        $total = 0;

        foreach ($splits as $d) {
            $lenD = self::len($d);
            if ($total + $lenD + (count($currentDoc) > 0 ? $separatorLen : 0) > $chunkSize) {
                if (count($currentDoc) > 0) {
                    $doc = self::joinDocs($currentDoc, $separator);
                    if ($doc !== null) {
                        $docs[] = $doc;
                    }
                    while (
                        $total > $chunkOverlap
                        || ($total + $lenD + (count($currentDoc) > 0 ? $separatorLen : 0) > $chunkSize && $total > 0)
                    ) {
                        $total -= self::len($currentDoc[0]) + (count($currentDoc) > 1 ? $separatorLen : 0);
                        array_shift($currentDoc);
                    }
                }
            }
            $currentDoc[] = $d;
            $total += $lenD + (count($currentDoc) > 1 ? $separatorLen : 0);
        }

        $doc = self::joinDocs($currentDoc, $separator);
        if ($doc !== null) {
            $docs[] = $doc;
        }
        return $docs;
    }

    /**
     * Mirrors RecursiveCharacterTextSplitter._split_text (is_separator_regex=False).
     *
     * @param list<string> $separators
     * @return list<string>
     */
    private static function splitText(string $text, array $separators, int $chunkSize, int $chunkOverlap): array
    {
        $finalChunks = [];

        // Choose the separator: the last, unless an earlier one occurs in text.
        $separator = $separators[count($separators) - 1];
        $newSeparators = [];
        foreach ($separators as $i => $s) {
            $sEscaped = preg_quote($s, '/');
            if ($s === '') {
                $separator = $s;
                break;
            }
            if (preg_match('/' . $sEscaped . '/u', $text) === 1) {
                $separator = $s;
                $newSeparators = array_slice($separators, $i + 1);
                break;
            }
        }

        $sepEscaped = preg_quote($separator, '/');
        $splits = self::splitWithRegex($text, $sepEscaped);

        // Merge short pieces; recurse into pieces still longer than chunk_size.
        $goodSplits = [];
        $mergeSeparator = ''; // keep_separator => merge with ''
        foreach ($splits as $s) {
            if (self::len($s) < $chunkSize) {
                $goodSplits[] = $s;
            } else {
                if ($goodSplits) {
                    $merged = self::mergeSplits($goodSplits, $mergeSeparator, $chunkSize, $chunkOverlap);
                    array_push($finalChunks, ...$merged);
                    $goodSplits = [];
                }
                if (!$newSeparators) {
                    $finalChunks[] = $s;
                } else {
                    $other = self::splitText($s, $newSeparators, $chunkSize, $chunkOverlap);
                    array_push($finalChunks, ...$other);
                }
            }
        }
        if ($goodSplits) {
            $merged = self::mergeSplits($goodSplits, $mergeSeparator, $chunkSize, $chunkOverlap);
            array_push($finalChunks, ...$merged);
        }
        return $finalChunks;
    }
}
