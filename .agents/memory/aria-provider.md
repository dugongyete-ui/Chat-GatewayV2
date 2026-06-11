---
name: Opera Aria provider quirks
description: Key lessons for the Opera Aria integration in artifacts/api-server/src/lib/aria-provider.ts
---

## Auth flow (4 steps)

1. POST `oauth2.opera-api.com/oauth2/v1/token/` — `grant_type=client_credentials`, `client_id=ofa-client`, hardcoded secret → anonymous `access_token`
2. POST `auth.opera.com/account/v2/external/anonymous/signup` — **NO User-Agent header** (causes 503 if set) → `token` (auth_token)
3. POST token exchange — `grant_type=auth_token`, `scope=ALL`, `device_name=GPT4FREE` → `refresh_token` + `access_token`
4. POST refresh — `grant_type=refresh_token`, `scope=shodan:aria+user:read` → renewed `access_token`

Chat endpoint: `composer.opera-api.com/api/v1/a-chat`, SSE format `data: {"message":"..."}`, needs `Origin: opera-aria://ui`.

## Network: always use child_process curl

**Why:** Node.js `fetch` (undici) AND native `https.request` both get `ETIMEDOUT` to `opera-api.com` / `auth.opera.com` from Replit. curl via system CLI works fine — different network stack. Solution in `aria-provider.ts`: `spawn("curl", [...])` for all HTTP calls.

**How to apply:** Any new HTTP call to Opera Aria endpoints must go through the `curlPost()` helper, never native Node.js networking.
