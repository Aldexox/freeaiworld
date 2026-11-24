"""
OmniFree AI Studio - Local Server, Real-Time Streaming Proxy,
Localhost Website Hosting, Document Extractor & Built-in Code Runner.
Runs on Python 3.12+ using only the standard library (zero pip dependencies).
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
HOSTED_DIR = BASE_DIR / "hosted_sites"
MAX_OUTPUT_CHARS = 120_000
RUN_TIMEOUT_SECONDS = 15

ALLOWED_PROXY_HOSTS = {
    "text.pollinations.ai",
    "image.pollinations.ai",
    "gen.pollinations.ai",
    "openrouter.ai",
    "generativelanguage.googleapis.com",
    "api.groq.com",
    "api.cerebras.ai",
    "api.mistral.ai",
    "api-inference.huggingface.co",
    "router.huggingface.co",
    "models.inference.ai.azure.com",
    "models.github.ai",
    "localhost",
    "127.0.0.1",
}

STRIPPED_REQUEST_HEADERS = {
    "host",
    "origin",
    "referer",
    "content-length",
    "connection",
    "accept-encoding",
}


def format_sql_table(columns: list[str], rows: list[tuple]) -> str:
    """Format SQLite query results into a crisp monospace terminal table."""
    if not columns:
        return ""
    str_rows = [[("NULL" if v is None else str(v)) for v in row] for row in rows]
    widths = [len(col) for col in columns]
    for r in str_rows:
        for idx, cell in enumerate(r):
            if len(cell) > widths[idx]:
                widths[idx] = min(len(cell), 48)

    def clip(val: str, width: int) -> str:
        return (val[: width - 1] + "…") if len(val) > width else val.ljust(width)

    sep = "+-" + "-+-".join("-" * w for w in widths) + "-+"
    header = "| " + " | ".join(clip(c, widths[i]) for i, c in enumerate(columns)) + " |"
    lines = [sep, header, sep]
    for r in str_rows[:200]:
        lines.append("| " + " | ".join(clip(r[i], widths[i]) for i in range(len(columns))) + " |")
    lines.append(sep)
    if len(str_rows) > 200:
        lines.append(f"... ({len(str_rows) - 200} more rows truncated)")
    return "\n".join(lines)


def split_sql_statements(sql_text: str) -> list[str]:
    """Split a SQL script into individual statements while respecting quotes and comments."""
    statements: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False
    i = 0
    n = len(sql_text)

    while i < n:
        ch = sql_text[i]
        nxt = sql_text[i + 1] if i + 1 < n else ""

        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
        elif in_block_comment:
            buf.append(ch)
            if ch == "*" and nxt == "/":
                buf.append(nxt)
                in_block_comment = False
                i += 1
        elif in_single:
            buf.append(ch)
            if ch == "'" and nxt == "'":
                buf.append(nxt)
                i += 1
            elif ch == "'":
                in_single = False
        elif in_double:
            buf.append(ch)
            if ch == '"' and nxt == '"':
                buf.append(nxt)
                i += 1
            elif ch == '"':
                in_double = False
        else:
            if ch == "-" and nxt == "-":
                in_line_comment = True
                buf.extend((ch, nxt))
                i += 1
            elif ch == "/" and nxt == "*":
                in_block_comment = True
                buf.extend((ch, nxt))
                i += 1
            elif ch == "'":
                in_single = True
                buf.append(ch)
            elif ch == '"':
                in_double = True
                buf.append(ch)
            elif ch == ";":
                buf.append(ch)
                stmt = "".join(buf).strip()
                if stmt and stmt != ";":
                    statements.append(stmt)
                buf.clear()
            else:
                buf.append(ch)
        i += 1

    trailing = "".join(buf).strip()
    if trailing:
        statements.append(trailing)
    return statements


def extract_docx_text(raw_bytes: bytes) -> str:
    """Extract paragraph text from a .docx archive using stdlib zipfile + ElementTree."""
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
        if "word/document.xml" not in zf.namelist():
            return ""
        xml_data = zf.read("word/document.xml")
    root = ET.fromstring(xml_data)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs: list[str] = []
    for para in root.findall(".//w:p", ns):
        texts = [t.text for t in para.findall(".//w:t", ns) if t.text]
        if texts:
            paragraphs.append("".join(texts))
    return "\n\n".join(paragraphs)


def extract_pdf_text(raw_bytes: bytes) -> tuple[str, str]:
    """Extract readable text from a PDF using pypdf/fitz if installed, or pure-Python stream scan."""
    try:
        import pypdf  # type: ignore

        reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n\n".join(p.strip() for p in pages if p.strip())
        if text:
            return text, "pypdf"
    except Exception:
        pass

    # Pure-Python fallback: decompress FlateDecode streams and collect Tj/TJ literal strings
    chunks: list[str] = []
    stream_pattern = re.compile(rb"stream\r?\n(.*?)\r?\nendstream", re.DOTALL)
    text_lit_pattern = re.compile(rb"\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|\"|TJ)")

    blobs = [raw_bytes]
    for match in stream_pattern.finditer(raw_bytes):
        stream_data = match.group(1)
        try:
            blobs.append(zlib.decompress(stream_data))
        except Exception:
            blobs.append(stream_data)

    for blob in blobs:
        for m in text_lit_pattern.finditer(blob):
            raw_str = m.group(1)
            raw_str = (
                raw_str.replace(rb"\(", b"(")
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


class StudioHandler(SimpleHTTPRequestHandler):
    """Serves static assets, hosted websites, streaming proxy, document extractor, and code runner."""

    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Target-Url")
        if self.path == "/" or any(self.path.split("?")[0].endswith(ext) for ext in (".html", ".css", ".js")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "app": "OmniFree AI Studio",
                    "python": sys.version.split()[0],
                    "proxy": True,
                    "runner": True,
                    "hoster": True,
                    "hasNode": bool(shutil.which("node")),
                },
            )
            return

        if parsed.path == "/api/ollama/tags":
            self._handle_ollama_tags(parsed.query)
            return

        if parsed.path == "/api/proxy":
            self._handle_proxy_get(parsed.query)
            return

        if parsed.path.startswith("/hosted/"):
            self._serve_hosted_file(parsed.path)
            return

        if parsed.path == "/" or not (PUBLIC_DIR / parsed.path.lstrip("/")).exists():
            if not parsed.path.startswith("/api/") and "." not in Path(parsed.path).name:
                self.path = "/index.html"

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/proxy":
            self._handle_proxy_post()
            return
        if parsed.path == "/api/run":
            self._handle_code_run()
            return
        if parsed.path == "/api/host":
            self._handle_host_site()
            return
        if parsed.path == "/api/extract":
            self._handle_extract_document()
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": f"Unknown endpoint: {parsed.path}"})

    def _serve_hosted_file(self, req_path: str) -> None:
        rel = req_path[len("/hosted/") :].lstrip("/")
        if not rel or rel.endswith("/"):
            rel = rel + "index.html"
        target = (HOSTED_DIR / rel).resolve()
        try:
            target.relative_to(HOSTED_DIR.resolve())
        except ValueError:
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Invalid hosted path."})
            return

        if target.is_dir():
            target = target / "index.html"
        if not target.exists() or not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Hosted site not found."})
            return

        data = target.read_bytes()
        mime, _ = mimetypes.guess_type(str(target))
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime or "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self, max_bytes: int = 25 * 1024 * 1024) -> tuple[dict | None, str | None]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, "Invalid Content-Length"
        if length <= 0 or length > max_bytes:
            return None, "Invalid request payload size"
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8")), None
        except json.JSONDecodeError:
            return None, "Request body must be valid JSON"

    def _handle_host_site(self) -> None:
        """Save generated HTML/CSS/JS site and return its live localhost URL."""
        payload, err_msg = self._read_json_body(max_bytes=5 * 1024 * 1024)
        if err_msg or payload is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err_msg or "Bad request"})
            return

        html = str(payload.get("html", ""))
        if not html.strip():
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "No HTML content provided."})
            return

        raw_name = str(payload.get("name", "")).strip().lower()
        slug = re.sub(r"[^a-z0-9_-]+", "-", raw_name).strip("-") or f"site-{int(time.time())}"
        site_dir = HOSTED_DIR / slug
        site_dir.mkdir(parents=True, exist_ok=True)
        (site_dir / "index.html").write_text(html, encoding="utf-8")

        host_header = self.headers.get("Host") or "127.0.0.1:8787"
        rel_url = f"/hosted/{slug}/index.html"
        full_url = f"http://{host_header}{rel_url}"
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "slug": slug,
                "path": rel_url,
                "url": full_url,
            },
        )

    def _handle_extract_document(self) -> None:
        """Extract plain text from uploaded .docx or .pdf documents."""
        payload, err_msg = self._read_json_body(max_bytes=20 * 1024 * 1024)
        if err_msg or payload is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err_msg or "Bad request"})
            return

        filename = str(payload.get("filename", "")).lower()
        b64 = str(payload.get("base64", ""))
        if not b64:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing file data."})
            return

        try:
            raw_bytes = base64.b64decode(b64)
        except Exception:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid base64 payload."})
            return

        try:
            if filename.endswith(".docx"):
                text = extract_docx_text(raw_bytes)
                self._send_json(HTTPStatus.OK, {"ok": True, "text": text, "method": "docx-xml"})
                return
            if filename.endswith(".pdf"):
                text, method = extract_pdf_text(raw_bytes)
                self._send_json(HTTPStatus.OK, {"ok": True, "text": text, "method": method})
                return
            text = raw_bytes.decode("utf-8", errors="replace")
            self._send_json(HTTPStatus.OK, {"ok": True, "text": text[:60_000], "method": "utf8"})
        except Exception as exc:
            self._send_json(HTTPStatus.OK, {"ok": False, "text": "", "error": str(exc)})

    def _validate_target_url(self, target_url: str) -> tuple[bool, str]:
        if not target_url:
            return False, "Missing target URL."
        try:
            parsed = urllib.parse.urlparse(target_url)
        except ValueError:
            return False, "Malformed target URL."

        if parsed.scheme not in ("http", "https"):
            return False, "Only http and https URLs are permitted."

        hostname = (parsed.hostname or "").lower()
        if hostname not in ALLOWED_PROXY_HOSTS:
            return False, f"Host '{hostname}' is not in the allowed AI provider list."

        if parsed.scheme == "http" and hostname not in ("localhost", "127.0.0.1"):
            return False, "Plain HTTP is only allowed for local runtimes (localhost / 127.0.0.1)."

        return True, ""

    def _handle_ollama_tags(self, query_string: str) -> None:
        params = urllib.parse.parse_qs(query_string)
        base = params.get("base", ["http://127.0.0.1:11434"])[0].rstrip("/")
        ok, err = self._validate_target_url(base)
        if not ok:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err, "models": []})
            return

        try:
            req = urllib.request.Request(f"{base}/api/tags", method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self._send_json(HTTPStatus.OK, {"online": True, "models": data.get("models", [])})
        except Exception as exc:
            self._send_json(HTTPStatus.OK, {"online": False, "models": [], "detail": str(exc)})

    def _handle_proxy_get(self, query_string: str) -> None:
        params = urllib.parse.parse_qs(query_string)
        target_url = params.get("url", [""])[0]
        ok, err = self._validate_target_url(target_url)
        if not ok:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
            return

        headers = {"User-Agent": "OmniFreeAIStudio/1.0"}
        auth_header = self.headers.get("Authorization")
        if auth_header:
            headers["Authorization"] = auth_header

        self._forward_request(target_url, method="GET", headers=headers, body=None, stream=False, timeout=90)

    def _handle_proxy_post(self) -> None:
        envelope, err_msg = self._read_json_body()
        if err_msg or envelope is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err_msg or "Bad request"})
            return

        target_url = str(envelope.get("url", ""))
        method = str(envelope.get("method", "POST")).upper()
        if method not in ("GET", "POST"):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Only GET and POST are supported"})
            return

        ok, err = self._validate_target_url(target_url)
        if not ok:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
            return

        req_headers: dict[str, str] = {"User-Agent": "OmniFreeAIStudio/1.0"}
        raw_headers = envelope.get("headers") or {}
        if isinstance(raw_headers, dict):
            for k, v in raw_headers.items():
                if str(k).lower() not in STRIPPED_REQUEST_HEADERS and v is not None:
                    req_headers[str(k)] = str(v)

        payload_body = envelope.get("body")
        want_stream = bool(envelope.get("stream"))
        body_bytes: bytes | None = None
        if method == "POST" and payload_body is not None:
            if isinstance(payload_body, (dict, list)):
                if isinstance(payload_body, dict) and payload_body.get("stream") is True:
                    want_stream = True
                body_bytes = json.dumps(payload_body).encode("utf-8")
                req_headers.setdefault("Content-Type", "application/json")
            else:
                body_bytes = str(payload_body).encode("utf-8")

        self._forward_request(
            target_url,
            method=method,
            headers=req_headers,
            body=body_bytes,
            stream=want_stream,
            timeout=120,
        )

    def _forward_request(
        self,
        target_url: str,
        *,
        method: str,
        headers: dict[str, str],
        body: bytes | None,
        stream: bool,
        timeout: int,
    ) -> None:
        req = urllib.request.Request(target_url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                content_type = resp.headers.get("Content-Type", "application/octet-stream")
                is_stream_resp = stream or (
                    "text/event-stream" in content_type.lower()
                    or "application/x-ndjson" in content_type.lower()
                )

                if is_stream_resp:
                    self.send_response(resp.status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("X-Accel-Buffering", "no")
                    if self.request_version == "HTTP/1.1":
                        self.send_header("Transfer-Encoding", "chunked")
                        self.end_headers()
                        while True:
                            chunk = resp.read1(4096) if hasattr(resp, "read1") else resp.read(1024)
                            if not chunk:
                                break
                            self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii"))
                            self.wfile.write(chunk)
                            self.wfile.write(b"\r\n")
                            self.wfile.flush()
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    else:
                        self.close_connection = True
                        self.end_headers()
                        while True:
                            chunk = resp.read1(4096) if hasattr(resp, "read1") else resp.read(1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            self.wfile.flush()
                    return

                resp_bytes = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(resp_bytes)))
                self.end_headers()
                self.wfile.write(resp_bytes)
        except urllib.error.HTTPError as http_err:
            err_bytes = http_err.read()
            content_type = http_err.headers.get("Content-Type", "application/json; charset=utf-8")
            self.send_response(http_err.code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(err_bytes)))
            self.end_headers()
            self.wfile.write(err_bytes)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except urllib.error.URLError as url_err:
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": f"Upstream connection error: {url_err.reason}"},
            )
        except TimeoutError:
            self._send_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                {"error": "Upstream AI provider timed out. Try another free model or retry."},
            )
        except Exception as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Proxy error: {exc}"})

    def _handle_code_run(self) -> None:
        """Execute Python, SQL (SQLite :memory:), or Node.js snippets in an isolated temp workspace."""
        payload, err_msg = self._read_json_body(max_bytes=2 * 1024 * 1024)
        if err_msg or payload is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err_msg or "Bad request"})
            return

        lang = str(payload.get("language", "")).strip().lower()
        code = str(payload.get("code", ""))
        if not code.strip():
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "No code provided to run."})
            return

        started = time.perf_counter()

        if lang in ("sql", "sqlite", "sqlite3"):
            try:
                conn = sqlite3.connect(":memory:")
                cur = conn.cursor()
                outputs: list[str] = []
                for idx, stmt in enumerate(split_sql_statements(code), start=1):
                    cur.execute(stmt)
                    if cur.description:
                        cols = [d[0] for d in cur.description]
                        rows = cur.fetchall()
                        outputs.append(f"-- Query {idx} ({len(rows)} row(s)) --")
                        outputs.append(format_sql_table(cols, rows) if rows else "(0 rows returned)")
                    else:
                        if cur.rowcount >= 0:
                            outputs.append(f"OK (statement {idx}, {cur.rowcount} row(s) affected)")
                conn.commit()
                conn.close()
                duration_ms = round((time.perf_counter() - started) * 1000)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "command": "sqlite3 :memory: < query.sql",
                        "stdout": ("\n".join(outputs) or "SQL executed successfully.")[:MAX_OUTPUT_CHARS],
                        "stderr": "",
                        "exitCode": 0,
                        "durationMs": duration_ms,
                    },
                )
            except Exception as exc:
                duration_ms = round((time.perf_counter() - started) * 1000)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": False,
                        "command": "sqlite3 :memory: < query.sql",
                        "stdout": "",
                        "stderr": f"SQLite Error: {exc}",
                        "exitCode": 1,
                        "durationMs": duration_ms,
                    },
                )
            return

        if lang in ("py", "python", "python3"):
            cmd_name = "python -u main.py"
            filename = "main.py"
            argv_builder = lambda fp: [sys.executable, "-u", fp]
        elif lang in ("js", "javascript") and shutil.which("node"):
            cmd_name = "node main.js"
            filename = "main.js"
            argv_builder = lambda fp: ["node", fp]
        else:
            self._send_json(
                HTTPStatus.OK,
                {
                    "unsupported": True,
                    "error": f"Server runner does not execute '{lang}' directly.",
                },
            )
            return

        with tempfile.TemporaryDirectory(prefix="omnifree_run_") as tmpdir:
            script_path = Path(tmpdir) / filename
            script_path.write_text(code, encoding="utf-8")

            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"

            try:
                proc = subprocess.run(
                    argv_builder(str(script_path)),
                    cwd=tmpdir,
                    env=env,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=RUN_TIMEOUT_SECONDS,
                )
                duration_ms = round((time.perf_counter() - started) * 1000)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": proc.returncode == 0,
                        "command": cmd_name,
                        "stdout": proc.stdout[:MAX_OUTPUT_CHARS],
                        "stderr": proc.stderr[:MAX_OUTPUT_CHARS],
                        "exitCode": proc.returncode,
                        "durationMs": duration_ms,
                    },
                )
            except subprocess.TimeoutExpired as exc:
                duration_ms = round((time.perf_counter() - started) * 1000)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": False,
                        "command": cmd_name,
                        "stdout": (exc.stdout or "")[:MAX_OUTPUT_CHARS] if isinstance(exc.stdout, str) else "",
                        "stderr": f"Execution timed out after {RUN_TIMEOUT_SECONDS}s.",
                        "exitCode": 124,
                        "durationMs": duration_ms,
                    },
                )

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write(f"[OmniFree] {self.address_string()} - {format % args}\n")


def main() -> None:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    parser = argparse.ArgumentParser(description="Run OmniFree AI Studio local server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "8787")),
        help="Port number (default: 8787)",
    )
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), StudioHandler)
    url = f"http://{args.host}:{args.port}"
    print(f"OmniFree AI Studio running at {url}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down OmniFree AI Studio...")
        server.server_close()


if __name__ == "__main__":
    main()
