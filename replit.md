# Dzeck API AI (Qwen API Gateway)

A gateway service that lets users access Qwen AI models via an OpenAI-compatible API, with API key management, request history, and a playground UI.

## Run & Operate

- **Frontend** (port 5000): `PORT=5000 API_PORT=8080 BASE_PATH=/ pnpm --filter @workspace/gateway run dev`
- **API Server** (port 8080): `PORT=8080 pnpm --filter @workspace/api-server run dev`
- `pnpm run build` — build all packages (frontend + backend)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Required Environment Variables

All set in Replit shared env vars:
- `MONGODB_URI` — MongoDB connection string
- `MONGODB_DATABASE` — MongoDB database name (e.g. `qwen_gateway`)
- `JWT_SECRET` — Secret for signing JWTs
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` — Redis connection (optional)
- `POSTGRES_URL` — PostgreSQL connection string (optional)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- **Frontend**: React 19, Vite, Tailwind CSS 4, Radix UI, Wouter, TanStack Query
- **Backend**: Express 5, MongoDB, JWT auth, bcryptjs
- **Build**: esbuild (ESM bundle for server), Vite (frontend)

## Where things live

- `artifacts/api-server/` — Express backend (auth, API keys, Qwen proxy)
- `artifacts/gateway/` — React frontend (dashboard, playground, API key management)
- `lib/api-spec/` — OpenAPI spec (source of truth for API contract)
- `lib/api-client-react/` — Generated React query hooks
- `lib/api-zod/` — Generated Zod schemas
- `artifacts/api-server/src/routes/v1.ts` — OpenAI-compatible `/v1/chat/completions` endpoint
- `artifacts/api-server/src/lib/auth-helpers.ts` — JWT + API key utilities

## Architecture decisions

- Backend proxies requests to `chat.qwen.ai` — no official Qwen SDK needed
- Frontend dev server proxies `/api` and `/v1` to the backend at port 8080
- Production: backend serves the Vite-built frontend as static files from `dist/public`
- Custom JWT auth (not Replit Auth) — users register/login with email+password stored in MongoDB

## User preferences

- Keep sensitive credentials in env vars (not secrets tab)
