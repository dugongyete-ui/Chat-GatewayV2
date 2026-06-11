---
name: Qwen WAF bypass
description: How to bypass Aliyun WAF on chat.qwen.ai from Replit datacenter IPs — current solution + fallback ladder if blocked.
---

# Qwen WAF Bypass

## The Rule
Use `curl_cffi` **without** any `impersonate=` parameter, combined with either:
- `Authorization: Bearer <QWEN_SESSION_TOKEN>` (session mode), or
- `bx-umidtoken: <MIDTOKEN>` (guest mode, no login)

This TLS fingerprint is NOT in Aliyun's datacenter blocklist (tested June 2026).

**Why:** Aliyun WAF blocks datacenter IPs based on TLS JA3/JA4 fingerprint. Node.js fetch (undici/OpenSSL) and system curl both match blocked fingerprints. `curl_cffi`'s default libcurl-impersonate TLS stack does not.

**How to apply:** Route ALL Qwen HTTP requests through `qwen_cffi.py` Python subprocess. Never use Node.js `fetch()` for Qwen API calls when running from Replit datacenter.

---

## Fallback Ladder — Jika curl_cffi Diblokir Aliyun

Urutan eskalasi dari yang paling ringan ke paling berat:

### Level 1 — Aktifkan impersonasi Chrome (1 baris, ~5 menit)
```python
# Sebelum (saat ini):
r = req.post(url, json=payload, headers=headers, timeout=90)

# Jika kena block → aktifkan impersonasi:
r = req.post(url, json=payload, headers=headers, timeout=90, impersonate="chrome124")
# Atau versi lebih baru:
r = req.post(url, json=payload, headers=headers, timeout=90, impersonate="chrome136")
```
TLS fingerprint menjadi identik dengan Chrome nyata — sangat sulit diblokir tanpa false positive masif.
File yang perlu diubah: `artifacts/api-server/src/lib/qwen_cffi.py` (semua `req.post` dan `req.get`).

### Level 2 — Ganti library ke `tls-client` (Python Go-based)
```python
import tlsclient.requests as tls
session = tls.Session(client_identifier="chrome_124")
r = session.post(url, json=payload, headers=headers)
```
Install: `pip install tls-client`
Fingerprint berbeda dari curl_cffi — rotasi library kalau satu diblokir.

### Level 3 — Playwright headless Chrome (paling kuat, lebih berat)
- Jalankan Chrome sungguhan via `playwright` Python
- Fingerprint 100% identik browser, tidak bisa dibedakan secara TLS
- Contoh sudah ada di proyek: `deepseek_pow.py` menggunakan pola subprocess Python
- Install: `pip install playwright && playwright install chromium`
- Cocok jika WAF eskalasi ke behavior analysis (bukan hanya TLS)

### Level 4 — Residential proxy (jika Replit IP diblokir total)
- Aliyun bisa blacklist seluruh range IP Replit (datacenter ASN)
- Solusi: routing melalui residential proxy (berbayar, contoh: BrightData, Oxylabs)
- Set via `proxies={"https": "http://user:pass@proxy:port"}` di curl_cffi/requests
- Ini bukan masalah TLS lagi, tapi masalah IP reputation

---

## Cara Mendeteksi Jenis Block

| Gejala | Penyebab | Solusi |
|--------|----------|--------|
| Response HTML `_____tmd_____` atau `FAIL_SYS_USER_VALIDATE` | Risk control / fingerprint JA3 | Level 1 atau 2 |
| HTTP 403 langsung dari load balancer | IP datacenter diblokir | Level 4 (proxy) |
| HTTP 200 tapi body kosong / timeout | Rate limit atau behavior block | Rotasi midtoken + retry |
| `createChat` sukses tapi `completions` 403 | Endpoint spesifik diblokir | Coba model/endpoint lain |

---

## Implementation (Current State, June 2026)

- Python script: `artifacts/api-server/src/lib/qwen_cffi.py` → copied to `dist/qwen_cffi.py` by build
- Node.js helpers: `qwenPyCreate(token, model, midtoken?)` dan `qwenPyBody(token, chatId, payload, midtoken?)` di `v1.ts` dan `gateway.ts`
- Two auth modes:
  - **Session mode**: `QWEN_SESSION_TOKEN` env var set → `Authorization: Bearer TOKEN`
  - **Guest mode**: tidak perlu env var → `bx-umidtoken` dari `umid-pool.ts` (pool 8 token, round-robin)
- Midtoken source: `sg-wum.alibaba.com/w/wu.json` → parse `umx.wu('TOKEN')` dengan regex
- Streaming: `spawn("python3", [...])` — baca `py.stdout` real-time
- Build: `requirements.txt` (`curl_cffi>=0.7.0`) diinstall otomatis via `ensurePythonDeps()` di `build.mjs`

## Model IDs (as of June 2026)
Old internal IDs no longer work — mapped via `QWEN_API_MODEL_MAP` in v1.ts:
- `qwen3-235b-a22b` → `qwen-plus-2025-07-28` (Qwen3-235B-A22B-2507)
- `qwen3-30b-a3b` → `qwen3.5-35b-a3b`
- `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` → unchanged
- Fast/cheap: `qwen3.5-flash`

## Key Endpoints
- Create chat: `POST /api/v2/chats/new` (NOT `/chats/create`)
- Completions: `POST /api/v2/chat/completions?chat_id=<id>`
- Models list: `GET /api/v2/models` (returns new IDs)
