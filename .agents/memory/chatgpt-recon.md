---
name: ChatGPT guest mode recon
description: Full reverse-engineering findings for ChatGPT backend-anon API, PoW solver, turnstile, and provider implementation.
---

## Endpoints (May 2026)

- `GET  /backend-anon/models` → 200 ✅ no auth needed
- `POST /backend-anon/sentinel/chat-requirements` → 200 ✅ persona=chatgpt-noauth
- `POST /backend-anon/f/conversation` → 403 "Unusual activity" ❌ (datacenter IP block)

## TLS Fingerprinting

- `curl_cffi impersonate="chrome110"` works for sentinel endpoint (200 OK)
- `chrome131` and `chrome120` get Cloudflare 403 challenge on sentinel
- Always use `chrome110` for ChatGPT requests

## PoW (Proof of Work)

- Algorithm: SHA3-512
- Token prefix: `gAAAAAB`
- Format: `gAAAAAB` + base64(JSON([seed, difficulty, counter]))
- Python: `hashlib.sha3_512(token.encode()).digest()`
- Node.js: `crypto.createHash('sha3-512')` works natively (Node 24)
- Solve time: ~2ms, target = first 3 bytes of hash ≤ int(difficulty, 16)

## Turnstile

- Requirements response has `turnstile.dx` (base64+XOR encrypted VM bytecode)
- `dx` XOR `p` → JSON token list → execute via `get_func_map()` VM (20+ functions)
- `p` = XOR key from Cloudflare challenge JS, only obtainable from real browser
- gpt4free approach: extract `openai-sentinel-turnstile-token` from Chrome HAR file
- Cannot solve algorithmically from datacenter without browser session

## Blockers from Replit/Datacenter

1. **IP reputation**: `f/conversation` 403 "Unusual activity" regardless of headers/PoW
2. **Turnstile**: `p` value needed for dx decoding, only from browser CF challenge

## Workarounds

- `CHATGPT_PROXY` env var → residential SOCKS5/HTTP proxy
- `CHATGPT_TURNSTILE_TOKEN` env var → inject browser-captured turnstile token

## Provider Implementation

- File: `artifacts/api-server/src/lib/chatgpt-provider.ts`
- Uses Python subprocess with curl_cffi (like aria-provider uses curl subprocess)
- Body passed as `json.loads(JSON_STRING)` — NOT direct dict literal (true/false issue)
- Returns 503 with `ip_blocked` code on datacenter block, not 500

**Why:** Direct Node.js fetch gets CF-challenged. Python curl_cffi with chrome110 impersonate bypasses CF for sentinel but still gets IP-blocked on conversation from datacenter.

**How to apply:** When adding new ChatGPT-related features, always use chrome110 impersonate. For conversation endpoint to work, residential proxy is required.
