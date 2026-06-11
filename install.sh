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

ok()   { echo -e "${GREEN}✔${NC}  $1"; }
info() { echo -e "${CYAN}→${NC}  $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
fail() { echo -e "${RED}✘  $1${NC}"; exit 1; }
section() { echo -e "\n${BOLD}$1${NC}"; echo "────────────────────────────────────────"; }

echo -e "\n${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║      Dzeck API AI  —  Installer      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}\n"

# ── 1. Check Node.js ─────────────────────────
section "1/5  Runtime check"

if ! command -v node &>/dev/null; then
  fail "Node.js tidak ditemukan. Install Node.js 20+ dulu: https://nodejs.org"
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js $NODE_VERSION terlalu lama. Butuh Node.js 20+."
fi
ok "Node.js $NODE_VERSION"

# ── 2. Install / verify pnpm ─────────────────
section "2/5  Package manager (pnpm)"

if ! command -v pnpm &>/dev/null; then
  info "pnpm belum ada, install via corepack..."
  corepack enable 2>/dev/null || npm install -g pnpm@10.26.1 --silent
fi

PNPM_VERSION=$(pnpm --version)
ok "pnpm $PNPM_VERSION"

# ── 3. Install dependencies ───────────────────
section "3/5  Install dependencies"

info "Menjalankan pnpm install..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Semua dependencies terinstall"

# ── 4. Codegen (OpenAPI → hooks & zod) ────────
section "4/5  Codegen"

info "Generate API hooks & Zod schemas dari OpenAPI spec..."
pnpm --filter @workspace/api-spec run codegen 2>/dev/null && ok "Codegen selesai" || warn "Codegen skip (tidak kritis)"

# ── 5. Build production ────────────────────────
section "5/5  Production build"

info "Build frontend + backend..."
pnpm run build
ok "Build selesai  →  artifacts/api-server/dist/"

# ── 6. Env vars check ─────────────────────────
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
