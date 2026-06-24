#!/usr/bin/env python3
"""
Qwen API proxy using curl_cffi with Chrome impersonation + residential proxy rotation
to bypass Aliyun WAF (which blocks datacenter IPs).

Proxy config: env var QWEN_PROXIES = comma-separated list of http://user:pass@ip:port
Token config: env var QWEN_SESSION_TOKEN (JWT from chat.qwen.ai Cookie)
Full cookie:  env var QWEN_FULL_COOKIE (full browser Cookie header)

Usage:
  python3 qwen_cffi.py create <TOKEN> <MODEL>
  python3 qwen_cffi.py chat   <TOKEN> <CHAT_ID> <PAYLOAD_BASE64>
  Guest mode: pass "" as TOKEN, add <MIDTOKEN> as last arg.
"""
import sys
import json
import time
import base64
import os
import random
import curl_cffi.requests as req

ORIGIN      = "https://chat.qwen.ai"
BASE        = f"{ORIGIN}/api/v2"
IMPERSONATE = "chrome131_android"

MAX_RETRIES = 3
RETRY_DELAY = 3.0

UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36"


# ── Proxy pool ──────────────────────────────────────────────────────────────

def _load_proxies() -> list[str]:
    raw = os.environ.get("QWEN_PROXIES", "").strip()
    if not raw:
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]

_PROXIES = _load_proxies()

def _pick_proxy() -> dict | None:
    if not _PROXIES:
        return None
    url = random.choice(_PROXIES)
    return {"http": url, "https": url}


# ── Headers ─────────────────────────────────────────────────────────────────

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


# ── Response checks ─────────────────────────────────────────────────────────

def _is_risk_control(text: str) -> bool:
    return "FAIL_SYS_USER_VALIDATE" in text or "_____tmd_____" in text

def _is_waf_challenge(text: str) -> bool:
    t = text.strip().lower()
    return t.startswith("<!doctype") or "aliyun_waf" in text


# ── Commands ────────────────────────────────────────────────────────────────

def cmd_create(token: str, model: str, midtoken: str = "") -> None:
    proxy = _pick_proxy()
    last_err = None

    # Try each proxy (or no-proxy if empty) up to len(proxies) times
    attempts = list(_PROXIES) if _PROXIES else [None]
    random.shuffle(attempts)

    for attempt_proxy in attempts:
        p = {"http": attempt_proxy, "https": attempt_proxy} if attempt_proxy else None
        try:
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
                proxies=p,
                impersonate=IMPERSONATE,
                timeout=15,
            )
            if _is_waf_challenge(r.text):
                last_err = f"WAF challenge via proxy {attempt_proxy}"
                continue  # try next proxy
            sys.stdout.write(r.text)
            sys.stdout.flush()
            return
        except Exception as e:
            last_err = str(e)
            continue

    # All proxies exhausted
    err = json.dumps({
        "error": {
            "message": f"Qwen WAF: all proxies blocked or failed. Last error: {last_err}",
            "type": "service_unavailable",
            "code": "qwen_waf_blocked",
        }
    })
    sys.stdout.write(err)
    sys.stdout.flush()
    sys.exit(3)


def cmd_chat(token: str, chat_id: str, payload_b64: str, midtoken: str = "") -> None:
    payload = json.loads(base64.b64decode(payload_b64).decode("utf-8"))

    proxies_to_try = list(_PROXIES) if _PROXIES else [None]
    random.shuffle(proxies_to_try)

    for attempt_proxy in proxies_to_try:
        p = {"http": attempt_proxy, "https": attempt_proxy} if attempt_proxy else None
        risk_hit  = False
        waf_hit   = False
        succeeded = False

        try:
            r = req.post(
                f"{BASE}/chat/completions?chat_id={chat_id}",
                json=payload,
                headers=_headers(token, midtoken),
                proxies=p,
                impersonate=IMPERSONATE,
                stream=True,
                timeout=90,
            )

            first = True
            for chunk in r.iter_content():
                if first:
                    first = False
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
                succeeded = True
                break

        except Exception:
            continue  # proxy error, try next

        if waf_hit:
            continue  # try next proxy

        if risk_hit:
            # Risk control: retry 3x on same proxy then move on
            for backoff in range(1, MAX_RETRIES):
                time.sleep(RETRY_DELAY * backoff)
                try:
                    r2 = req.post(
                        f"{BASE}/chat/completions?chat_id={chat_id}",
                        json=payload,
                        headers=_headers(token, midtoken),
                        proxies=p,
                        impersonate=IMPERSONATE,
                        stream=True,
                        timeout=90,
                    )
                    first2 = True
                    rc2 = False
                    for chunk in r2.iter_content():
                        if first2:
                            first2 = False
                            s = chunk.decode("utf-8", errors="replace")
                            if _is_risk_control(s) or _is_waf_challenge(s):
                                rc2 = True
                                break
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                    if not rc2:
                        succeeded = True
                        break
                except Exception:
                    break
            if succeeded:
                break

    if not succeeded:
        err_msg = json.dumps({
            "error": {
                "message": "Qwen server busy / WAF blocked. All proxies tried.",
                "type": "upstream_error",
                "code": "qwen_risk_control",
            }
        })
        sys.stdout.write(f"data: {err_msg}\n\ndata: [DONE]\n\n")
        sys.stdout.flush()
        sys.exit(2)


def main() -> None:
    cmd   = sys.argv[1]
    token = sys.argv[2]
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
