# Document -> PDF. Input: a document package {document, attachments, ...} (e.g. from "Mail dropped in a folder").
# Converts the document to PDF and leaves the attachments as they are; everything else passes through untouched.
# Output: the package with `files` -- the PDF first, then the attachments -- each a {name, from} reference that
# the storing node fetches at upload time (or {name, base64} for content carried inline).
# A document converts through its own pdf rendition (renditions.pdf, a tool call), or is already a PDF file.
import json


def _pdf_name(document):
    name = str(document.get("name") or "Document").strip() or "Document"
    return name if name.lower().endswith(".pdf") else name + ".pdf"


def run(input, call_tool):
    pkg = input
    if isinstance(pkg, str):
        try:
            pkg = json.loads(pkg)
        except ValueError:
            pkg = None
    doc = pkg.get("document") if isinstance(pkg, dict) else None
    if not isinstance(doc, dict):
        return {"route": "error", "output": {"reason": "no document in the input: expected {document, attachments}",
                                             "source": pkg.get("source") if isinstance(pkg, dict) else None}}
    rendition = (doc.get("renditions") or {}).get("pdf")
    if isinstance(rendition, dict) and rendition.get("server") and rendition.get("tool"):
        pdf = {"name": _pdf_name(doc), "from": rendition}
    elif (doc.get("content_type") or "").lower() == "application/pdf" and (doc.get("from") or doc.get("base64")):
        pdf = {k: doc[k] for k in ("from", "base64") if doc.get(k) is not None} | {"name": _pdf_name(doc)}
    else:
        return {"route": "error", "output": {
            "reason": f"cannot convert a {doc.get('kind') or doc.get('content_type') or 'document'} to PDF: "
                      "it has no pdf rendition", "source": pkg.get("source")}}
    attachments = [a for a in pkg.get("attachments") or [] if isinstance(a, dict)]
    files = [pdf] + [{k: a[k] for k in ("name", "from", "base64") if a.get(k) is not None} for a in attachments]
    return {"route": "done", "output": {**pkg, "files": files}}
