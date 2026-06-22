# Plutoploy — Deploy Agent Strategy & Plan

> Scope of THIS repo: the **server-side deploy agent**. Frontend, dashboard, and
> CI/build pipelines live in other org repos. This service's only job:
> receive a deploy request → get the image onto the host → run it as a Podman
> container → wire up Caddy routing (+ auto-HTTPS). "Just the pulling logic."

Last updated: 2026-06-21

---

## Current deploy flow

```
POST /api/deploy { image, subdomain, repo }
  → findAvailablePort()                 # sequential scan + lsof
  → podman pull <image>                 # child_process.exec (CLI)
  → podman run -d -p <port>:80 ...       # child_process.exec (CLI)
  → routesDb.upsert(domain, 127.0.0.1, port)   # SQLite
  → Caddy sqlite_router reads routes table live → reverse_proxy + ACME HTTPS
```

Files:

- `backend/src/routes/deploy.routes.ts` — HTTP API + port allocation
- `backend/src/services/deployment.service.ts` — orchestration (pull→run→route)
- `backend/src/handlers/podman-cli.handler.ts` — Podman via CLI exec
- `backend/src/handlers/caddy.handler.ts` — routes table writes
- `backend/src/db/database.ts` + `schema.sql` — better-sqlite3, `deployments` + `routes`
- `backend/src/workers/build-worker.ts` — **STUB**: git repo → build → run (future)

---

## The "pull" question — two separate decisions

### Decision A: How the backend talks to Podman


| Approach                                                                                                                           | Pros                                                                                                                 | Cons                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **CLI exec (current)**                                                                                                             | simplest, works                                                                                                      | shell-string interpolation = **injection risk**; no structured output; no streaming progress; brittle stderr parsing |
| `**execFile` + arg array**                                                                                                         | no shell → kills injection; minimal change                                                                           | still no streaming; still parse text                                                                                 |
| **Podman REST socket** (`podman system service` → unix socket, Docker-compatible API), called via **raw HTTP over `undici`/fetch** | structured JSON; **streaming pull/build/log progress** (pipe live to frontend); real error codes; no shell injection | must enable the socket unit; need to handle streaming format                                                         |
| Native bindings (dockerode / podman-node)                                                                                          | typed                                                                                                                | **segfault under tsx** — see PROGRESS.md. AVOID.                                                                     |


**Recommendation:**

- **Target:** Podman REST socket via `undici` for pull / build / logs. Streaming
progress is the real win for a deploy platform (live build logs to the dashboard).
Use raw HTTP-over-socket, NOT native bindings.
- **Ship today (interim hardening):** switch CLI handler from `exec` to `execFile`
with arg arrays + validate the image reference. Removes injection immediately.

### Decision B: How a deploy is triggered / where the image comes from


| Mode                                        | Notes                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Webhook + registry (RECOMMENDED)**        | org CI builds image → pushes to GHCR → fires webhook to this backend → backend pulls & deploys. Clean separation; no building on prod box. Matches "just pulling logic." |
| **Build-from-source here** (`build-worker`) | clone repo → build in throwaway container → run. More power, more host attack surface + resource cost. Keep as secondary mode.                                           |
| Registry polling                            | AVOID — wasteful + laggy vs webhooks.                                                                                                                                    |


---

## Issues to fix (independent of the socket decision)

1. **[SECURITY] Command injection** — `image` flows unsanitized into `exec`
  (`podman pull ${imageName}`). Validate image ref + use `execFile`/socket.
2. **Port allocation race** — port chosen but not reserved until after deploy;
  concurrent deploys collide. Fix with a queue (concurrency 1, per design doc)
   or atomic DB reservation.
3. **No rollback** — container created but route insert fails → orphaned container.
  `deployApp` needs a cleanup/rollback path (design doc §Rollback Strategy).
4. `**-p <port>:80` assumption** — hardcodes every app listening on 80. Make the
  container port configurable per deploy.
5. **Caddy `127.0.0.1` upstream** — if Caddy runs in its own netns, `127.0.0.1`
  is Caddy's loopback, not the host. Needs `host.containers.internal` or host
   networking. VERIFY on the actual box.
6. `**server.ts` hand-rolls http server** though `@hono/node-server` is already a
  dependency — switch to it for stability.

---

## Suggested roadmap

**Phase 1 — Harden current path (small, ship now)**

- `exec` → `execFile` + arg arrays in `podman-cli.handler.ts`
- Validate image reference (registry/name:tag regex) before any podman call
- Add rollback to `deployApp` (remove container if route/db step fails)
- Make container port configurable (don't assume :80)
- Verify Caddy → host upstream addressing on the server

**Phase 2 — Socket migration**

- Enable `podman system service` (rootless user socket)
- New `podman-socket.handler.ts` using `undici` over the unix socket
- Stream pull/build/log progress out of the API (SSE/WebSocket to frontend)

**Phase 3 — Trigger model + concurrency**

- Webhook endpoint for org CI (verify signature)
- Deployment queue (concurrency 1) → fixes port race + serializes Podman ops
- Job status tracking (pending→processing→completed/failed)

**Phase 4 — Build-from-source**

- Flesh out `build-worker.ts`: clone → build in isolated container → push/run

**Phase 5 — Ops**

- Health monitor (reconcile DB status vs actual container state)
- Auth on the API, rate limiting
- Switch `server.ts` to `@hono/node-server`

---

## Open questions to confirm with the team

- Does Caddy run in a container or on the host? (decides the upstream address)
- Is the registry GHCR private? (need pull auth on the host)
- Build-from-source needed soon, or is pre-built-image-via-CI enough for v1?
- Multi-tenant? (changes auth + resource-isolation requirements)

