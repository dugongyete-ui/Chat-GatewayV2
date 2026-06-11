FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

# ── Install dependencies ─────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

COPY lib/db/package.json              ./lib/db/
COPY lib/api-spec/package.json        ./lib/api-spec/
COPY lib/api-zod/package.json         ./lib/api-zod/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/gateway/package.json   ./artifacts/gateway/

RUN pnpm install --frozen-lockfile

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY lib/db/              ./lib/db/
COPY lib/api-spec/        ./lib/api-spec/
COPY lib/api-zod/         ./lib/api-zod/
COPY lib/api-client-react/ ./lib/api-client-react/
COPY artifacts/api-server/ ./artifacts/api-server/
COPY artifacts/gateway/    ./artifacts/gateway/

# Build frontend (PORT is required by vite.config validation but unused at build time)
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/gateway build

# Build backend
RUN pnpm --filter @workspace/api-server run build

# Copy frontend into backend's dist so Express can serve it
RUN cp -r ./artifacts/gateway/dist/public ./artifacts/api-server/dist/public

# ── Production image ─────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

# curl is required by AI provider helpers (execSync curl)
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8000

COPY --from=builder /app/artifacts/api-server/dist ./dist

EXPOSE 8000

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
