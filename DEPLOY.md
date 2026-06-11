# Deploy Guide

Project ini bisa di-deploy ke berbagai platform menggunakan **Docker** (sudah ada `Dockerfile`).
Backend butuh `curl` binary dan environment variables berikut.

## Environment Variables yang Dibutuhkan

| Variable | Contoh | Keterangan |
|---|---|---|
| `MONGODB_URI` | `mongodb+srv://user:pass@cluster.mongodb.net/` | MongoDB Atlas connection string |
| `MONGODB_DATABASE` | `qwen_gateway` | Nama database |
| `JWT_SECRET` | `random-string-panjang` | Secret untuk sign JWT |
| `NODE_ENV` | `production` | Mode produksi |
| `PORT` | `8000` | Port (biasanya diset otomatis platform) |

> **MongoDB gratis:** Gunakan [MongoDB Atlas Free Tier (M0)](https://www.mongodb.com/cloud/atlas).
> Whitelist IP: `0.0.0.0/0` karena IP platform bisa berubah.

---

## Pilihan Platform

### 1. Railway ⭐ (Direkomendasikan)

Tidak ada artificial rate limit, persistent server, free tier $5/bulan kredit.

1. Push project ke GitHub
2. Buka [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Railway otomatis detect `Dockerfile`
4. Di tab **Variables**, tambahkan semua env vars di atas
5. Di tab **Settings → Networking**, klik **Generate Domain**
6. Selesai — app live di `https://<nama>.railway.app`

```
Health check: /api/healthz
```

---

### 2. Koyeb (Free tier tersedia)

Free tier: 1 service, 512MB RAM, shared CPU.

1. Push ke GitHub
2. Buka [koyeb.com](https://koyeb.com) → **Create Service** → **GitHub**
3. Pilih repo → Builder: **Dockerfile**
4. Tambahkan env vars di bagian **Environment Variables**
5. Health check path: `/api/healthz`
6. Deploy

```
URL: https://<nama>.koyeb.app
```

---

### 3. Render (Free tier, sleep setelah 15 menit idle)

1. Push ke GitHub
2. Buka [render.com](https://render.com) → **New Web Service** → **Connect GitHub**
3. Pilih **Docker** sebagai runtime
4. Tambahkan env vars di **Environment**
5. Free tier: service tidur setelah 15 menit tidak ada request (cold start ~30 detik)

---

### 4. Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login & deploy
fly auth login
fly launch        # baca Dockerfile otomatis
fly secrets set MONGODB_URI="..." MONGODB_DATABASE="qwen_gateway" JWT_SECRET="..."
fly deploy
```

---

### 5. VPS (DigitalOcean / Linode / Hetzner)

```bash
# Di server (Ubuntu/Debian)
apt install docker.io docker-compose -y

# Clone repo
git clone https://github.com/youruser/yourrepo.git
cd yourrepo

# Build & run
docker build -t dzeck-api .
docker run -d \
  -p 8000:8000 \
  -e MONGODB_URI="..." \
  -e MONGODB_DATABASE="qwen_gateway" \
  -e JWT_SECRET="..." \
  -e NODE_ENV=production \
  --name dzeck-api \
  --restart unless-stopped \
  dzeck-api
```

---

## Setelah Deploy

API endpoint akan tersedia di:

```
https://<domain-kamu>/v1/chat/completions   # Chat completions
https://<domain-kamu>/v1/models             # List models
https://<domain-kamu>/api/healthz           # Health check
https://<domain-kamu>/                      # Dashboard UI
```

### Contoh penggunaan dengan OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<domain-kamu>/v1",
    api_key="sk-..."  # API key dari dashboard
)

response = client.chat.completions.create(
    model="qwen3-235b-a22b",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://<domain-kamu>/v1",
  apiKey: "sk-...",
});

const res = await client.chat.completions.create({
  model: "qwen3-235b-a22b",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.choices[0].message.content);
```

---

## Catatan Penting

- **Replit tidak direkomendasikan** untuk production karena shared IP (kena rate limit upstream provider setelah ~5-20 request) dan artificial rate limit di reverse proxy-nya
- **Railway/Koyeb** memberikan IP dedicated atau pool IP yang lebih bersih
- Provider AI yang paling tahan load: **Qwen** (chat.qwen.ai) — tidak ada rate limit ketat per IP
- Provider dengan rate limit ketat: ChatAIBot (5 req/IP), AlgoChat, Perplexity — cocok hanya untuk demo/testing
