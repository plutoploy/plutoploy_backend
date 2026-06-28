# CLAUDE.md — Plutoploy

Context for any AI agent working in this repo. Read this first every session.

## What this is

Plutoploy is a self-hosted **deployment platform** — think a minimal Vercel/Railway
for containers. THIS repo is **only the server-side deploy agent**. The frontend,
dashboard, and CI/build pipelines live in **other repos in the org**.

This service's single job:
> receive a deploy request → get a container image onto the host → run it with
> Podman → wire up Caddy routing with automatic HTTPS.

"Just the pulling logic" — keep that scope in mind; don't build frontend here.

## Architecture / request flow

There are **three flows** in this repo (only A was in the original docs):

**A — Manual deploy**
```
POST /api/deploy { image, subdomain, repo?, containerPort? }
  → allocate a port (findAvailablePort, 3001+)
  → podman pull <image>                       (execFile, no shell)
  → podman run -d -p <port>:<containerPort> ... (container named deploy-<uuid>)
  → routesDb.upsert(domain, 127.0.0.1, port)   → Postgres `routes` table (Prisma)
  → on failure: rollback (remove route + container)
```

**B — GitHub OAuth login** — `/api/auth/github` → callback → upsert user + session
cookie (sessions table, 30-day TTL). Protected routes use `requireAuth`.

**C — CI "bot" auto-deploy** — `POST /api/inject-workflow` commits a build
workflow + Dockerfile into the user's repo → GitHub Actions builds → pushes to
GHCR → `POST /api/webhooks/github` (HMAC-verified) → `deployApp(...)`. Live build
status streams via `GET /api/builds/:id/logs` (SSE fed from a PartyKit WS).

Incoming traffic: `user → https://<sub>.<DOMAIN> → Caddy :443 → proxy to container`.
HTTPS via Cloudflare DNS-01 ACME (wildcard `*.<DOMAIN>`).

> **Routing/Caddy note:** routes now live in **Postgres** (was SQLite). How Caddy
> reads them is owned by a **separate repo** (the caddy-sqlite image) — out of scope
> here. This app just writes the `routes` table.

## Key files

| File | Role |
|---|---|
| `index.ts` | entrypoint — starts server + initializes DB |
| `backend/server.ts` | Hono app served via `@hono/node-server` (`serve()`); mounts auth/github/webhook/deploy routes |
| `backend/src/routes/deploy.routes.ts` | manual deploy API + `findAvailablePort()` |
| `backend/src/routes/auth.routes.ts` | GitHub OAuth login (flow B) |
| `backend/src/routes/github.routes.ts` | repo listing, `/inject-workflow`, `/builds/:id/logs` SSE (flow C) |
| `backend/src/routes/webhook.routes.ts` | `/webhooks/github` — HMAC-verified, triggers auto-deploy |
| `backend/src/services/deployment.service.ts` | orchestration: pull → run → route + rollback |
| `backend/src/services/github.service.ts` | GitHub App tokens (JWT signed with `.pem`), repo/token APIs |
| `backend/src/handlers/podman-cli.handler.ts` | Podman via `child_process.execFile` (no shell) |
| `backend/src/handlers/caddy.handler.ts` | writes/deletes `routes` rows; `removeDeployment` |
| `backend/src/db/database.ts` | **Prisma client (PostgreSQL)**; `*Db` helpers for each model |
| `prisma/schema.prisma` | DB schema — `deployments`, `routes`, `builds`, `users`, `sessions` |
| `backend/src/workers/build-worker.ts` | **STUB** — future git-repo → build → run path |
| `DEPLOY-STRATEGY.md` / `ARCHITECTURE.md` | roadmap + current master architecture doc |

## API

- `POST   /api/deploy` — `{ image, subdomain, repo?, containerPort? }`
- `GET    /api/deployments` / `GET /api/deployments/:id`
- `DELETE /api/deployments/:id`
- `GET    /api/routes` (debug)
- `GET    /health`
- `GET    /api/auth/github` + `/api/auth/github/callback` — OAuth (flow B)
- `GET    /api/repos`, `POST /api/inject-workflow`, `GET /api/builds/:id/logs` (flow C, requireAuth)
- `POST   /api/webhooks/github` — CI webhook receiver (flow C)

## Commands

```bash
npm run dev          # tsx index.ts (local)
npm run pm2:start    # production via PM2 (ecosystem.config.cjs, interpreter=tsx)
npm run pm2:logs
npm run pm2:reload
```

Default API port **3000**. Deployed containers get ports from **3001+**.

## Env vars (.env)

- `DOMAIN` — base domain; full host = `<subdomain>.<DOMAIN>`
- `PORT` — API port (default 3000)
- `DATABASE_URL` — Postgres connection string (Prisma)
- `FRONTEND_URL` — where OAuth redirects back to after login
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — OAuth app creds (flow B)
- `GITHUB_APP_ID` / `GITHUB_CALLBACK_URL` + a `.pem` private key — GitHub App (flow C)
- `GITHUB_WEBHOOK_SECRET` — HMAC verification for `/webhooks/github`
- `PARTYKIT_WS_URL` — build-log WS source (default `wss://plutoploy-gh-bot.pratyay360.partykit.dev`)
- `CLOUDFLARE_TOKEN` — for Caddy DNS-01 ACME (Caddy lives in a separate repo)

## Stack decisions (don't relitigate without reason — see PROGRESS.md)

- **Node + tsx**, NOT Bun (ssh2 native module issues under Bun).
- **Podman CLI execFile** (no shell), NOT dockerode/native bindings (**segfault under tsx**).
- **`@hono/node-server`** (`serve()`) — replaced the hand-rolled `http.createServer`
  bridge (fixed SSE flushing + webhook HMAC byte-desync).
- **PostgreSQL via Prisma** — migrated off SQLite/better-sqlite3. Caddy's route
  reader lives in a separate repo.

## Known issues / gotchas (fix-worthy)

Fixed (kept for history): command injection (now `execFile` + image validation),
no-rollback (now rolls back on partial failure), hardcoded `:80` (now
`containerPort` config), boot-blocking missing route imports.

Still open:
1. **Port-allocation race** — port picked but not reserved until after deploy;
   concurrent deploys can collide. Needs a queue (concurrency 1) or atomic reserve.
2. **Caddy upstream `127.0.0.1`** — if Caddy is containerized, that's Caddy's
   loopback, not the host. May need `host.containers.internal` / host networking.
   VERIFY on the actual server.
3. **`getInstallationRepos` logs the live installation token** (`github.service.ts`).

## How to work here

- Before touching pull/deploy logic, read `DEPLOY-STRATEGY.md` (roadmap + the
  Podman-socket vs CLI decision).
- Keep scope to the deploy agent; frontend/CI belong in other org repos.
- Match the existing style (functional handlers, named exports, no classes yet).
- Update `DEPLOY-STRATEGY.md` / `PROGRESS.md` when plans or status change.

## Agent notes (append-only log)

When you (an AI agent) make a non-trivial change or decision, append a dated
bullet here so the next session inherits the reasoning. Newest at the bottom.
Keep each entry to 1-3 lines: what changed + why. Link files as `path:line`.

- 2026-06-21 — Created `CLAUDE.md` + `DEPLOY-STRATEGY.md`; decided "pull" target =
  Podman REST socket via undici (interim: execFile + image validation). See strategy doc.
- 2026-06-21 — Phase 1 hardening: `podman-cli.handler.ts` moved `exec`→`execFile`
  (no shell), added image-ref validation; `deployment.service.ts` got rollback on
  partial failure; container internal port now configurable (default 80).
- 2026-06-26 — Docs synced to reality: migrated SQLite→**Postgres/Prisma**
  (`prisma/schema.prisma`, `database.ts`); `server.ts` now uses `@hono/node-server`;
  documented flows B (OAuth) + C (CI bot/webhook + SSE build logs). Caddy route
  reader split to a separate repo. See `ARCHITECTURE.md` for the master doc.

## Pointers

- `DEPLOY-STRATEGY.md` — pull mechanism analysis + 5-phase roadmap
- `PROGRESS.md` — what works / TODO / architecture decisions
- `.kiro/specs/complete-deployment-platform/` — design.md + requirements.md (the spec)
- `caddy-setup-guide.md` — Caddy container setup + caddy.json template
