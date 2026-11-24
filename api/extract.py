"""
Vercel serverless function: POST /api/extract
Extracts text from .docx and .pdf files.
Identical logic to server.py but wrapped for Vercel.
"""
import base64
import io
import json
import re
import xml.etree.ElementTree as ET
import zipfile
import zlib


def _cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"


def extract_docx_text(raw_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
        if "word/document.xml" not in zf.namelist():
            return ""
        xml_data = zf.read("word/document.xml")
    root = ET.fromstring(xml_data)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = []
    for para in root.findall(".//w:p", ns):
        texts = [t.text for t in para.findall(".//w:t", ns) if t.text]
        if texts:
            paragraphs.append("".join(texts))
    return "\n\n".join(paragraphs)


def extract_pdf_text(raw_bytes: bytes):
    # Try pypdf first (available on Vercel if added to requirements.txt)
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n\n".join(p.strip() for p in pages if p.strip())
        if text:
            return text, "pypdf"
    except Exception:
        pass

    # Pure-Python fallback
    chunks = []
    stream_pattern = re.compile(rb"stream\r?\n(.*?)\r?\nendstream", re.DOTALL)
    text_lit_pattern = re.compile(rb"\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|\"|TJ)")
    blobs = [raw_bytes]
    for match in stream_pattern.finditer(raw_bytes):
        try:
            blobs.append(zlib.decompress(match.group(1)))
        except Exception:
            blobs.append(match.group(1))
    for blob in blobs:
        for m in text_lit_pattern.finditer(blob):
            raw_str = (
                m.group(1)
                .replace(rb"\(", b"(")
                .replace(rb"\)", b")")
                .replace(rb"\\", b"\\")
                .replace(rb"\n", b"\n")
                .replace(rb"\r", b" ")
                .replace(rb"\t", b" ")
            )
            decoded = raw_str.decode("utf-8", errors="ignore").strip()
            if decoded and any(c.isalnum() for c in decoded):
                chunks.append(decoded)
    combined = " ".join(chunks)
    combined = re.sub(r"\s{2,}", " ", combined).strip()
    return combined[:60_000], "stdlib-pdf"


def handler(request, response):
    _cors(response)
    response.headers["Content-Type"] = "application/json"

    if request.method == "OPTIONS":
        response.status_code = 204
        response.body = ""
        return response

    if request.method != "POST":
        response.status_code = 405
        response.body = json.dumps({"error": "Method not allowed"})
        return response

    try:
        raw = request.body
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        response.status_code = 400
        response.body = json.dumps({"error": "Invalid JSON body"})
        return response

    filename = str(payload.get("filename", "")).lower()
    b64 = str(payload.get("base64", ""))
    if not b64:
        response.status_code = 400
        response.body = json.dumps({"error": "Missing file data."})
        return response

    try:
        raw_bytes = base64.b64decode(b64)
    except Exception:
        response.status_code = 400
        response.body = json.dumps({"error": "Invalid base64 payload."})
        return response

    try:
        if filename.endswith(".docx"):
            text = extract_docx_text(raw_bytes)
            response.status_code = 200
            response.body = json.dumps({"ok": True, "text": text, "method": "docx-xml"})
        elif filename.endswith(".pdf"):
            text, method = extract_pdf_text(raw_bytes)
            response.status_code = 200
            response.body = json.dumps({"ok": True, "text": text, "method": method})
        else:
            text = raw_bytes.decode("utf-8", errors="replace")
            response.status_code = 200
            response.body = json.dumps({"ok": True, "text": text[:60_000], "method": "utf8"})
    except Exception as exc:
        response.status_code = 200
        response.body = json.dumps({"ok": False, "text": "", "error": str(exc)})

    return response
