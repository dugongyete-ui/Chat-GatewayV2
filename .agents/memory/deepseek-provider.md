---
name: DeepSeek provider
description: Web scraping via chat.deepseek.com — auth, PoW WASM, SSE multi-format parser, createSession structure.
---

# DeepSeek Provider (chat.deepseek.com)

**Auth**: `DEEPSEEK_TOKEN` env var — Bearer token from chat.deepseek.com session cookie.

**PoW**: SHA3 WASM solver at `artifacts/api-server/src/lib/sha3_wasm.wasm` (copied to `dist/` at build time via build.mjs). Endpoint: `POST /api/v0/chat/create_pow_challenge` → solve → base64 JSON → header `x-ds-pow-response`.

**Session**: `POST /api/v0/chat_session/create` returns either:
- `data.biz_data.id` (most common)
- `data.biz_data.chat_session.id` (older format, A/B tested)
- Code handles both: `bd?.id ?? bd?.chat_session?.id`

**Chat endpoint**: `POST /api/v0/chat/completion`
- `model_type: "default"` for all models
- `thinking_enabled: true` for R1 (deepseek-reasoner)
- `search_enabled: true` for deepseek-search

## SSE Response Formats (ALL must be handled — DeepSeek A/B tests these)

**FORMAT A — Fast/cached: content pre-loaded in initial state blob**
```
data: {"v":{"response":{"fragments":[{"content":"full answer here"},...]},...}}
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":43},{"p":"quasi_status","v":"FINISHED"}]}
```
→ Extract `v.response.fragments[].content` from the initial state blob.

**FORMAT B — Streaming, old-style patches**
```
data: {"v":{"response":{...empty...}}}
data: {"p":"response/content","o":"APPEND","v":"tok"}
data: {"v":" next"}    ← subsequent tokens have no p field
```

**FORMAT C — Streaming, fragments path**
```
data: {"v":{"response":{...}}}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":"tok"}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":" next"}
```

**FORMAT D — BATCH with nested content patches**
```
data: {"p":"response","o":"BATCH","v":[{"p":"fragments/-1/content","o":"APPEND","v":"tok"},...]}
```
→ Resolve relative paths: `${base}/${sub.p}` and check isContentPath.

## isContentPath rule
```typescript
p === "response/content" || /^response\/fragments\/[-\d]+\/content$/.test(p)
```

**Why**: DeepSeek heavily A/B tests SSE formats. The initial state blob may contain the full answer (especially for short/cached queries). If parser only looks for streaming patches, it will return empty content for cached responses.

**How to apply**: Always parse initial state blob for content first, then fall through to streaming patch formats.
