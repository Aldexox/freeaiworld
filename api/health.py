"""
Vercel serverless function: GET /api/health
Returns server capability flags for the hosted (Vercel) deployment.
Code runner and site hoster are unavailable on Vercel serverless.
"""
import json
import sys


def handler(request, response):
    payload = {
        "status": "ok",
        "app": "freeaiworld",
        "python": sys.version.split()[0],
        "proxy": True,
        "runner": False,
        "hoster": False,
        "hasNode": False,
        "hosted": True,
    }
    response.status_code = 200
    response.headers["Content-Type"] = "application/json"
    response.body = json.dumps(payload)
    return response
