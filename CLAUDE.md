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

```
POST /api/deploy { image, subdomain, repo }
  → allocate a port
  → podman pull <image>
  → podman run -d -p <port>:80 ...        (container named deploy-<uuid>)
  → routesDb.upsert(domain, 127.0.0.1, port)   → SQLite `routes` table
  → Caddy (sqlite_router plugin) reads `routes` live → reverse_proxy + ACME HTTPS

Incoming traffic:
  user → https://<subdomain>.<DOMAIN>
       → Caddy :443  → SELECT host,port FROM routes WHERE domain=?  → proxy to container
```

Caddy runs as a **separate container** (`ghcr.io/pratyay360/caddy-cloudflare-sqlite`)
and reads the SAME SQLite DB as this app — no Caddy reloads needed, routes are live.
HTTPS via Cloudflare DNS-01 ACME (wildcard `*.<DOMAIN>`).

## Key files

| File | Role |
|---|---|
| `index.ts` | entrypoint — starts server + initializes DB |
| `backend/server.ts` | Hono app on a hand-rolled `http.createServer` (note: `@hono/node-server` is a dep but unused) |
| `backend/src/routes/deploy.routes.ts` | HTTP API + `findAvailablePort()` |
| `backend/src/services/deployment.service.ts` | orchestration: pull → run → route |
| `backend/src/handlers/podman-cli.handler.ts` | Podman via `child_process.exec` (CLI) |
| `backend/src/handlers/caddy.handler.ts` | writes/deletes `routes` rows; `removeDeployment` |
| `backend/src/db/database.ts` + `schema.sql` | better-sqlite3; `deployments` + `routes` tables (WAL) |
| `backend/src/workers/build-worker.ts` | **STUB** — future git-repo → build → run path |
| `DEPLOY-STRATEGY.md` | the plan: "pull via socket" decision + phased roadmap |

## API

- `POST   /api/deploy` — `{ image, subdomain, repo? }`
- `GET    /api/deployments` / `GET /api/deployments/:id`
- `DELETE /api/deployments/:id`
- `GET    /api/routes` (debug)
- `GET    /health`

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
- `HOST_PORT` — host isn’t working, y port mapping
- `CLOUDFLARE_TOKEN` — for Caddy DNS-01 ACME

## Stack decisions (don't relitigate without reason — see PROGRESS.md)

- **Node + tsx**, NOT Bun (ssh2 native module issues under Bun).
- **Podman CLI exec**, NOT dockerode/native bindings (**segfault under tsx**).
- **Native `http.createServer`**, not `@hono/node-server` (stability — though
  switching back is on the roadmap).
- **SQLite (better-sqlite3)** shared between app and Caddy.
 isn’t working, y
## Known issues / gotchas (fix-worthy)

1. **[SECURITY] Command injection** — `image` is interpolated unsanitized into
   `exec` (`podman pull ${imageName}`). `subdomain` IS validated; `image` is NOT.
2. **Port-allocation race** — port picked but not reserved until after deploy;
   concurrent deploys can collide. Needs a queue (concurrency 1) or atomic reserve.
3. **No rollback** — if route/DB step fails after `podman run`, the container is
   orphaned. `deployApp` has no cleanup path.
4. **`-p <port>:80` is hardcoded** — assumes every app listens on port 80.
5. **Caddy upstream `127.0.0.1`** — if Caddy is containerized, that's Caddy's
   loopback, not the host. May need `host.containers.internal` / host networking.
   VERIFY on the actual server.

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

## Pointers

- `DEPLOY-STRATEGY.md` — pull mechanism analysis + 5-phase roadmap
- `PROGRESS.md` — what works / TODO / architecture decisions
- `.kiro/specs/complete-deployment-platform/` — design.md + requirements.md (the spec)
- `caddy-setup-guide.md` — Caddy container setup + caddy.json template
