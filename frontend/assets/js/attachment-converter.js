/**
 * Attachment converter.
 *
 * Platform-level mechanism for getting any attached document into a form
 * the LLM can read. Text-native formats (HTML, Markdown, plain text,
 * source code) pass through verbatim. Binary formats (DOCX/PPTX/XLSX/PDF)
 * run through a Pyodide-side conversion to Markdown.
 *
 * This is NOT a skill. Skills are about producing output; this is about
 * normalizing input. Both chat attachments and workflow-node attachments
 * route through here so the LLM never has to deal with binary formats.
 *
 * Public API:
 *   await window.attachmentConverter.toMarkdown(file)
 *   // → { markdown, originalName, originalMime, converted, converterMs }
 *
 * Throws on unsupported formats and on conversion failure. Callers must
 * surface the error to the user and block the send — there is no silent
 * fallback by design.
 */
(function () {
    'use strict';

    // Extensions whose text content the LLM reads natively. We just pass
    // them through unchanged. Anything not in this set and not in the
    // converter dispatch below throws "format not supported".
    const TEXT_NATIVE_EXTENSIONS = new Set([
        'html', 'htm',
        'md', 'markdown',
        'txt', 'text',
        'json', 'yaml', 'yml', 'xml',
        'csv', 'tsv',
        'js', 'mjs', 'ts', 'tsx', 'jsx',
        'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
        'sh', 'bash', 'zsh',
        'css', 'scss', 'less',
        'sql',
        'log',
        'rtf',  // RTF degrades to plain-ish text; better than nothing
    ]);

    // Inline Python converters. Each reads /scratch/in.<ext> and writes
    // /scratch/out.md. Paths are fixed because runInline owns the MEMFS
    // workspace; argparse and CLI scaffolding from the original skill
    // scripts are stripped — this is platform plumbing, not a CLI.

    const DOCX_TO_MD_PY = `
import sys
import mammoth

with open('/scratch/in.docx', 'rb') as f:
    result = mammoth.convert_to_markdown(f)

with open('/scratch/out.md', 'w', encoding='utf-8') as f:
    f.write(result.value)

# Mammoth surfaces fidelity warnings — flush them so callers can decide
# whether to surface to the user. Conversion itself is still considered
# successful as long as no Python exception was raised.
for msg in result.messages:
    print(f"[mammoth/{msg.type}] {msg.message}", file=sys.stderr)
`;

    const PPTX_TO_MD_PY = `
import sys
from pptx import Presentation
from pptx.util import Emu

def text_from_frame(text_frame):
    for para in text_frame.paragraphs:
        line = "".join(run.text or "" for run in para.runs)
        if not line and para.text:
            line = para.text
        yield (para.level or 0, line)

def render_paragraph_lines(lines):
    out = []
    for level, text in lines:
        text = (text or "").strip()
        if not text:
            continue
        indent = "  " * level
        out.append(f"{indent}- {text}")
    return out

def render_table(shape):
    table = shape.table
    rows = []
    for row in table.rows:
        cells = []
        for cell in row.cells:
            cells.append(" ".join(
                (run.text or "").strip()
                for para in cell.text_frame.paragraphs
                for run in para.runs
            ).strip().replace("|", r"\\|").replace("\\n", " "))
        rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    md = ["| " + " | ".join(rows[0]) + " |",
          "| " + " | ".join(["---"] * width) + " |"]
    for r in rows[1:]:
        md.append("| " + " | ".join(r) + " |")
    return "\\n".join(md)

def extract_slide(slide, idx):
    out = []
    layout_name = slide.slide_layout.name if slide.slide_layout else "?"
    out.append(f"## Slide {idx} — {layout_name}")
    title_text = ""
    if slide.shapes.title and slide.shapes.title.has_text_frame:
        title_text = slide.shapes.title.text_frame.text.strip()
    if title_text:
        out.append(f"### {title_text}")
    body_blocks, table_blocks, aux_blocks = [], [], []
    for shape in slide.shapes:
        if shape == slide.shapes.title:
            continue
        if shape.has_table:
            md = render_table(shape)
            if md:
                table_blocks.append(md)
            continue
        if not shape.has_text_frame:
            continue
        rendered = render_paragraph_lines(list(text_from_frame(shape.text_frame)))
        if not rendered:
            continue
        if shape.is_placeholder:
            body_blocks.extend(rendered)
        else:
            aux_blocks.extend(rendered)
    if body_blocks:
        out.append("\\n".join(body_blocks))
    for tbl in table_blocks:
        out.append(tbl)
    if aux_blocks:
        out.append("> **Other shapes on slide:**")
        out.append("\\n".join(aux_blocks))
    if slide.has_notes_slide:
        notes_text = (slide.notes_slide.notes_text_frame.text or "").strip()
        if notes_text:
            out.append("### Notes")
            out.append(notes_text)
    return "\\n\\n".join(out)

prs = Presentation('/scratch/in.pptx')
sections = [
    f"# Presentation",
    f"_{len(prs.slides)} slide(s) · "
    f"{Emu(prs.slide_width).inches:.2f}\\" × {Emu(prs.slide_height).inches:.2f}\\"_",
]
for i, slide in enumerate(prs.slides, start=1):
    sections.append(extract_slide(slide, i))

with open('/scratch/out.md', 'w', encoding='utf-8') as f:
    f.write("\\n\\n".join(sections) + "\\n")
print(f"extracted {len(prs.slides)} slide(s)", file=sys.stderr)
`;

    const XLSX_TO_MD_PY = `
import sys
from openpyxl import load_workbook

MAX_ROWS = 200

def md_table(rows, max_rows=MAX_ROWS):
    if not rows:
        return "_(empty)_"
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    truncated = False
    if len(rows) > max_rows:
        rows = rows[:max_rows]
        truncated = True
    cell = lambda v: ("" if v is None else str(v)).replace("|", r"\\|").replace("\\n", " ")
    out = ["| " + " | ".join(cell(v) for v in rows[0]) + " |",
           "| " + " | ".join(["---"] * width) + " |"]
    for r in rows[1:]:
        out.append("| " + " | ".join(cell(v) for v in r) + " |")
    if truncated:
        out.append(f"\\n_(showing first {max_rows} rows)_")
    return "\\n".join(out)

wb = load_workbook('/scratch/in.xlsx', data_only=True)
sections = [f"# Workbook", f"_{len(wb.sheetnames)} sheet(s)_"]
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    rows = []
    for row in ws.iter_rows(values_only=True):
        row_vals = list(row)
        while row_vals and (row_vals[-1] is None or row_vals[-1] == ""):
            row_vals.pop()
        if row_vals or not rows:
            rows.append(row_vals)
    while rows and not any(c not in (None, "") for c in rows[-1]):
        rows.pop()
    sections.append(f"## Sheet: {sheet_name}")
    sections.append(f"_{len(rows)} row(s) · {ws.max_column} col(s)_")
    sections.append(md_table(rows))

with open('/scratch/out.md', 'w', encoding='utf-8') as f:
    f.write("\\n\\n".join(sections) + "\\n")
print(f"extracted {len(wb.sheetnames)} sheet(s)", file=sys.stderr)
`;

    const PDF_TO_MD_PY = `
import sys
from pypdf import PdfReader

reader = PdfReader('/scratch/in.pdf')
parts = [f"# PDF · {len(reader.pages)} page(s)"]
for i, page in enumerate(reader.pages, start=1):
    text = ""
    try:
        text = page.extract_text() or ""
    except Exception as e:
        print(f"[pypdf] page {i}: {e}", file=sys.stderr)
    text = text.strip()
    parts.append(f"## Page {i}")
    parts.append(text if text else "_(no extractable text)_")

with open('/scratch/out.md', 'w', encoding='utf-8') as f:
    f.write("\\n\\n".join(parts) + "\\n")
print(f"extracted {len(reader.pages)} page(s)", file=sys.stderr)
`;

    function extOf(file) {
        const name = (file && (file.name || '')).toLowerCase();
        const dot = name.lastIndexOf('.');
        return dot >= 0 ? name.slice(dot + 1) : '';
    }

    async function passThrough(file) {
        // file.text() handles UTF-8 decoding; also fine for ASCII subsets.
        return await file.text();
    }

    /**
     * Shared binary-format converter. Reads the file as bytes, hands it to
     * Pyodide at /scratch/in.<ext>, runs the matching Python conversion,
     * reads /scratch/out.md back. Throws on any failure.
     */
    async function convertBinary({ file, ext, code, dependencies, label }) {
        if (!window.pyodideRunner || typeof window.pyodideRunner.runInline !== 'function') {
            throw new Error(`Pyodide runner is not available — cannot convert .${ext}`);
        }
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const inPath = `/scratch/in.${ext}`;
        const outPath = '/scratch/out.md';
        const result = await window.pyodideRunner.runInline({
            code,
            inputFiles: { [inPath]: bytes },
            readOutputs: [outPath],
            dependencies,
        });
        if (result.exitCode !== 0) {
            const detail = (result.stderr || '').trim() || 'unknown error';
            throw new Error(`${label} conversion failed: ${detail}`);
        }
        const md = result.outputs[outPath];
        if (typeof md !== 'string' || md.length === 0) {
            throw new Error(`${label} conversion produced no markdown output`);
        }
        if (typeof window.pyodideRunner.cleanupPath === 'function') {
            window.pyodideRunner.cleanupPath(inPath);
            window.pyodideRunner.cleanupPath(outPath);
        }
        return md;
    }

    const convertDocx = (file) => convertBinary({
        file, ext: 'docx', code: DOCX_TO_MD_PY,
        dependencies: ['mammoth'], label: 'docx',
    });
    const convertPptx = (file) => convertBinary({
        file, ext: 'pptx', code: PPTX_TO_MD_PY,
        dependencies: ['python-pptx'], label: 'pptx',
    });
    const convertXlsx = (file) => convertBinary({
        file, ext: 'xlsx', code: XLSX_TO_MD_PY,
        dependencies: ['openpyxl'], label: 'xlsx',
    });
    const convertPdf = (file) => convertBinary({
        file, ext: 'pdf', code: PDF_TO_MD_PY,
        dependencies: ['pypdf'], label: 'pdf',
    });

    /**
     * Convert an arbitrary File / Blob into Markdown the LLM can read.
     * Returns a small descriptor; throws on anything we can't handle.
     */
    async function toMarkdown(file) {
        if (!file || typeof file.name !== 'string') {
            throw new Error('toMarkdown: a File-like object with a .name is required');
        }
        const t0 = performance.now();
        const ext = extOf(file);
        const originalName = file.name;
        const originalMime = (file.type || '').toLowerCase();

        let markdown;
        let converted = false;

        if (TEXT_NATIVE_EXTENSIONS.has(ext)) {
            markdown = await passThrough(file);
        } else if (ext === 'docx') {
            markdown = await convertDocx(file);
            converted = true;
        } else if (ext === 'pptx') {
            markdown = await convertPptx(file);
            converted = true;
        } else if (ext === 'xlsx') {
            markdown = await convertXlsx(file);
            converted = true;
        } else if (ext === 'pdf') {
            markdown = await convertPdf(file);
            converted = true;
        } else {
            // Last-ditch: if the browser thinks the mime is text/*, treat
            // it as text. Otherwise refuse — the LLM doesn't read random
            // binary blobs.
            if (originalMime.startsWith('text/')) {
                markdown = await passThrough(file);
            } else {
                throw new Error(`format not supported (.${ext || originalMime || 'unknown'})`);
            }
        }

        return {
            markdown,
            originalName,
            originalMime,
            converted,
            converterMs: Math.round(performance.now() - t0),
        };
    }

    window.attachmentConverter = {
        toMarkdown,
        // Exposed for tests + UI gating (e.g. should we show a spinner?)
        isTextNative: (file) => TEXT_NATIVE_EXTENSIONS.has(extOf(file)),
        _supportedBinaryExtensions: () => ['docx', 'pptx', 'xlsx', 'pdf'],
    };
})();
