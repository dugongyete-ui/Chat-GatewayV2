---
name: ChatAIBot Provider
description: Reverse-engineered chataibot.pro promo-chat endpoint, no auth needed, 5 req/IP rate limit
---

## Endpoint
`POST https://chataibot.pro/api/promo-chat/messages`

## Payload
```json
{"messages":[{"role":"user","content":"..."}],"model":"upstream-model-id"}
```

## Response
- Success: `{"answer":"text"}` (HTTP 200)
- Rate limited: `{"message":"Вы превысили лимит 5 запросов без регистрации","type":"PromoChatLimitReachedError"}` (HTTP 403)

## Auth
None required. No cookies, no JWT. Just `x-distribution-channel: web` header.

## Model IDs (upstream → chataibot model ID used in gateway)
- `claude-haiku-4-5` → `chataibot-claude-haiku`
- `claude-sonnet-4-5` → `chataibot-claude-sonnet`
- `deepseek-r1` → `chataibot-deepseek-r1`
- `gpt-4.1-nano` → `chataibot-gpt4-nano`

## Rate limit
5 requests per IP per session (anon mode). Reset is time-based (unclear interval).

**Why:** chataibot.pro uses Next.js with a promo-chat API for anonymous users. The `/api/message` endpoint requires JWT auth but `/api/promo-chat/messages` is open. Discovered by scanning JS chunks (chunk `8791-0accded0b4fb088d.js`).

**How to apply:** When rate limit is hit, the provider throws — v1.ts catches this and returns 502 with the rate limit message. No retry logic needed since it's IP-based.
