"""
Vercel serverless function: catch-all stub for /api/run, /api/host, /api/ollama/*
Returns a clear "not available in hosted mode" JSON response.
"""
import json


def handler(request, response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Content-Type"] = "application/json"

    if request.method == "OPTIONS":
        response.status_code = 204
        response.body = ""
        return response

    path = getattr(request, "path", "") or ""
    if "run" in path:
        msg = "Code runner is not available in the hosted (Vercel) version. Run freeaiworld locally to use this feature."
        response.body = json.dumps({"ok": False, "unsupported": True, "error": msg})
    elif "host" in path:
        msg = "Website hosting is not available in the hosted (Vercel) version. Run freeaiworld locally to preview generated sites."
        response.body = json.dumps({"ok": False, "unsupported": True, "error": msg})
    else:
        msg = "This endpoint is not available in the hosted (Vercel) version."
        response.body = json.dumps({"ok": False, "error": msg})

    response.status_code = 200
    return response
