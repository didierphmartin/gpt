/**
 * Faithful TypeScript mirror of src/AgentTeam/Services/IngestionSplitter.php.
 *
 * Pure recursive character text splitter — a port of langchain's
 * RecursiveCharacterTextSplitter with library defaults: keep_separator="start",
 * is_separator_regex=False, strip_whitespace=True, length_function=len (code
 * points). The chunking boundaries/overlap math must match the PHP byte-for-byte
 * because it determines exactly what text gets embedded.
 *
 * All methods are static, mirroring the PHP `final class`.
 */

const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];

/** PHP trim(): strips " \t\n\r\0\x0B" from both ends. */
const PHP_WS = ' \t\n\r\0\x0B';
function phpTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PHP_WS.indexOf(s[start]) !== -1) start++;
  while (end > start && PHP_WS.indexOf(s[end - 1]) !== -1) end--;
  return s.slice(start, end);
}

/**
 * PHP preg_quote($str, '/'): escape regex metacharacters plus the delimiter.
 * Applied only to the fixed DEFAULT_SEPARATORS in practice, but implemented
 * faithfully. The special set matches PHP's preg_quote.
 */
function pregQuote(str: string, delimiter = '/'): string {
  const special = '.\\+*?[^]$(){}=!<>|:-#';
  let out = '';
  for (const ch of str) {
    if (ch === '\0') {
      out += '\\000';
    } else if (special.indexOf(ch) !== -1 || ch === delimiter) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

export class IngestionSplitter {
  /**
   * Split text into chunks. Mirrors recursiveSplit() in the PHP.
   * @throws Error when overlap > chunkSize
   */
  static recursiveSplit(text: string, chunkSize = 1000, overlap = 150): string[] {
    if (overlap > chunkSize) {
      throw new Error(
        `Got a larger chunk overlap (${overlap}) than chunk size (${chunkSize}), should be smaller.`
      );
    }
    return IngestionSplitter.splitText(text, DEFAULT_SEPARATORS, chunkSize, overlap);
  }

  /** Code-point length (matches Python len() on str / PHP mb_strlen). */
  private static len(s: string): number {
    let n = 0;
    // for..of iterates by Unicode code point, matching mb_strlen(..,'UTF-8').
    for (const _ of s) n++;
    return n;
  }

  /**
   * Mirrors _split_text_with_regex with keep_separator="start": each separator
   * is attached to the piece that FOLLOWS it. `sepEscaped` is an already-quoted
   * regex (or '' for character split).
   */
  private static splitWithRegex(text: string, sepEscaped: string): string[] {
    let splits: string[];
    if (sepEscaped !== '') {
      // PHP preg_split('/(sep)/u', text, -1, PREG_SPLIT_DELIM_CAPTURE): the
      // captured delimiters are interleaved in the result — JS split with a
      // capturing group does the same.
      let parts: string[];
      try {
        parts = text.split(new RegExp('(' + sepEscaped + ')', 'u'));
      } catch {
        parts = [text];
      }
      splits = [];
      const n = parts.length;
      for (let i = 1; i < n; i += 2) {
        splits.push(parts[i] + (parts[i + 1] !== undefined ? parts[i + 1] : ''));
      }
      if (parts.length % 2 === 0) {
        splits.push(parts[parts.length - 1]);
      }
      splits.unshift(parts[0]);
    } else {
      // mb_str_split($text, 1, 'UTF-8') — one entry per code point.
      splits = Array.from(text);
    }
    return splits.filter((s) => s !== '');
  }

  /** Mirrors _join_docs (separator-join + trim; '' → null). */
  private static joinDocs(docs: string[], separator: string): string | null {
    const text = phpTrim(docs.join(separator));
    return text === '' ? null : text;
  }

  /**
   * Mirrors TextSplitter._merge_splits (length_function = len). With the default
   * keep_separator the merge separator is '' (separator_len 0).
   */
  private static mergeSplits(
    splits: string[],
    separator: string,
    chunkSize: number,
    chunkOverlap: number
  ): string[] {
    const separatorLen = IngestionSplitter.len(separator);
    const docs: string[] = [];
    const currentDoc: string[] = [];
    let total = 0;

    for (const d of splits) {
      const lenD = IngestionSplitter.len(d);
      if (total + lenD + (currentDoc.length > 0 ? separatorLen : 0) > chunkSize) {
        if (currentDoc.length > 0) {
          const doc = IngestionSplitter.joinDocs(currentDoc, separator);
          if (doc !== null) {
            docs.push(doc);
          }
          while (
            total > chunkOverlap ||
            (total + lenD + (currentDoc.length > 0 ? separatorLen : 0) > chunkSize && total > 0)
          ) {
            total -= IngestionSplitter.len(currentDoc[0]) + (currentDoc.length > 1 ? separatorLen : 0);
            currentDoc.shift();
          }
        }
      }
      currentDoc.push(d);
      total += lenD + (currentDoc.length > 1 ? separatorLen : 0);
    }

    const doc = IngestionSplitter.joinDocs(currentDoc, separator);
    if (doc !== null) {
      docs.push(doc);
    }
    return docs;
  }

  /** Mirrors RecursiveCharacterTextSplitter._split_text (is_separator_regex=False). */
  private static splitText(
    text: string,
    separators: string[],
    chunkSize: number,
    chunkOverlap: number
  ): string[] {
    const finalChunks: string[] = [];

    // Choose the separator: the last, unless an earlier one occurs in text.
    let separator = separators[separators.length - 1];
    let newSeparators: string[] = [];
    for (let i = 0; i < separators.length; i++) {
      const s = separators[i];
      const sEscaped = pregQuote(s, '/');
      if (s === '') {
        separator = s;
        break;
      }
      let matched = false;
      try {
        matched = new RegExp(sEscaped, 'u').test(text);
      } catch {
        matched = false;
      }
      if (matched) {
        separator = s;
        newSeparators = separators.slice(i + 1);
        break;
      }
    }

    const sepEscaped = pregQuote(separator, '/');
    const splits = IngestionSplitter.splitWithRegex(text, sepEscaped);

    // Merge short pieces; recurse into pieces still longer than chunk_size.
    let goodSplits: string[] = [];
    const mergeSeparator = ''; // keep_separator => merge with ''
    for (const s of splits) {
      if (IngestionSplitter.len(s) < chunkSize) {
        goodSplits.push(s);
      } else {
        if (goodSplits.length > 0) {
          const merged = IngestionSplitter.mergeSplits(goodSplits, mergeSeparator, chunkSize, chunkOverlap);
          finalChunks.push(...merged);
          goodSplits = [];
        }
        if (newSeparators.length === 0) {
          finalChunks.push(s);
        } else {
          const other = IngestionSplitter.splitText(s, newSeparators, chunkSize, chunkOverlap);
          finalChunks.push(...other);
        }
      }
    }
    if (goodSplits.length > 0) {
      const merged = IngestionSplitter.mergeSplits(goodSplits, mergeSeparator, chunkSize, chunkOverlap);
      finalChunks.push(...merged);
    }
    return finalChunks;
  }
}
