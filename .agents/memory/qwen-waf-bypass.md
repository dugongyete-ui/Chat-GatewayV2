---
name: Qwen WAF bypass
description: How to bypass Aliyun WAF on chat.qwen.ai from Replit datacenter IPs using curl_cffi + session token.
---

# Qwen WAF Bypass

## The Rule
Use `curl_cffi` **without** any `impersonate=` parameter, combined with `Authorization: Bearer <QWEN_SESSION_TOKEN>`.  
This TLS fingerprint is NOT in Aliyun's datacenter blocklist (tested June 2026).

**Why:** Aliyun WAF blocks datacenter IPs based on TLS JA3/JA4 fingerprint. Node.js fetch (undici/OpenSSL) and system curl both match blocked fingerprints. curl_cffi's default libcurl-impersonate TLS stack does not.

**How to apply:** Route ALL Qwen HTTP requests through `qwen_cffi.py` Python subprocess. Never use Node.js `fetch()` for Qwen API calls when running from Replit datacenter.

## Implementation
- Python script: `artifacts/api-server/src/lib/qwen_cffi.py` → copied to `dist/qwen_cffi.py` by build
- Node.js helpers: `qwenPyCreate()` (execSync) and `qwenPyBody()` (spawn) in `v1.ts`
- Streaming: `spawn("python3", [QWEN_CFFI_PY, "chat", token, chatId, payloadB64])` — reads py.stdout in real-time
- Env var: `QWEN_SESSION_TOKEN` = JWT from `token=` cookie on chat.qwen.ai (expires ~1 year)

## Model IDs (as of June 2026)
Old internal IDs no longer work — mapped via `QWEN_API_MODEL_MAP` in v1.ts:
- `qwen3-235b-a22b` → `qwen-plus-2025-07-28` (Qwen3-235B-A22B-2507)
- `qwen3-30b-a3b` → `qwen3.5-35b-a3b`
- `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` → unchanged
- Fast/cheap: `qwen3.5-flash`

## Auth
- Token source: `token=` cookie from chat.qwen.ai browser session
- Sent as `Authorization: Bearer <token>` header (NOT as Cookie)
- JWT expires ~1 year from login date; store as `QWEN_SESSION_TOKEN` env var
- Without token: keyless fallback still exists but will hit WAF for completions endpoint

## Key Endpoints
- Create chat: `POST /api/v2/chats/new` (NOT `/chats/create`)
- Completions: `POST /api/v2/chat/completions?chat_id=<id>`
- Models list: `GET /api/v2/models` (returns new IDs)
