---
name: Kimi provider (Moonshot AI)
description: How the Kimi Connect RPC integration works — critical framing and auth details.
---

# Kimi Provider

## The Key Insight
The endpoint `https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat` uses **Connect RPC binary framing on BOTH request and response**, even with `Content-Type: application/connect+json`. Sending raw JSON (no frame) always returns `{"error":{"code":"invalid_argument"}}`.

## Request Frame Format
```
[0x00][4-byte big-endian length][JSON body]
```
- Byte 0: flags = `0x00` (regular message)
- Bytes 1–4: length of JSON as uint32 big-endian
- Bytes 5+: UTF-8 JSON body

## Request Body
```json
{
  "scenario": "SCENARIO_K2",
  "message": {
    "role": "user",
    "blocks": [{"message_id": "", "text": {"content": "<prompt>"}}],
    "scenario": "SCENARIO_K2"
  },
  "options": {"thinking": false}
}
```
- For multi-turn: concatenate all messages into one `user` prompt (role:content\n format)
- `chatId` field only added when continuing an existing conversation
- Scenarios: `SCENARIO_K2` (default), `SCENARIO_SEARCH`, `SCENARIO_RESEARCH`, `SCENARIO_K1`

## Required Headers
| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <JWT>` |
| `Content-Type` | `application/connect+json` |
| `Connect-Protocol-Version` | `1` |
| `X-Msh-Device-Id` | from JWT `device_id` field |
| `X-Traffic-Id` | from JWT `sub` field |
| `X-Msh-Session-Id` | from JWT `ssid` field |
| `X-Msh-Platform` | `web` |
| `X-Msh-Version` | `1.0.0` |
| `R-Timezone` | `Asia/Jakarta` |

## Response Frame Parsing
Response uses HTTP chunked transfer encoding wrapping Connect frames. Node.js fetch handles chunking automatically — just read the body stream and parse Connect frames:
- `msg.block.text.content` where `msg.op === "set" | "append"` → streaming text tokens
- `msg.chat.id` → chat ID for session continuity
- `msg.done` → stream finished
- `msg.error` → error (token expired, rate limit, etc.)

## Auth / Token
- JWT from `kimi-auth` cookie on `www.kimi.com`
- JWT fields: `sub` (userId), `device_id`, `ssid` (sessionId)
- Store as `KIMI_TOKEN` env var (shared environment)
- Token has expiry (`exp` field in JWT) — rotate when expired

**Why:** The Connect RPC protocol wraps JSON in a 5-byte envelope even when using the JSON codec. The Kimi web app JS (`encodeConnectMessage` in connect-rpc/protocol.ts from dugongyete-ui/ApiAi-Kimi repo) confirmed this pattern. Plain JSON without the envelope always gets `invalid_argument`.

## Interface Compliance (Fixed June 2026)
`kimiStream` was originally broken — it buffered all tokens via callback then yielded ONE chunk at the end. It also used a separate `kimiStreamTokens` (callback-based) function in v1.ts, violating the standard AsyncGenerator interface.

**Correct pattern now:**
- `kimiStream` inlines the Connect frame parser directly as an `async function*` — yields each text token as it arrives from the reader loop
- `kimiChat` uses `for await (const token of kimiStream(...))` internally
- v1.ts uses `for await (const token of kimiStream(...))` — consistent with all other providers
- `buildPrompt` handles `role: "tool"` messages explicitly (not silently coerced to "user")

**Why this matters:** The callback-based approach (`kimiStreamTokens`) could not be used in `for await` loops, so v1.ts had a one-off non-standard integration that would break if the standard streaming path was refactored.

## Web Search Limitation (kimi-search / kimi-research)

`kimi-search` and `kimi-research` (SCENARIO_SEARCH / SCENARIO_RESEARCH) do **NOT** execute real web searches via Connect RPC. When chatting directly on kimi.com, Kimi's backend infrastructure intercepts `<search>` tags and runs actual searches. Via our Connect RPC endpoint, this infrastructure layer is bypassed — the model outputs `<search>`, `<<tool>web_search</tool>`, `<<query>` etc. as literal text, then answers from training knowledge only.

**Fix:** `cleanKimiOutput()` in `kimi-provider.ts` strips all these internal tags (multiple format variants observed: `<search>`, `<<tool>`, `<<query>`, block XML variants) from the output. Applied in both `kimiChat` (non-streaming) and in v1.ts on `kmCollected` (streaming path).

**Result:** Output is clean text without internal tags, but data remains training-based, not real-time.
