#!/usr/bin/env python3
"""
Qwen API proxy using curl_cffi with Chrome TLS/HTTP2 impersonation to bypass Aliyun WAF.

WAF bypass: curl_cffi impersonate="chrome137" mirrors Chrome's exact TLS fingerprint
and HTTP/2 SETTINGS frames — Aliyun WAF treats it as a real browser request.

Usage (session mode — logged-in token):
  python3 qwen_cffi.py create <TOKEN> <MODEL>
  python3 qwen_cffi.py chat   <TOKEN> <CHAT_ID> <PAYLOAD_BASE64>

Usage (guest mode — no login, uses bx-umidtoken):
  python3 qwen_cffi.py create "" <MODEL> <MIDTOKEN>
  python3 qwen_cffi.py chat   "" <CHAT_ID> <PAYLOAD_BASE64> <MIDTOKEN>
"""
import sys
import json
import time
import base64
import os
import curl_cffi.requests as req

ORIGIN  = "https://chat.qwen.ai"
BASE    = f"{ORIGIN}/api/v2"
IMPERSONATE = "chrome131_android"

MAX_RETRIES = 3
RETRY_DELAY = 3.0


UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36"

def _headers(token: str, midtoken: str = "") -> dict:
    h = {
        "Accept":               "application/json",
        "Accept-Language":      "en-US,en;q=0.9",
        "Content-Type":         "application/json",
        "Origin":               ORIGIN,
        "Referer":              f"{ORIGIN}/",
        "User-Agent":           UA,
        "Version":              "0.2.66",
        "source":               "h5",
        "bx-v":                 "2.5.36",
        "sec-ch-ua":            '"Chromium";v="137", "Not/A)Brand";v="24"',
        "sec-ch-ua-mobile":     "?1",
        "sec-ch-ua-platform":   '"Android"',
        "X-Accel-Buffering":    "no",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
        full_cookie = os.environ.get("QWEN_FULL_COOKIE", "")
        h["Cookie"] = full_cookie if full_cookie else f"token={token}"
    if midtoken:
        h["bx-umidtoken"] = midtoken
    return h


def _is_risk_control(text: str) -> bool:
    """Detect Qwen risk-control / server-overload response."""
    return "FAIL_SYS_USER_VALIDATE" in text or "_____tmd_____" in text


def _is_waf_challenge(text: str) -> bool:
    """Detect Aliyun WAF JS challenge page."""
    t = text.strip().lower()
    return t.startswith("<!doctype") or "aliyun_waf" in text


def cmd_create(token: str, model: str, midtoken: str = "") -> None:
    r = req.post(
        f"{BASE}/chats/new",
        json={
            "title":     "New Chat",
            "models":    [model],
            "chat_mode": "normal",
            "chat_type": "t2t",
            "timestamp": int(time.time() * 1000),
        },
        headers=_headers(token, midtoken),
        impersonate=IMPERSONATE,
        timeout=15,
    )
    if _is_waf_challenge(r.text):
        err = json.dumps({
            "error": {
                "message": "Qwen WAF challenge — IP blocked by Aliyun even with impersonation.",
                "type": "service_unavailable",
                "code": "qwen_waf_blocked",
            }
        })
        sys.stdout.write(err)
        sys.stdout.flush()
        sys.exit(3)
    sys.stdout.write(r.text)
    sys.stdout.flush()


def cmd_chat(token: str, chat_id: str, payload_b64: str, midtoken: str = "") -> None:
    payload = json.loads(base64.b64decode(payload_b64).decode("utf-8"))

    for attempt in range(MAX_RETRIES):
        chunks: list[bytes] = []
        first_chunk_checked = False
        risk_hit = False
        waf_hit  = False

        r = req.post(
            f"{BASE}/chat/completions?chat_id={chat_id}",
            json=payload,
            headers=_headers(token, midtoken),
            impersonate=IMPERSONATE,
            stream=True,
            timeout=90,
        )

        for chunk in r.iter_content():
            if not first_chunk_checked:
                first_chunk_checked = True
                sample = chunk.decode("utf-8", errors="replace")
                if _is_waf_challenge(sample):
                    waf_hit = True
                    break
                if _is_risk_control(sample):
                    risk_hit = True
                    break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()

        if not risk_hit and not waf_hit:
            return  # success

        if waf_hit:
            # WAF not bypassed by impersonation — report immediately, no point retrying
            err_msg = json.dumps({
                "error": {
                    "message": "Qwen WAF challenge — IP blocked by Aliyun even with Chrome impersonation.",
                    "type": "service_unavailable",
                    "code": "qwen_waf_blocked",
                }
            })
            sys.stdout.write(f"data: {err_msg}\n\ndata: [DONE]\n\n")
            sys.stdout.flush()
            sys.exit(3)

        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_DELAY * (attempt + 1))  # back-off: 3s, 6s
        else:
            err_msg = json.dumps({
                "error": {
                    "message": "Qwen server busy / risk-control triggered. Please retry in a moment.",
                    "type": "upstream_error",
                    "code": "qwen_risk_control",
                }
            })
            sys.stdout.write(f"data: {err_msg}\n\ndata: [DONE]\n\n")
            sys.stdout.flush()
            sys.exit(2)


def main() -> None:
    cmd      = sys.argv[1]
    token    = sys.argv[2]        # session token, or "" for guest mode
    if cmd == "create":
        model    = sys.argv[3]
        midtoken = sys.argv[4] if len(sys.argv) > 4 else ""
        cmd_create(token, model, midtoken)
    elif cmd == "chat":
        chat_id  = sys.argv[3]
        payload  = sys.argv[4]
        midtoken = sys.argv[5] if len(sys.argv) > 5 else ""
        cmd_chat(token, chat_id, payload, midtoken)
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


main()
