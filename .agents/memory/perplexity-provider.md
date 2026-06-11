---
name: Perplexity provider
description: Guest API recon, working models, rate limit behavior, and SSE response format
---

## Endpoint
POST `https://www.perplexity.ai/rest/sse/perplexity_ask`

## Auth
None required — IP-based guest access. No cookies needed.

## Working model_preference values (guest/no-auth)
- `turbo` → fast, works ✅
- `default` → slower/quality, untested but expected to work ✅
- `sonar` → INVALID_MODEL_SELECTION ❌ (paid account required)
- `r1` → INVALID_MODEL_SELECTION ❌ (paid account required)

## SSE Response format
Events arrive as `event: message\ndata: {...}\n\n`.
Text tokens arrive in: `blocks[].markdown_block.chunks[]` when `intended_usage === "ask_text_0_markdown"`.
- `chunk_starting_offset` = absolute char offset for that chunk
- Each chunk is typically 1-30 characters
- Perplexity re-sends a full-text duplicate chunk at offset 0 at the end — use **first-seen-wins per offset** to deduplicate
- End signal: `final: true` in the last message (NOT `final_sse_message`)
- `ask_text` blocks mirror `ask_text_0_markdown` — skip to avoid duplicates

## Rate limits (guest IP)
- **Light**: ~5 req/min — resets in 1-2 minutes
- **Daily**: ~15-20 req/day per IP — resets at **00:00 UTC** (07:00 WIB)
- When rate-limited: valid SSE metadata events are returned but NO text blocks (`ask_text_0_markdown` never appears)
- Detection: `raw.includes("backend_uuid") && !raw.includes("ask_text_0_markdown")`

## Rate-limited response pattern
Response has `backend_uuid`, `context_uuid`, mode info — looks valid — but delivers 0 or partial text blocks. This is the rate-limit signature.

**Why:** Perplexity's guest API is IP-rate-limited. Datacenter IPs get the same limit as residential. Heavy recon testing (20+ requests) in one day exhausts the daily quota.

**How to apply:** After implementing, test with ≤3 requests per session. If the next day's tests show empty parse result with backend_uuid present, wait for 00:00 UTC reset.

## Implementation notes
- Use `execSync` curl with `--tlsv1.3` to bypass Cloudflare TLS fingerprint
- Required headers: `accept: text/event-stream`, `x-perplexity-request-reason: perplexity-query-state-provider`, `origin/referer: https://www.perplexity.ai`
- Provider file: `artifacts/api-server/src/lib/perplexity-provider.ts`
- Models registered: `perplexity`, `perplexity-turbo`, `perplexity-pro`
