---
name: g4f-style-recon
description: Metodologi reverse-engineering website AI seperti gpt4free — untuk menemukan endpoint API tersembunyi, bypass auth, dan mengintegrasikan provider AI gratis tanpa API key resmi. Gunakan ketika user ingin "test web AI ini", "coba reverse engineer", "cari endpoint gratis", atau membangun provider AI baru.
---

# G4F-Style AI Website Recon

Metodologi ini terinspirasi dari [gpt4free](https://github.com/xtekky/gpt4free) — project Python yang mengumpulkan endpoint AI gratis dari berbagai website dengan cara merekayasa balik request browser mereka.

## ⚠️ ATURAN WAJIB — Standar "Setara OpenAI untuk AI Agent Otonom"

Setiap provider yang diimplementasikan **WAJIB** mendukung seluruh fitur berikut agar setara dengan OpenAI resmi dan kompatibel dengan AI agent otonom (Manus, AutoGPT, CrewAI, LangChain, dll):

| Fitur | Wajib | Keterangan |
|---|---|---|
| **Streaming SSE** | ✅ WAJIB | `stream: true` kirim SSE chunks OpenAI-format |
| **Non-streaming** | ✅ WAJIB | `stream: false` return JSON lengkap |
| **Tool / Function calling** | ✅ WAJIB | Deteksi JSON `{"tool_calls":[...]}` dari output model via `detectToolCalls()` — **wajib di streaming DAN non-streaming** |
| **Streaming tool_calls SSE** | ✅ WAJIB | Streaming dengan tools: buffer full response → detectToolCalls → emit SSE `tool_calls` events (bukan text chunks). Format identik Qwen |
| **Multi-tool parallel** | ✅ WAJIB | Satu response bisa return lebih dari 1 tool call |
| **Tool results loop** | ✅ WAJIB | `role: "tool"` di messages harus di-handle di `messagesToPrompt()` |
| **Vision / Image** | ✅ WAJIB | Kalau provider native support → kirim langsung. Kalau tidak → pakai `flattenVisionMessages()` sebagai fallback via Qwen |
| **System prompt** | ✅ WAJIB | |
| **JSON mode** | ✅ WAJIB | `response_format: {type: "json_object"}` inject instruksi JSON ke system |
| **`finish_reason`** | ✅ WAJIB | `"stop"`, `"length"`, `"tool_calls"` |
| **Token usage lengkap** | ✅ WAJIB | `prompt_tokens`, `completion_tokens`, `total_tokens` + `prompt_tokens_details: {cached_tokens: 0, audio_tokens: 0}` + `completion_tokens_details: {reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0}` |
| **`max_tokens` + `max_completion_tokens`** | ✅ WAJIB | Support keduanya via `applyMaxTokens()` — **wajib di streaming DAN non-streaming** |
| **`stop` sequences** | ✅ WAJIB | Post-process via `applyStop()` — **wajib di streaming DAN non-streaming** |
| **`temperature`, `top_p`** | ✅ WAJIB | Kirim ke provider kalau didukung, ignore kalau tidak |
| **`stream_options.include_usage`** | ✅ WAJIB | Kirim `sseUsageChunk()` di akhir SSE kalau `includeUsage === true` |
| **`n > 1` validation** | ✅ WAJIB | Return `400` dengan `unsupported_value` jika `n > 1` — sudah di-handle global di v1.ts, tidak perlu per-provider |
| **Model capabilities metadata** | ✅ WAJIB | Entry di `MODELS[]` dengan `capabilities: {vision, tools, json_mode, streaming}` dan `context_window` |

**TIDAK BOLEH** menambah provider yang hanya support chat biasa tanpa tool calling dan streaming — itu tidak berguna untuk AI agent otonom.

**TIDAK BOLEH** implementasi setengah-setengah — semua fitur di atas wajib ada sekaligus, baik di streaming maupun non-streaming path. Jangan skip usage details, stop sequences, atau tool detection di salah satu path.

---

## Alur Kerja (Urutan Wajib)

### FASE 1 — Profiling Website

```bash
# 1. Cek headers & cookies website
curl -s -I "https://target.ai/" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36" \
  --max-time 10

# 2. Probe endpoint umum sekaligus
for ep in "/v1/models" "/api/models" "/api/v1/models" "/api/config" \
          "/v1/chat/completions" "/api/chat/completions" "/auth/login" \
          "/api/v1/auths/" "/openai/v1/chat/completions"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://target.ai$ep" \
    -H "User-Agent: Mozilla/5.0 Chrome/138.0.0.0" --max-time 8 2>/dev/null)
  echo "$code  $ep"
done
```

**Interpretasi kode HTTP:**
- `200` = endpoint terbuka, test langsung
- `401` = endpoint ada, butuh auth — cari cara dapat token
- `403` = ada tapi blocked — coba bypass header
- `404` = tidak ada di path ini — coba variasi lain
- `405` = Method Not Allowed — coba method berbeda (GET/POST)
- `307/302` = redirect — follow redirectnya

### FASE 2 — Ekstrak Endpoint dari Source JS

```bash
# Ambil HTML dan cari file JS bundle utama
curl -s "https://target.ai/" | grep -oE 'src="[^"]+\.js"' | head -5

# Download JS bundle dan cari pattern endpoint
JS_URL="https://cdn.target.ai/assets/index-XXXX.js"
curl -s "$JS_URL" --max-time 30 | grep -oE '"(/api[^"]{0,80})"' | sort -u | head -30

# Cari fetch() calls dengan endpoint
curl -s "$JS_URL" --max-time 30 | grep -oE 'fetch\(`[^`]{0,100}`' | head -20

# Cari pola chat/completions
curl -s "$JS_URL" --max-time 30 | grep -oE '\$\{[a-zA-Z_]+\}/[a-z/]+completions' | head -10

# Cari base URL variable (biasanya: WEBUI_BASE_URL, apiUrl, baseUrl, dll)
curl -s "$JS_URL" --max-time 30 | grep -oE 'WEBUI_BASE_URL[^,;]{0,100}' | head -5
```

### FASE 3 — Cari Mekanisme Auth

**Pola auth yang umum ditemukan:**

#### A. Guest/Anonymous Token (paling bagus — tanpa registrasi)
```bash
# Open WebUI style — GET auth endpoint auto-buat guest account
curl -s "https://target.ai/api/v1/auths/" \
  -H "User-Agent: Mozilla/5.0 Chrome/138.0.0.0" \
  -H "Accept: application/json"
# Kalau dapat token → langsung pakai sebagai Bearer token
```

#### B. Login Email/Password
```bash
curl -s -X POST "https://target.ai/api/v1/auths/signin" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123"}'
```

#### C. Cookie-Based (browser session)
```bash
# Simpan cookie dari login
curl -s -c /tmp/cookies.txt "https://target.ai/login" \
  -H "User-Agent: Mozilla/5.0 Chrome/138.0.0.0"
# Gunakan cookie untuk request berikutnya
curl -s -b /tmp/cookies.txt "https://target.ai/api/chat/completions" ...
```

#### D. Tanpa Auth Sama Sekali (Perplexity, PollinationsAI style)
```bash
# Langsung test endpoint dengan Chrome headers lengkap + TLS 1.3
curl -s -X POST "https://target.ai/api/endpoint" \
  --tlsv1.3 \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36" \
  -H "Origin: https://target.ai" \
  -H "Referer: https://target.ai/" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"...":"..."}'
```

### FASE 4 — Test Chat Completion

Setelah dapat token/cookie:

```bash
TOKEN="..."

# Non-streaming test
curl -s -X POST "https://target.ai/ENDPOINT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 Chrome/138.0.0.0" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"say hi in one sentence"}],"stream":false}' \
  --max-time 30

# Streaming test
curl -s -X POST "https://target.ai/ENDPOINT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"say hi"}],"stream":true}' \
  --max-time 30 | head -50
```

### FASE 5 — Test Tool Calling

Provider wajib support tool calling. Kalau native tidak support, pakai prompt injection + `detectToolCalls()` (lihat implementasi di `v1.ts` → `injectToolPrompt()`):

```bash
# Test apakah provider bisa return JSON tool call format
TOKEN="..."
curl -s -X POST "https://target.ai/ENDPOINT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"MODEL_ID",
    "messages":[{"role":"user","content":"What is the weather in Jakarta? You must call the get_weather tool.\n\n{\"tool_calls\":[{\"name\":\"get_weather\",\"arguments\":{\"location\":\"Jakarta\"}}]}"}],
    "stream":false
  }' --max-time 30
# Kalau model return format {"tool_calls":[...]} → native tool calling bisa dipakai
# Kalau tidak → pakai injectToolPrompt() + detectToolCalls() (prompt injection)
```

### FASE 6 — Identifikasi Format Response & Vision Support

**Format SSE (Server-Sent Events) — paling umum untuk streaming:**
```
event: message
data: {"choices":[{"delta":{"content":"Hello"}}]}

event: message
data: [DONE]
```

**Format OpenAI-compatible (paling mudah):**
```json
{"choices":[{"message":{"role":"assistant","content":"Hello!"}}]}
```

**Format custom (contoh Perplexity):**
```json
{"blocks":[{"diff_block":{"field":"markdown_block","patches":[{"value":{"answer":"Hello..."}}]}}]}
```

**Cek apakah provider support vision (kirim image_url):**
```bash
curl -s -X POST "https://target.ai/ENDPOINT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":[
    {"type":"text","text":"What is in this image?"},
    {"type":"image_url","image_url":{"url":"https://picsum.photos/200"}}
  ]}],"stream":false}' --max-time 30
# 200 dengan konten = native vision support
# Error/ignored = tidak support → wajib pakai flattenVisionMessages() fallback
```

---

## Checklist Perlindungan yang Sering Ditemui

| Proteksi | Cara Bypass |
|---|---|
| Cloudflare | Pakai `--tlsv1.3` + Chrome User-Agent |
| Captcha signup | Cari endpoint guest/anonymous tanpa captcha |
| `X-Signature` / HMAC | Reverse-engineer dari JS bundle |
| Rate limiting | Rotasi UUID/session per request |
| IP block | Tidak bisa bypass dari server |
| Token expiry | Re-fetch token tiap request atau cache TTL pendek |
| Hotlink protection gambar | Gunakan curl dengan Referer + Chrome UA (sudah handled di `fetchImageBytes()`) |

---

## Provider yang Sudah Terimplementasi

### 1. Qwen (Provider Utama — Native Vision)
- **File:** `artifacts/api-server/src/lib/umid-pool.ts` + logic di `v1.ts`
- **Auth:** Pool 2000 `bx-umidtoken` (rotasi round-robin), auto-refresh
- **Vision:** ✅ Native — upload ke Qwen OSS via STS token + HMAC-SHA1, semua model Qwen support
- **Image fetch:** `fetchImageBytes()` di `v1.ts` — pakai Node.js fetch dulu, fallback ke curl untuk hotlink-protected URL (Wikipedia, Cloudflare, dll)
- **Tools:** ✅ Via prompt injection `injectToolPrompt()` + `detectToolCalls()`
- **Streaming:** ✅ Native SSE dari chat.qwen.ai, parse `output_schema: "answer"` chunks
- **Models:** `qwen3.7-max`, `qwen3.6-plus`, `qwen3.6-max-preview`, `qwen3-235b-a22b`, `qwen3-30b-a3b`, `qwen-max-latest`, `qwen-turbo-latest`, `qwen2.5-coder-32b-instruct`, `qwen-vl-max-latest`, `qwen2.5-vl-72b-instruct`
- **Catatan:** Model alias panjang di `MODEL_ALIASES{}` — hampir semua nama model OpenAI/Qwen di-map ke model yang tersedia

### 2. Opera Aria
- **File:** `artifacts/api-server/src/lib/aria-provider.ts`
- **Auth:** 2 tahap — step 1 dapat `authToken`, step 2 tukar ke `access_token`. **KRITIS: step 2 HARUS tanpa User-Agent header**
- **Vision:** ⚡ Fallback — gambar dianalisis Qwen dulu via `flattenVisionMessages()`, hasilnya dikirim sebagai teks
- **Tools:** ✅ Via prompt injection
- **Streaming:** ✅ Via `execSync` curl (bukan Node.js fetch) karena masalah TLS fingerprint
- **Model ID:** `aria`

### 3. Yqcloud
- **File:** `artifacts/api-server/src/lib/yqcloud-provider.ts`
- **Auth:** Tidak perlu — pool 200 `userId` UUID rotasi round-robin
- **Endpoint:** `POST https://api.binjie.fun/api/generateStream`
- **Vision:** ⚡ Fallback via `flattenVisionMessages()`
- **Tools:** ✅ Via prompt injection
- **Streaming:** ✅ Response body adalah plain text stream (bukan SSE), langsung pipe
- **Models:** `yqcloud`, `yqcloud-gpt4`

### 4. Cohere (via HuggingFace Space)
- **File:** `artifacts/api-server/src/lib/cohere-provider.ts`
- **Auth:** Tidak perlu — HuggingFace public space. Pool 10 conversation slot per model, rotasi untuk spread rate limit
- **Endpoint:** `https://coherelabs-c4ai-command.hf.space`
- **Vision:** ⚡ Fallback via `flattenVisionMessages()`
- **Tools:** ✅ Via prompt injection
- **Streaming:** ✅ Via async generator, parse `{type:"stream", token:"..."}` chunks
- **Models:** `command-a`, `command-a-03-2025`, `command-r-plus`, `command-r`, `command-r7b`

### 5. Perplexity AI
- **File:** `artifacts/api-server/src/lib/perplexity-provider.ts`
- **Auth:** Tidak perlu — guest mode tanpa akun
- **Endpoint:** `POST https://www.perplexity.ai/rest/sse/perplexity_ask` (underscore, bukan hyphen)
- **Vision:** ⚡ Fallback via `flattenVisionMessages()`
- **Tools:** ✅ Via prompt injection
- **Streaming:** ✅ Via execSync curl dengan `--tlsv1.3`, parse SSE `data:` events, field `answer` dari `patches[].value`
- **Models:** `perplexity` (alias ke `turbo`)
- **Rate limit:** ~15–20 req/hari per IP, reset 00:00 UTC
- **Catatan:** Hanya `model_preference: "turbo"` atau `"default"` yang berfungsi tanpa auth

### 7. AlgoChat (Gemini 3 Flash Preview)
- **File:** `artifacts/api-server/src/lib/algochat-provider.ts`
- **Auth:** Guest session via cookie — `POST /api/session` → dapat `algochat_session` + `algochat_user` cookie (TTL ~4 jam, cache di `/tmp/algochat_session_cookies.txt`)
- **Flow per request:** `ensureSession()` → `POST /api/create-chat` (buat chatId baru) → `POST /api/chat`
- **Endpoint chat:** `POST https://algochat.app/api/chat`
- **Payload WAJIB:**
  ```json
  {
    "messages": [{"id":"msg-0","role":"user","content":"...","parts":[{"type":"text","text":"..."}]}],
    "chatId": "uuid-from-create-chat",
    "model": "google/gemini-3-flash-preview",
    "webSearchEnabled": false
  }
  ```
  ⚠️ **KRITIS:** Field `parts` wajib ada di setiap message — tanpanya server return 500 "Cannot read properties of undefined (reading 'map')"
- **Response format:** Vercel AI SDK Data Stream Protocol — parse `{"type":"text-delta","delta":"..."}` events
- **Vision:** ⚡ Fallback via `flattenVisionMessages()`
- **Tools:** ✅ Via prompt injection
- **Models:** `algochat`, `gemini-3-flash-preview`
- **Streaming:** ✅ Via execSync curl, parse Vercel AI SDK stream
- **Catatan:** Referer header `https://algochat.app/chat/{chatId}` wajib disertakan

### 6. GPTFree
- **File:** `artifacts/api-server/src/lib/gptfree-provider.ts`
- **Auth:** Firebase anonymous auth (tanpa akun) — auto-renew token
- **Endpoint:** `https://us-central1-gptfree-2.cloudfunctions.net/agent_stream`
- **Vision:** ⚡ Fallback via `flattenVisionMessages()`
- **Tools:** ✅ Via prompt injection
- **Streaming:** ✅ SSE `event:result` chunks
- **Payload:** `{ message, images:[], history:[{type, content}] }`
- **Models:** `gptfree`

### 8. Kimi (Moonshot AI via Connect RPC)
- **File:** `artifacts/api-server/src/lib/kimi-provider.ts`
- **Auth:** JWT dari `kimi-auth` cookie → simpan di `KIMI_TOKEN` env var. Parse field `sub`, `device_id`, `ssid` dari JWT untuk headers.
- **Endpoint:** `POST https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat`
- **Protocol:** Connect RPC binary framing — request dan response WAJIB pakai 5-byte envelope (1 byte flags + 4 byte length BE + JSON body)
- **Vision:** ⚡ Fallback via `flattenVisionMessages()`
- **Tools:** ✅ Via prompt injection
- **Streaming:** ✅ AsyncGenerator — parse Connect RPC frames dari reader loop, yield tiap token saat tiba
- **Models:** `kimi-k2`, `kimi-search`, `kimi-research`
- **Scenarios:** `SCENARIO_K2` (default), `SCENARIO_SEARCH`, `SCENARIO_RESEARCH`, `SCENARIO_K1`
- **⚠️ LIMITASI PENTING — Web Search via kimi-search/kimi-research:**
  Saat kamu chat langsung di kimi.com, backend Kimi mendeteksi tag `<search>`, mengeksekusi web search server-side, lalu hasilnya dikembalikan ke model (hasil akurat + real-time). Via Connect RPC langsung, infrastruktur search ini **tidak dijalankan** — model hanya output tag `<search>` / `<<tool>web_search</tool>` sebagai teks, lalu menjawab berdasarkan training knowledge (bukan data real-time).
  **Solusi:** `cleanKimiOutput()` di `kimi-provider.ts` otomatis strip semua internal tags (`<search>`, `<<tool>`, `<<query>`, dll) agar output tetap bersih. Tapi datanya tetap dari training, bukan web search nyata.

---

## Standar Interface Wajib — SEMUA Provider HARUS Sama

Setiap provider file **wajib** mengekspor 4 hal berikut dengan nama dan signature yang konsisten:

```typescript
// 1. Tipe message (export — dipakai v1.ts)
export interface ChatMessage { role: string; content: string; }

// 2. Daftar model
export const PROVIDER_MODELS = [
  { id: "model-id", object: "model", created: 1700000000, owned_by: "provider" },
];

// 3. Cek apakah model ini milik provider
export function isProviderModel(model: string): boolean {
  return PROVIDER_MODELS.some(m => m.id === model);
}

// 4a. Streaming — AsyncGenerator<string> (BUKAN Promise<Readable>, BUKAN callback)
export async function* providerStream(
  messages: ChatMessage[],
  model = "default-model",
): AsyncGenerator<string> { /* ... yield token */ }

// 4b. Non-streaming — WAJIB return inputTokens + outputTokens
export async function providerChat(
  messages: ChatMessage[],
  model = "default-model",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const token of providerStream(messages, model)) content += token;
  const trimmed = content.trim();
  return {
    content: trimmed,
    inputTokens: Math.round(messages.map(m => m.content).join("").length / 4),
    outputTokens: Math.round(trimmed.length / 4),
  };
}
```

**Aturan interface wajib:**
- Stream harus `AsyncGenerator<string>` — **BUKAN** `Promise<Readable>` dan **BUKAN** callback-based
- Chat harus return `{ content, inputTokens, outputTokens }` — tiga field, tidak boleh hanya `{ content }`
- Kedua fungsi harus menerima `(messages: ChatMessage[], model?)` — urutan param wajib sama
- `PROVIDER_MODELS` harus di-spread ke `MODELS[]` di v1.ts, bukan hardcoded
- `isProviderModel` wajib digunakan di v1.ts, bukan `model === "nama"` hardcoded

**Status konsistensi semua provider saat ini (Juni 2026):**

| Provider | `MODELS` export | `isModel()` | `stream(msgs,model)` AsyncGen | `chat(msgs,model)` + tokenCounts |
|---|---|---|---|---|
| **Aria** | ✅ `ARIA_MODELS` | ✅ `isAriaModel` | ✅ `ariaStream` | ✅ `ariaChat` |
| **Yqcloud** | ✅ `YQCLOUD_MODELS` | ✅ `isYqcloudModel` | ✅ `yqcloudStream` | ✅ `yqcloudChat` |
| **Cohere** | ✅ `COHERE_MODELS` | ✅ `isCohereModel` | ✅ `cohereStream` | ✅ `cohereChat` |
| **Perplexity** | ✅ `PERPLEXITY_MODELS` | ✅ `isPerplexityModel` | ✅ `perplexityStream` | ✅ `perplexityChat` |
| **GPTFree** | ✅ `GPTFREE_MODELS` | ✅ `isGptfreeModel` | ✅ `gptfreeStream` | ✅ `gptfreeChat` |
| **AlgoChat** | ✅ `ALGOCHAT_MODELS` | ✅ `isAlgochatModel` | ✅ `algochatStream` | ✅ `algochatChat` |
| **Kimi** | ✅ `KIMI_MODELS` | ✅ `isKimiModel` | ✅ `kimiStream` | ✅ `kimiChat` |

---

## Template Implementasi Provider Lengkap (Node.js/TypeScript)

Gunakan template ini sebagai dasar setiap provider baru. **Semua bagian wajib diisi.**

```typescript
// artifacts/api-server/src/lib/{nama}-provider.ts

import { execSync } from "child_process";
import { logger } from "./logger";

export interface ChatMessage { role: string; content: string; }

// ── Token/Session cache ───────────────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const resp = await fetch("https://target.ai/api/v1/auths/", {
    headers: { "User-Agent": "Mozilla/5.0 Chrome/138.0.0.0" }
  });
  const data = await resp.json() as { token: string };
  cachedToken = data.token;
  tokenExpiry = Date.now() + 3600_000;
  return cachedToken!;
}

// ── Streaming (AsyncGenerator — WAJIB, bukan Promise<Readable>) ───────────────
export async function* providerStream(
  messages: ChatMessage[],
  model = "default-model",
): AsyncGenerator<string> {
  const token = await getToken();
  const body = JSON.stringify({ model, messages, stream: true });

  const raw = execSync(
    `curl -sN -X POST "https://target.ai/v1/chat/completions" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      -H "User-Agent: Mozilla/5.0 Chrome/138.0.0.0" \
      --tlsv1.2 --max-time 120 \
      -d '${body.replace(/'/g, "'\\''")}'`,
    { maxBuffer: 20 * 1024 * 1024 },
  ).toString();

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") break;
    try {
      const json = JSON.parse(data);
      const content = json.choices?.[0]?.delta?.content ?? "";
      if (content) yield content;
    } catch { /* skip malformed */ }
  }
}

// ── Non-streaming (WAJIB return inputTokens + outputTokens) ───────────────────
export async function providerChat(
  messages: ChatMessage[],
  model = "default-model",
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let content = "";
  for await (const token of providerStream(messages, model)) content += token;
  const trimmed = content.trim();
  return {
    content: trimmed,
    inputTokens: Math.round(messages.map(m => m.content).join("").length / 4),
    outputTokens: Math.round(trimmed.length / 4),
  };
}

// ── Model list (WAJIB export, jangan hardcode di v1.ts) ──────────────────────
export const PROVIDER_MODELS = [
  { id: "provider-model-1", object: "model", created: 1700000000, owned_by: "provider" },
  { id: "provider-model-2", object: "model", created: 1700000000, owned_by: "provider" },
];

export function isProviderModel(model: string): boolean {
  return PROVIDER_MODELS.some(m => m.id === model);
}
```

---

## Cara Integrasi ke v1.ts (Wajib Ikuti Pola Ini)

Setelah provider selesai, integrasi ke `artifacts/api-server/src/routes/v1.ts`:

### 1. Import di atas file
```typescript
import { chatProvider, streamProvider, isProviderModel, PROVIDER_MODELS } from "../lib/nama-provider";
```

### 2. Tambah ke MODELS[] dengan capabilities (wajib)
```typescript
const MODELS: ModelEntry[] = [
  // ... provider lain ...
  ...PROVIDER_MODELS.map(m => ({
    ...m,
    capabilities: {
      vision: false,    // true kalau native vision, false kalau hanya fallback
      tools: true,      // selalu true (via prompt injection)
      json_mode: false, // true kalau reliable
      streaming: true,  // selalu true
    },
    context_window: 32768,  // sesuaikan dengan limit provider
  })),
];
```

### 3. Tambah route di chat/completions — **POLA WAJIB LENGKAP**

```typescript
// Di bagian try{} di router.post("/chat/completions", ...)
// Letakkan SEBELUM blok Qwen provider

if (isProviderModel(model)) {
  // Vision fallback — wajib untuk provider tanpa native vision
  const provEffective = hasImages ? await flattenVisionMessages(effectiveMessages) : effectiveMessages;
  const provMessages = provEffective.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : getMessageText(m.content),
  }));

  // ── STREAMING PATH ──────────────────────────────────────────────────────────
  if (stream) {
    startSSE();

    // WAJIB: Buffer full response terlebih dahulu, baru proses
    // Jangan pipe token langsung — harus buffer untuk tool detection + stop sequences
    let provCollected = "";
    try {
      for await (const token of streamProvider(provMessages, model)) {
        if (token) provCollected += token;
      }
    } catch (err: unknown) {
      logger.warn({ err }, "provider: stream error");
    }

    // WAJIB: Terapkan max_tokens dan stop sequences setelah collect
    const provSsMt = applyMaxTokens(provCollected, _max);
    const provSsSt = applyStop(provSsMt.content, _stop);
    const provFinalText = provSsSt.content;
    const provStreamFinish = (provSsMt.truncated || provSsSt.truncated) ? "length" : "stop";
    const provPromptEst = estimateTokens(messagesToPrompt(provMessages));
    const provOutEst = Math.round(provFinalText.length / 4);

    // WAJIB: Deteksi tool calls — emit SSE tool_calls events (bukan text)
    if (hasTools) {
      const provStreamToolCalls = detectToolCalls(provFinalText);
      if (provStreamToolCalls) {
        res.write(sseChunk({ role: "assistant", content: null }));
        for (let i = 0; i < provStreamToolCalls.length; i++) {
          const tc = provStreamToolCalls[i];
          res.write(sseChunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
          const args = tc.function.arguments;
          for (let j = 0; j < args.length; j += 20) {
            res.write(sseChunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 20) } }] }));
          }
        }
        if (includeUsage) res.write(sseUsageChunk(provPromptEst, provOutEst));
        res.write(sseChunk({}, "tool_calls"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
    }

    // Normal text streaming — emit word-by-word
    res.write(sseChunk({ role: "assistant", content: "" }));
    for (const w of provFinalText.split(/(\s+)/)) {
      if (w) res.write(sseChunk({ content: w }));
    }
    if (includeUsage) res.write(sseUsageChunk(provPromptEst, provOutEst));
    res.write(sseChunk({}, provStreamFinish));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // ── NON-STREAMING PATH ──────────────────────────────────────────────────────
  const { content: provRaw, inputTokens: provIn, outputTokens: provOut } = await chatProvider(provMessages, model);
  if (!provRaw) {
    res.status(502).json({ error: { message: "No response from provider", type: "upstream_error", code: "empty_response" } });
    return;
  }

  // WAJIB: Terapkan max_tokens dan stop sequences
  const provMt = applyMaxTokens(provRaw, _max);
  const provSt = applyStop(provMt.content, _stop);
  const provContent = provSt.content;
  const provFinish = (provMt.truncated || provSt.truncated) ? "length" : "stop";

  // WAJIB: Usage lengkap dengan details (bukan hanya 3 field)
  const provUsage = {
    prompt_tokens: provIn,
    completion_tokens: provOut,
    total_tokens: provIn + provOut,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };

  // WAJIB: Deteksi tool calls
  const provToolCalls = hasTools ? detectToolCalls(provContent) : null;
  if (provToolCalls) {
    res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default",
      system_fingerprint: "fp_provider_gateway",
      choices: [{ index: 0, message: { role: "assistant", refusal: null, content: null, tool_calls: provToolCalls }, logprobs: null, finish_reason: "tool_calls" }],
      usage: provUsage });
    return;
  }
  res.json({ id, object: "chat.completion", created, model: _rawModel, service_tier: "default",
    system_fingerprint: "fp_provider_gateway",
    choices: [{ index: 0, message: { role: "assistant", refusal: null, content: provContent }, logprobs: null, finish_reason: provFinish }],
    usage: provUsage });
  return;
}
```

### 4. Tambah model ke Playground UI — **WAJIB, BUKAN OPSIONAL**

File: `artifacts/gateway/src/pages/playground.tsx` — array `WORKING_MODELS` di bagian atas file.

```typescript
// Tambahkan entry baru di WORKING_MODELS sesuai nama group provider
// ── NamaProvider (deskripsi singkat) ──
{ id: "model-id",       label: "model-id (deskripsi)", group: "NamaGroup" },
{ id: "model-alias",    label: "model-alias",           group: "NamaGroup" },
```

**Aturan wajib:**
- Setiap model ID yang ada di `PROVIDER_MODELS` (provider file) **harus ada** di `WORKING_MODELS` (playground)
- Nama `group` harus konsisten dan deskriptif (contoh: `"AlgoChat"`, `"Perplexity"`, `"GPTFree"`)
- Label boleh menyertakan keterangan singkat dalam kurung, contoh: `"algochat (Gemini 3 Flash Preview)"`
- Setelah edit playground, restart workflow `artifacts/gateway: web` agar perubahan aktif

**Tanpa update ini, provider dianggap belum selesai** — user tidak bisa memilih model di UI.

---

> **Kenapa buffer dulu di streaming?**
> Tool calling via prompt injection menghasilkan JSON di akhir output. Kalau langsung pipe token-by-token ke client, JSON `{"tool_calls":[...]}` ikut terkirim sebagai text biasa dan tidak bisa dideteksi. Dengan buffer → detect → emit ulang sebagai SSE `tool_calls` events, client (OpenAI SDK, LangChain, dll) menerima format yang benar.

---

## Checklist Sebelum Provider Dianggap Selesai

Sebelum commit, jalankan **semua** test di bawah ini. Provider dianggap selesai hanya jika **semua** lulus. Tidak ada pengecualian.

```bash
APIKEY="sk-..."
MODEL="NAMA_MODEL"
BASE="http://localhost:8080"

# ── 1. Non-streaming basic — cek ada content & usage lengkap ────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"say hi in one word\"}]}" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(d);
      const u=j.usage||{};
      console.log('[content]', j.choices?.[0]?.message?.content);
      console.log('[finish_reason]', j.choices?.[0]?.finish_reason);
      console.log('[usage keys]', Object.keys(u).join(', '));
      console.log('[has prompt_tokens_details]', 'prompt_tokens_details' in u);
      console.log('[has completion_tokens_details]', 'completion_tokens_details' in u);
    })"
# LULUS: content berisi teks, finish_reason=stop, usage punya 5 keys termasuk details

# ── 2. Streaming — cek SSE text chunks dan finish chunk ────────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}]}" \
  | grep -E "finish_reason|content" | tail -3
# LULUS: ada chunks dengan content, baris terakhir finish_reason: "stop"

# ── 3. Stop sequences — streaming ──────────────────────────────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"stop\":[\"3\"],\"messages\":[{\"role\":\"user\",\"content\":\"count from 1 to 10 one per line\"}]}" \
  | grep "finish_reason" | tail -1
# LULUS: finish_reason: "length" (berhenti sebelum selesai)

# ── 4. max_tokens — non-streaming ──────────────────────────────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":false,\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"write a long story\"}]}" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(d);
      console.log('[finish_reason]', j.choices?.[0]?.finish_reason);
      console.log('[completion_tokens]', j.usage?.completion_tokens);
    })"
# LULUS: finish_reason=length, completion_tokens <= 10 (estimasi ~2x max_tokens)

# ── 5. Tool calling — non-streaming ────────────────────────────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Jakarta? Call get_weather.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"description\":\"Get weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\"}},\"required\":[\"location\"]}}}]}" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(d);
      const ch=j.choices?.[0];
      console.log('[finish_reason]', ch?.finish_reason);
      console.log('[has tool_calls]', !!(ch?.message?.tool_calls));
      console.log('[content is null]', ch?.message?.content===null);
    })"
# LULUS: finish_reason=tool_calls, has tool_calls=true, content is null=true

# ── 6. Tool calling — streaming ────────────────────────────────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Jakarta? Call get_weather.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"description\":\"Get weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\"}},\"required\":[\"location\"]}}}]}" \
  | grep -E "tool_calls|finish_reason" | head -5
# LULUS: ada baris dengan tool_calls (bukan text biasa), finish_reason: "tool_calls"

# ── 7. Vision — gambar publik ───────────────────────────────────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"What is in this image?\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"https://picsum.photos/seed/cat/200\"}}]}]}" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{console.log(JSON.parse(d).choices?.[0]?.message?.content?.slice(0,100));})"
# LULUS: ada deskripsi gambar (via flattenVisionMessages fallback kalau tidak native)

# ── 8. Vision — URL hotlink-protected (Wikipedia) ──────────────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"What animal is this?\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/481px-Cat03.jpg\"}}]}]}" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{console.log(JSON.parse(d).choices?.[0]?.message?.content?.slice(0,80));})"
# LULUS: menyebut "cat" atau "kucing"

# ── 9. Model muncul di /v1/models dengan capabilities ──────────────────────
curl -s $BASE/v1/models -H "Authorization: Bearer $APIKEY" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(d);
      const m=j.data.find(x=>x.id.includes('$MODEL'));
      console.log('[found]', !!m);
      console.log('[capabilities]', JSON.stringify(m?.capabilities));
    })"
# LULUS: found=true, capabilities punya vision/tools/json_mode/streaming

# ── 10. n > 1 — sudah di-handle global, verifikasi saja ───────────────────
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"n\":2,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{console.log(JSON.parse(d).error?.code);})"
# LULUS: "unsupported_value"
```

**Provider dianggap SELESAI jika semua 10 test di atas LULUS** DAN model sudah muncul di Playground UI. Kalau ada 1 test gagal atau model belum ada di Playground, provider belum boleh di-commit.

### ✅ Checklist Final — Semua wajib terpenuhi sebelum commit

| # | Item | Cara verifikasi |
|---|---|---|
| 1–10 | Semua test API lulus | Jalankan test bash di atas |
| 11 | Model ada di `WORKING_MODELS` playground | Cek `artifacts/gateway/src/pages/playground.tsx` |
| 12 | Model muncul di dropdown UI Playground | Buka `/playground` di browser, cek selector |
| 13 | Entry di SKILL.md provider list diupdate | Tambah di seksi "Provider yang Sudah Diimplementasikan" |

---

## Contoh Nyata — Recon & Status

### Perplexity AI (belum diimplementasi)
```bash
# Endpoint: POST https://www.perplexity.ai/rest/sse/perplexity_ask
# KRITIS: underscore (_), bukan hyphen (-)
curl -s -X POST "https://www.perplexity.ai/rest/sse/perplexity_ask" \
  --tlsv1.3 \
  -H "accept: text/event-stream" \
  -H "content-type: application/json" \
  -H "origin: https://www.perplexity.ai" \
  -H "referer: https://www.perplexity.ai/" \
  -H "user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36" \
  -H "x-perplexity-request-reason: perplexity-query-state-provider" \
  -H "x-request-id: $(cat /proc/sys/kernel/random/uuid)" \
  -d '{
    "params": {
      "attachments": [], "language": "en-US", "timezone": "America/Los_Angeles",
      "search_focus": "internet", "sources": ["web"],
      "frontend_uuid": "UUID-DISINI", "mode": "copilot",
      "model_preference": "turbo", "is_related_query": false,
      "frontend_context_uuid": "CTX-UUID-DISINI",
      "prompt_source": "user", "query_source": "home",
      "use_schematized_api": true, "send_back_text_in_streaming_api": false,
      "dsl_query": "PERTANYAAN_DISINI", "version": "2.18"
    },
    "query_str": "PERTANYAAN_DISINI"
  }' --max-time 30
```
**Parse response (Node.js):**
```javascript
// blocks[].diff_block.patches[].value.answer — atau streaming: patches[].value (string)
// "text_completed": true menandai akhir respons utama
```

### PollinationsAI (belum diimplementasi)
```bash
curl -s -X POST "https://text.pollinations.ai/openai" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai","messages":[{"role":"user","content":"say hi"}],"stream":false}'
# Atau: https://gen.pollinations.ai/v1/chat/completions (OpenAI-compatible langsung)
# Models: openai, openai-fast, deepseek, mistral-small, llamascout, dll
```

### Z.ai / chat.z.ai (GLM-5.1 — blocked, butuh X-Signature)
```bash
# Guest token gratis
curl -s "https://chat.z.ai/api/v1/auths/" \
  -H "User-Agent: Mozilla/5.0 Chrome/138.0.0.0" -H "Accept: application/json"
# Response: {"token":"eyJ...","role":"guest","email":"guest-{timestamp}@guest.com"}
# ⚠️ Chat DIBLOKIR untuk guest — /openai/v1/chat/completions butuh X-Signature (HMAC)
# Status: Perlu reverse-engineer signature algorithm dari JS bundle untuk bypass
```

---

## Tips Penting

1. **Selalu gunakan Node.js 20+ untuk `crypto.randomUUID()`** — dibutuhkan untuk generate UUID session
2. **Cache token dengan TTL** — jangan fetch ulang tiap request, gunakan TTL ~1 jam
3. **Gunakan `execSync` curl bukan `fetch`** — untuk provider yang memerlukan TLS fingerprint Chrome
4. **Parse SSE dengan hati-hati** — beberapa provider kirim format non-standar
5. **Test dulu dengan curl** sebelum implement di TypeScript — lebih cepat iterasi
6. **Perhatikan header `x-process-time: 0`** — berarti 404 dari CDN/nginx, bukan dari app backend
7. **Model ID bisa berbeda** dari nama yang ditampilkan di UI — selalu ambil dari `/api/models`
8. **Vision fallback via `flattenVisionMessages()`** sudah ada di `v1.ts` — tinggal panggil sebelum kirim ke provider yang tidak support native vision
9. **Tool calling via prompt injection** sudah ada di `injectToolPrompt()` dan `detectToolCalls()` di `v1.ts` — tidak perlu implement ulang

## Referensi

- gpt4free repo: https://github.com/xtekky/gpt4free
- Implementasi Perplexity: `g4f/Provider/Perplexity.py`
- Implementasi PollinationsAI: `g4f/Provider/PollinationsAI.py`
- Implementasi OperaAria: `g4f/Provider/OperaAria.py`
- Standard OpenAI API reference: https://platform.openai.com/docs/api-reference/chat
