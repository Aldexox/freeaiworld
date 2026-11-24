"""
Vercel serverless function: POST /api/proxy  &  GET /api/proxy?url=...
Streams AI provider responses back to the browser, bypassing CORS.
Allowed hosts: same list as local server.py
"""
from http.server import BaseHTTPRequestHandler
import json
import urllib.error
import urllib.parse
import urllib.request

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
}

STRIPPED_HEADERS = {
    "host", "origin", "referer", "content-length",
    "connection", "accept-encoding", "transfer-encoding",
}

MAX_BODY = 25 * 1024 * 1024   # 25 MB


def _cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Authorization, X-Target-Url"
    )


def _validate(url: str):
    if not url:
        return False, "Missing target URL."
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False, "Malformed target URL."
    if parsed.scheme not in ("http", "https"):
        return False, "Only http/https allowed."
    hostname = (parsed.hostname or "").lower()
    if hostname not in ALLOWED_PROXY_HOSTS:
        return False, f"Host '{hostname}' not in allowed list."
    if parsed.scheme == "http":
        return False, "Plain HTTP not allowed in hosted mode."
    return True, ""


def handler(request, response):
    _cors(response)

    # Pre-flight
    if request.method == "OPTIONS":
        response.status_code = 204
        response.body = ""
        return response

    # ── GET proxy ──────────────────────────────────────────────────────────────
    if request.method == "GET":
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(request.url).query)
        target_url = qs.get("url", [""])[0]
        ok, err = _validate(target_url)
        if not ok:
            response.status_code = 400
            response.headers["Content-Type"] = "application/json"
            response.body = json.dumps({"error": err})
            return response

        hdrs = {"User-Agent": "freeaiworld/1.0"}
        auth = request.headers.get("Authorization") or request.headers.get("authorization")
        if auth:
            hdrs["Authorization"] = auth

        req = urllib.request.Request(target_url, headers=hdrs, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read()
                response.status_code = resp.status
                response.headers["Content-Type"] = resp.headers.get(
                    "Content-Type", "application/octet-stream"
                )
                response.body = body
        except urllib.error.HTTPError as e:
            response.status_code = e.code
            response.body = e.read()
        except Exception as exc:
            response.status_code = 502
            response.headers["Content-Type"] = "application/json"
            response.body = json.dumps({"error": str(exc)})
        return response

    # ── POST proxy ─────────────────────────────────────────────────────────────
    if request.method == "POST":
        try:
            raw = request.body
            if isinstance(raw, str):
                raw = raw.encode("utf-8")
            if len(raw) > MAX_BODY:
                response.status_code = 413
                response.body = json.dumps({"error": "Payload too large"})
                return response
            envelope = json.loads(raw.decode("utf-8"))
        except Exception:
            response.status_code = 400
            response.headers["Content-Type"] = "application/json"
            response.body = json.dumps({"error": "Invalid JSON body"})
            return response

        target_url = str(envelope.get("url", ""))
        ok, err = _validate(target_url)
        if not ok:
            response.status_code = 400
            response.headers["Content-Type"] = "application/json"
            response.body = json.dumps({"error": err})
            return response

        method = str(envelope.get("method", "POST")).upper()
        req_headers = {"User-Agent": "freeaiworld/1.0"}
        for k, v in (envelope.get("headers") or {}).items():
            if k.lower() not in STRIPPED_HEADERS and v is not None:
                req_headers[str(k)] = str(v)

        payload_body = envelope.get("body")
        body_bytes = None
        if method == "POST" and payload_body is not None:
            if isinstance(payload_body, (dict, list)):
                body_bytes = json.dumps(payload_body).encode("utf-8")
                req_headers.setdefault("Content-Type", "application/json")
            else:
                body_bytes = str(payload_body).encode("utf-8")

        req = urllib.request.Request(
            target_url, data=body_bytes, headers=req_headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                content_type = resp.headers.get("Content-Type", "application/octet-stream")
                body_out = resp.read()
                response.status_code = resp.status
                response.headers["Content-Type"] = content_type
                # Vercel buffers; pass through body as-is
                response.body = body_out
        except urllib.error.HTTPError as e:
            response.status_code = e.code
            response.headers["Content-Type"] = e.headers.get(
                "Content-Type", "application/json"
            )
            response.body = e.read()
        except urllib.error.URLError as e:
            response.status_code = 502
            response.headers["Content-Type"] = "application/json"
            response.body = json.dumps({"error": f"Upstream error: {e.reason}"})
        except TimeoutError:
            response.status_code = 504
            response.headers["Content-Type"] = "application/json"
            response.body = json.dumps({"error": "Upstream AI provider timed out."})
        except Exception as exc:
            response.status_code = 500
            response.headers["Content-Type"] = "application/json"
            response.body = json.dumps({"error": str(exc)})
        return response

    response.status_code = 405
    response.body = json.dumps({"error": "Method not allowed"})
    return response
