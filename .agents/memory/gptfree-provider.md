---
name: GPTFree provider
description: How gptfree.com works — Firebase anon auth + Cloud Function streaming endpoint, no account needed.
---

## Endpoint
`POST https://us-central1-gptfree-2.cloudfunctions.net/agent_stream`

## Auth
Firebase anonymous auth — no account or email required.
- Sign up: `POST https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyBdU-Np8RSh1tPSsPOWg3qIm6PnVK5PQb4`
- Body: `{"returnSecureToken":true}`
- Returns: `idToken` (valid 60 min)
- Use as: `Authorization: Bearer {idToken}`

**Why:** gptfree.com uses Firebase anonymous auth to track usage per-UID without requiring registration. Token rotation (new anonymous user) is the natural refresh strategy.

## Request format
```json
{
  "message": "the current user message (last user turn)",
  "images": [],
  "history": [
    {"type": "user", "content": "..."},
    {"type": "assistant", "content": "..."}
  ]
}
```
- System prompt: prepend to the `message` field (gptfree has no system role in history).
- Prior turns: go in `history` array with type `"user"` or `"assistant"`.

## Response format (SSE)
```
event: keepalive
data: {}

event: result
data: {"response": "...", "timestamp": 1234567890}
```
- `event: keepalive` — heartbeat while processing (ignore)
- `event: result` — final answer in `data.response`

**How to apply:** Only emit provider response when `currentEvent === "result"` and data has a `response` field. Reset `currentEvent` on blank lines.

## Token caching
- Cache token in-process, refresh when `Date.now() >= expiresAt`
- Set TTL to 55 min (5 min before actual 60-min Firebase expiry)
- Use mutex lock (`_tokenLock` promise) to avoid thundering herd on concurrent requests

## Firebase project
- Project ID: `gptfree-2`
- Auth domain: `gptfree-2.firebaseapp.com`
- Functions region: `us-central1`
