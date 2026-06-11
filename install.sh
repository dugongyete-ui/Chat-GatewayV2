#!/usr/bin/env bash
set -e

# ─────────────────────────────────────────────
#  Dzeck API AI — One-shot installer
# ─────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()      { echo -e "${GREEN}✔${NC}  $1"; }
info()    { echo -e "${CYAN}→${NC}  $1"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $1"; }
fail()    { echo -e "${RED}✘  $1${NC}"; exit 1; }
section() { echo -e "\n${BOLD}$1${NC}"; echo "────────────────────────────────────────"; }

echo -e "\n${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║      Dzeck API AI  —  Installer      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}\n"

# ── 1. Check Node.js ─────────────────────────
section "1/6  Runtime check — Node.js"

if ! command -v node &>/dev/null; then
  fail "Node.js tidak ditemukan. Install Node.js 20+ dulu: https://nodejs.org"
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js $NODE_VERSION terlalu lama. Butuh Node.js 20+."
fi
ok "Node.js $NODE_VERSION"

# ── 2. Check Python 3 + install curl_cffi ────
section "2/6  Runtime check — Python 3 & curl_cffi"

if ! command -v python3 &>/dev/null; then
  fail "Python 3 tidak ditemukan. Install Python 3.10+ dulu: https://python.org"
fi

PY_VERSION=$(python3 --version 2>&1)
PY_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  fail "$PY_VERSION terlalu lama. Butuh Python 3.10+."
fi
ok "$PY_VERSION"

# Tentukan pip yang tersedia
if command -v pip3 &>/dev/null; then
  PIP="pip3"
elif command -v pip &>/dev/null; then
  PIP="pip"
else
  fail "pip tidak ditemukan. Install pip dulu."
fi
ok "pip: $($PIP --version | cut -d' ' -f1-2)"

# Install Python dependencies dari requirements.txt
REQS_FILE="artifacts/api-server/requirements.txt"
if [ -f "$REQS_FILE" ]; then
  info "Install Python packages dari $REQS_FILE..."
  $PIP install -r "$REQS_FILE" --quiet --disable-pip-version-check
  ok "Python packages terinstall (curl_cffi)"
else
  warn "$REQS_FILE tidak ditemukan, skip Python packages"
fi

# Verifikasi curl_cffi bisa di-import
if python3 -c "import curl_cffi" 2>/dev/null; then
  ok "curl_cffi import OK"
else
  warn "curl_cffi gagal di-import — coba install manual: pip3 install curl_cffi"
fi

# ── 3. Install / verify pnpm ─────────────────
section "3/6  Package manager (pnpm)"

if ! command -v pnpm &>/dev/null; then
  info "pnpm belum ada, install via corepack..."
  corepack enable 2>/dev/null || npm install -g pnpm@10.26.1 --silent
fi

PNPM_VERSION=$(pnpm --version)
ok "pnpm $PNPM_VERSION"

# ── 4. Install Node dependencies ──────────────
section "4/6  Install Node dependencies"

info "Menjalankan pnpm install..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Semua Node dependencies terinstall"

# ── 5. Codegen (OpenAPI → hooks & zod) ────────
section "5/6  Codegen"

info "Generate API hooks & Zod schemas dari OpenAPI spec..."
pnpm --filter @workspace/api-spec run codegen 2>/dev/null && ok "Codegen selesai" || warn "Codegen skip (tidak kritis)"

# ── 6. Build production ────────────────────────
section "6/6  Production build"

info "Build frontend + backend..."
pnpm run build
ok "Build selesai  →  artifacts/api-server/dist/"

# ── Env vars check ─────────────────────────
section "Cek environment variables"

MISSING=0
check_env() {
  if [ -z "${!1}" ]; then
    warn "$1 belum di-set"
    MISSING=$((MISSING + 1))
  else
    ok "$1 = ${!1:0:20}..."
  fi
}

check_env MONGODB_URI
check_env MONGODB_DATABASE
check_env JWT_SECRET

echo ""
info "Opsional (Redis / Postgres):"
[ -n "$REDIS_HOST" ]   && ok "REDIS_HOST = $REDIS_HOST"   || warn "REDIS_HOST  tidak di-set (opsional)"
[ -n "$POSTGRES_URL" ] && ok "POSTGRES_URL terset"         || warn "POSTGRES_URL tidak di-set (opsional)"

if [ "$MISSING" -gt 0 ]; then
  echo ""
  warn "$MISSING env var wajib belum di-set."
  echo -e "   Set di ${BOLD}.replit${NC} bagian ${BOLD}[userenv.shared]${NC}, contoh:"
  echo ""
  echo "     MONGODB_URI      = \"mongodb+srv://user:pass@cluster.mongodb.net/db\""
  echo "     MONGODB_DATABASE = \"qwen_gateway\""
  echo "     JWT_SECRET       = \"secret-minimal-32-karakter-acak\""
  echo ""
fi

# ── Done ──────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           Setup selesai! ✔           ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Jalankan server:"
echo -e "  ${CYAN}PORT=8080 node --enable-source-maps ./artifacts/api-server/dist/index.mjs${NC}"
echo ""
echo -e "  Atau dev mode (hot-reload):"
echo -e "  ${CYAN}PORT=8080 pnpm --filter @workspace/api-server run dev${NC}  (API)"
echo -e "  ${CYAN}PORT=5000 API_PORT=8080 pnpm --filter @workspace/gateway run dev${NC}  (Frontend)"
echo ""
