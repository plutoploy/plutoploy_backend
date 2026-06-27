# Plutoploy — Architecture, Errors & Roadmap

> Master doc. Read this first. It explains **what the system actually does today**,
> **what's broken right now**, **how to fix it cleanly**, and **how this repo plugs
> into the frontend and the other org repos** (DNS handler, Caddy-SQLite image).
>
> Scope reminder: this repo is **only the server-side deploy agent**. Frontend,
> CI dashboards, DNS automation, and the Caddy image live in other repos.

---

## 0. TL;DR — current state (2026-06-22)

| Area | State |
|---|---|
| Manual image deploy (`POST /api/deploy`) | ✅ Works (pull → run → route → HTTPS) |
| Podman handler (execFile, image validation) | ✅ Hardened in `6c294c7` |
| Rollback on partial deploy | ⚠️ Written, but file is **broken by a bad merge** |
| GitHub OAuth login | ❌ **Dead** — routes not imported in `server.ts` |
| GitHub App repo listing / workflow injection | ❌ Dead (same reason) |
| Webhook → auto-deploy ("bot logic") | ❌ Dead (same reason) |
| Build log streaming (SSE) | ⚠️ Depends on the fragile Hono↔Node bridge |
| `tsc` build (`npm run build`) | ❌ Broken (`.ts` import specifiers + `noEmit`) |

**Two bugs block the entire server from booting.** Fix those first (§3 P0), then
the auth/bot layer comes alive. Everything else is hardening and structure.

---

## 1. What the system does (the three flows)

There are **three distinct request flows** living in this repo. The CLAUDE.md only
documents the first one — the other two were added later and are undocumented.

### Flow A — Manual deploy (the original path)

```
POST /api/deploy { image, subdomain, repo?, containerPort? }
  → validate image ref + subdomain + containerPort
  → findAvailablePort()                       (3001+, checked via lsof)
  → podman pull <image>                        (execFile, no shell)
  → podman run -d -p <port>:<containerPort>     name: deploy-<uuid>
  → routesDb.upsert(<sub>.<DOMAIN>, 127.0.0.1, port)   → SQLite routes
  → Caddy (sqlite_router plugin) reads routes live → reverse_proxy + ACME HTTPS
  → on any failure: rollback (remove route, remove container)
```

### Flow B — GitHub login (OAuth via the GitHub App)

```
Browser → GET /api/auth/github            → redirect to GitHub authorize (CSRF state)
GitHub  → GET /api/auth/github/callback   → exchange code → access_token
        → fetch user + email + app installation_id
        → authDb.upsertUser(...)          → users table
        → create session token            → sessions table (30-day TTL)
        → Set-Cookie session_token (HttpOnly) + redirect to FRONTEND_URL
Protected routes use requireAuth → reads Bearer / cookie / ?token= → sessions JOIN users
```

### Flow C — The "bot": CI-driven auto-deploy

This is the Vercel/Railway-style path. The "bot" is the **GitHub App** acting on
the user's repos.

```
1. User clicks "deploy repo X" in frontend
2. POST /api/inject-workflow { repoFullName, runtime, branch }   (requireAuth)
   → generate installation token (JWT signed with the App private .pem)
   → commit .github/workflows/build.yml + Dockerfile + .dockerignore into the repo
   → buildsDb.create({ id, repo, branch })
3. GitHub Actions runs → builds image → pushes to ghcr.io/<repo>:latest
4. GitHub → POST /api/webhooks/github  (workflow_run events, HMAC-signed)
   → verify x-hub-signature-256 against GITHUB_WEBHOOK_SECRET
   → on "completed/success": deployApp({ image: ghcr.io/<repo>:latest, ... })
   → auto-generate subdomain  (repo name + random suffix)
5. Frontend streams progress: GET /api/builds/:id/logs   (SSE)
```

So **"the bot"** = GitHub App installation token + workflow injection + webhook
receiver. It is the automation that turns a `git push` into a running container.

---

## 2. The "Hono problem" and why we move fully to Node

### What's there now

`backend/server.ts` does **not** use a real server adapter. It hand-rolls one:

```ts
const server = createServer(async (req, res) => {
  // 1. manually read the entire request body into a Buffer
  // 2. build a Web `Request` from it
  // 3. call app.fetch(request)            ← Hono's fetch handler
  // 4. manually pipe response.body back through res.write()
});
```

`@hono/node-server` **is already a dependency** (`package.json`) but is unused.
CLAUDE.md notes the original switch to the manual bridge was "for stability" — but
that stability cost us correctness in three places:

1. **SSE (build log streaming, Flow C).** `streamSSE` returns a long-lived
   streaming `Response`. The manual `res.write()` loop has no header flushing and
   no keep-alive handling, so `GET /api/builds/:id/logs` is unreliable — the client
   may see nothing until the stream closes.
2. **Webhook HMAC (Flow C).** The signature is computed over the **raw** body.
   Reading the body into a Buffer, re-wrapping it in a `Request`, then calling
   `c.req.text()` again is a round-trip that can desync the bytes the HMAC was
   computed over. Result: valid webhooks rejected as "Invalid signature."
3. **Cookies / streaming responses** generally go through a bridge Hono didn't
   write and doesn't test.

### The fix (lazy + correct)

Delete the hand-rolled `createServer` block. Use the adapter that's already
installed:

```ts
import { serve } from '@hono/node-server';
// ...build app...
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🚀 API on :${info.port}`);
});
```

That's the whole "shift to node." It's **fewer lines**, fixes SSE + webhook HMAC
for free, and is the path Hono officially supports on Node. No new dependency.

> Why Node and not Bun at all: native modules (`ssh2`, `better-sqlite3`) and
> `dockerode` segfaulted under Bun/tsx earlier — see CLAUDE.md stack decisions.
> Staying on Node + tsx is correct; we're just using the *proper* Node adapter.

---

## 3. Errors to fix (prioritized)

### P0 — boot-blockers (server does not start until these are fixed)

| # | File | Problem | Fix |
|---|---|---|---|
| P0-1 | `backend/server.ts` | `authRoutes`, `githubRoutes`, `webhookRoutes` are mounted (lines 31/34/37) but **never imported**. `ReferenceError` on load → nothing serves. | Add the three imports. This alone revives auth + bot. |
| P0-2 | `backend/src/services/deployment.service.ts` | Botched merge: **two `try` blocks / two deploy sequences** in one function; the first `try` (line 18) has no `catch`. Won't parse; `containerId` logic duplicated. | Keep the new block (lines 12–35 + rollback catch). Delete the duplicated old block (lines 38–62). |

### P1 — security / secret leakage

| # | File | Problem | Fix |
|---|---|---|---|
| P1-1 | `db/database.ts` `getSessionUser` | Dumps **every session token and user** to stdout on *every* authenticated request. Token leakage + log noise. | Delete the debug block. |
| P1-2 | `services/github.service.ts` `getInstallationRepos` | `console.log("Installation Token: " + installationToken)` — logs a live GitHub token. | Remove. |
| P1-3 | `db/database.ts` `users.access_token` | GitHub access tokens stored **plaintext**. | Encrypt at rest (libsodium/`crypto`), or don't persist it if only used transiently. |
| P1-4 | `services/github.service.ts` | Private key path hardcoded (`plutoply.2026-04-02.private-key.pem`). | Move to `GITHUB_APP_PRIVATE_KEY_PATH` env (or inline PEM env for containers). |
| P1-5 | `routes/auth.routes.ts` | `oauthStates` (CSRF) is in-memory; PM2 fork / multi-process loses it → spurious "invalid state". | Single process is fine for now (`// ponytail: in-mem, move to DB if we scale workers`). Move to `sessions`/Redis only when multi-worker. |

### P2 — correctness / robustness

| # | File | Problem | Fix |
|---|---|---|---|
| P2-1 | `routes/deploy.routes.ts` `findAvailablePort` + concurrency | Port picked but not reserved → concurrent deploys collide (known gotcha #2). Webhook auto-deploy makes this likely. | Serialize deploys (in-process queue, concurrency 1) **or** atomic reserve row. Lazy: a single `p-limit(1)` / promise chain. |
| P2-2 | `routes/webhook.routes.ts` | Build→deploy linkage is `getLatestByRepo` — two pushes to the same repo race; wrong build can win. | Link by `workflow_run.id` / head SHA, set when build is created or on `requested`. |
| P2-3 | `routes/webhook.routes.ts` deploy | Doesn't pass `containerPort`; assumes app listens on 80. Also reuses subdomain randomly each deploy (no stable URL per repo). | Persist chosen subdomain on the build; pass containerPort from repo config. |
| P2-4 | `caddy.handler.ts` upstream `127.0.0.1` | If Caddy is containerized, loopback is *Caddy's*, not the host (known gotcha #5). | Verify on server; likely `host.containers.internal` or host networking. |
| P2-5 | `package.json` `build` (`tsc`) | `.ts` import specifiers + `noEmit` → `tsc` can't emit. Build script is a no-op/broken. | We run via `tsx`; either drop the `build` script or add a real bundler (esbuild) if a build artifact is ever needed. **YAGNI for now.** |

### P3 — cleanup / dead code

| # | File | Problem | Fix |
|---|---|---|---|
| P3-1 | `workers/build-worker.ts` | Empty stub that **executes on import** with a hardcoded repo URL. Not imported anywhere → dead. | Delete it. The build now happens in GitHub Actions (Flow C), not here. |
| P3-2 | `backend/test_*.cjs` | Ad-hoc scratch scripts. | Move to a `scratch/` dir or delete. |
| P3-3 | Import style | Mixed `'../db/database'` vs `'../db/database.ts'`. Works under tsx, not under `tsc`. | Pick one (no extension, matches bundler resolution) and apply repo-wide. |
| P3-4 | Doc sprawl | `README`, `API.md`, `DEPLOYMENT.md`, `PROGRESS.md`, `DEPLOY-STRATEGY.md`, `COMPLETE-TEST-GUIDE.md`, `PODMAN-SETUP.md`, `caddy-setup-guide.md` + this. | Make **this** the index; demote the rest to references or fold them in. |

---

## 4. File structure

### Current (it's actually mostly fine — resist the urge to rewrite)

```
index.ts                         entrypoint
backend/
  server.ts                      Hono app + (hand-rolled, to be replaced) Node server
  src/
    routes/      auth | github | webhook | deploy        ← HTTP layer
    services/    deployment | github                     ← orchestration / external APIs
    handlers/    podman-cli | caddy                      ← side-effect adapters
    middleware/  auth.middleware                          ← requireAuth / optionalAuth
    db/          database (better-sqlite3) + schema.sql   ← persistence
    types/       config                                   ← shared types
    templates/   workflows/*.yml + docker/*               ← injected into user repos
    workers/     build-worker.ts (DEAD — delete)
```

The `routes → services → handlers → db` layering is conventional and correct.
**Do not** introduce a DI container, repository interfaces, or a class hierarchy
for this size of app.

### Recommended minimal moves (not a rewrite)

1. **`server.ts` → adapter only.** App construction can stay; just swap the
   bottom for `@hono/node-server`'s `serve`. (§2)
2. **Split `github.service.ts`** (currently ~460 lines doing 4 jobs):
   - `services/github-auth.ts` — JWT, installation token, OAuth exchange, user fetch
   - `services/github-repos.ts` — list repos, workflow/file injection
   This is the one file big enough to justify a split. Everything else stays.
3. **Add `src/config.ts`** — one module that reads & validates all env vars at
   boot (fail fast if `GITHUB_APP_ID`, `DOMAIN`, etc. missing). Replaces scattered
   `process.env.X || fallback` reads. ~30 lines, high payoff.
4. **Add `.env.example`** documenting every var (table in §6).
5. **Delete** `workers/build-worker.ts` and scratch `test_*.cjs`.

That's it. Five moves, mostly deletions and one split.

---

## 5. Roadmap (phased)

- **Phase 0 — Unbreak (today).** P0-1, P0-2. Server boots, auth + bot work end to end.
- **Phase 1 — Node adapter + secret hygiene.** §2 swap; P1-1..P1-4. SSE + webhook HMAC become reliable.
- **Phase 2 — Deploy safety.** P2-1 (serialize/reserve ports), P2-2/P2-3 (correct build→deploy linkage, stable subdomains).
- **Phase 3 — Config + structure.** `src/config.ts`, github.service split, `.env.example`, delete dead code, fix import style.
- **Phase 4 — Server verification.** P2-4 (Caddy upstream from inside its container), end-to-end on the real host.
- **Phase 5 — Hardening.** access-token encryption, per-repo deploy config (port, env vars, healthcheck), deploy concurrency >1 with real port reservation.

---

## 6. Integration: frontend + the other org repos

### Boundaries (who owns what)

| Concern | Repo | Talks to this repo via |
|---|---|---|
| Dashboard / UI / login button | **frontend repo** | REST + cookie/Bearer session, SSE |
| DNS automation (wildcard / per-sub records) | **DNS handler repo** | (TBD) — see below |
| Caddy reverse proxy + ACME | **caddy-cloudflare-sqlite image repo** | **shared SQLite `routes` table** (no HTTP) |
| Deploy agent (this repo) | here | owns Podman + `routes`/`deployments`/`builds`/`users` tables |

### Contract with the **frontend**

The frontend already expects specific shapes — keep them stable:

- **Auth:** send user to `GET /api/auth/github`. After callback, the API redirects
  to `FRONTEND_URL?session_token=...` and sets an HttpOnly cookie. Frontend stores
  the token (or relies on the cookie) and sends `Authorization: Bearer <token>`.
- **Who am I:** `GET /api/auth/me`.
- **List repos:** `GET /api/repos` → `{ repos: [{ id, projectName, description,
  branch, status, ... }], count }` (already shaped for the UI in `github.routes.ts`).
- **Deploy a repo:** `POST /api/inject-workflow { repoFullName, runtime, branch }`
  → `{ buildId }`.
- **Stream build logs:** `GET /api/builds/:id/logs` (SSE; token via `?token=` since
  `EventSource` can't set headers — already supported in `extractToken`).
- **Manual/direct deploy:** `POST /api/deploy { image, subdomain, containerPort? }`.

> CORS is currently `cors()` wide-open — **lock it to `FRONTEND_URL`** before prod.

### Contract with the **Caddy-SQLite repo** (the critical, fragile one)

There is **no API** between this repo and Caddy — they communicate **only through
the shared SQLite `routes` table** (`domain TEXT PK, host, port`). This is a
contract by schema:

- This repo **writes** rows (`routesDb.upsert` / `.delete`).
- The Caddy `sqlite_router` plugin **reads** them live (no reload).
- **If the `routes` schema changes, both repos break.** Treat that table as a
  versioned public interface — document any change in both repos.
- Open question (P2-4): the `host` value `127.0.0.1` is written from this repo's
  perspective. From inside the Caddy container that loopback is wrong. Resolve to
  `host.containers.internal` (or run Caddy with host networking) and write *that*.

### Contract with the **DNS handler repo** (future)

Today HTTPS relies on a **wildcard** `*.<DOMAIN>` cert via Cloudflare DNS-01, so
per-subdomain DNS records may not even be required (wildcard A/AAAA + wildcard
cert covers `anything.<DOMAIN>`). Before building DNS automation, **confirm that's
true on the real setup** — if so, the DNS repo is YAGNI for the common case.

If per-subdomain records *are* needed (e.g. custom domains), the clean seam is:
this repo emits a "deployment ready" event (or the DNS repo reads the same
`deployments`/`routes` table) and the DNS repo reconciles Cloudflare records. Keep
the integration **table-driven or event-driven**, same philosophy as Caddy — no
tight HTTP coupling between agents.

### Env vars (single source of truth — fold into `src/config.ts` + `.env.example`)

| Var | Used by | Purpose |
|---|---|---|
| `PORT` | server | API port (default 3000) |
| `DOMAIN` | caddy.handler, github.service | base domain; host = `<sub>.<DOMAIN>` |
| `FRONTEND_URL` | auth.routes | post-login redirect target + (should be) CORS origin |
| `DB_PATH` | db/database | SQLite path (default `./data/plutoploy.db`) |
| `GITHUB_APP_ID` | github.service | App JWT issuer |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | github.service | OAuth exchange |
| `GITHUB_CALLBACK_URL` | github.service | OAuth redirect URI |
| `GITHUB_APP_LINK` | github.routes | install-app URL for users without installation |
| `GITHUB_WEBHOOK_SECRET` | webhook.routes | HMAC verification of webhooks |
| `GITHUB_APP_PRIVATE_KEY_PATH` *(proposed)* | github.service | replace hardcoded `.pem` path |
| `CLOUDFLARE_TOKEN` | Caddy container | DNS-01 ACME |
| `NODE_ENV` | auth.routes | `production` → `Secure` cookie |

---

## 7. Immediate next action

Fix **P0-1** and **P0-2** (≈10 lines total) — that revives the entire auth + bot
layer and lets the server boot. Then do the `@hono/node-server` swap (§2) so SSE
and webhook HMAC are reliable. Everything else is incremental.
