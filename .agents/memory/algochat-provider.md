---
name: AlgoChat provider
description: Reverse-engineered algochat.app — Gemini 3 Flash Preview via guest cookie session. Critical gotcha with message parts field.
---

## Endpoint & Auth
- Guest session via cookie (no account needed)
- `POST https://algochat.app/api/session` with body `{"platform":"web","metadata":{"platform":"web"}}` — sets `algochat_session` + `algochat_user` cookies
- `POST https://algochat.app/api/create-chat` with `{"model":"google/gemini-3-flash-preview"}` — get chatId
- `POST https://algochat.app/api/chat` — actual chat

## Critical: Message Format
Every message MUST include both `content` (string) AND `parts` (array). Without `parts`, server returns HTTP 500 "Cannot read properties of undefined (reading 'map')".

```json
{
  "messages": [{"id":"msg-0","role":"user","content":"...","parts":[{"type":"text","text":"..."}]}],
  "chatId": "uuid",
  "model": "google/gemini-3-flash-preview",
  "webSearchEnabled": false
}
```

**Why:** Server uses Vercel AI SDK which internally maps over `message.parts`. If `parts` is absent, `.map()` is called on `undefined`.

## Response Format
Vercel AI SDK Data Stream Protocol (not standard OpenAI SSE):
```
data: {"type":"text-delta","id":"0","delta":"Hello"}
data: {"type":"finish","finishReason":"stop"}
data: [DONE]
```
Parse by extracting `ev.delta` from `type === "text-delta"` events.

## Session Caching
- Cache session cookies to `/tmp/algochat_session_cookies.txt` (curl cookie jar format)
- Cache session meta (sessionId, userId, createdAt) to `/tmp/algochat_session_meta.json`
- TTL: 4 hours — refresh automatically when expired

## Models
- `algochat` — primary model ID
- `gemini-3-flash-preview` — alias

## Other Notes
- Referer header `https://algochat.app/chat/{chatId}` must be sent with each chat request
- Uses curl with `--tlsv1.2` (standard TLS, not TLS fingerprint bypass needed)
- Create new chatId per request (don't reuse — accumulates server-side history)
- Rate limits: not observed yet, but guest sessions may be limited per IP
