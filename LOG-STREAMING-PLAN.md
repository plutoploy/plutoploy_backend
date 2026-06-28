# Plan — Live build-log streaming (PartyKit WS → frontend SSE)

> Goal: the frontend's `GET /api/builds/:id/logs` (SSE) shows **live** GitHub-Actions
> build status, fed from the external **gh-bot / PartyKit** server over WebSocket,
> with success/failure detection.
>
> Scope: this repo only. The gh-bot repo (separate) already receives GitHub
> webhooks and rebroadcasts them over WS — we just **consume** them.

---

## 1. The flow we're building

```
GitHub Actions build
   │  (GitHub webhooks: workflow_run / workflow_job)
   ▼
gh-bot / PartyKit  (OTHER REPO)
   │  broadcasts on room  party/<github_username>
   ▼  wss://plutoploy-gh-bot.pratyay360.partykit.dev/party/<username>
THIS deploy agent  ── WS client, one per open SSE stream ──┐
   │  filter by channel == this build's repo               │
   │  parse → forward subset → detect completed            │
   ▼  SSE                                                   │
Frontend  GET /api/builds/:id/logs  ◄──────────────────────┘
```

The existing GitHub-webhook receiver (`POST /api/webhooks/github`) still owns the
**deploy trigger** (Flow C). This plan only changes the **log/status display** path.
They are independent — don't merge them.

## 2. The contract (confirmed)

PartyKit pushes JSON like:

```json
{
  "type": "webhook",
  "channel": "Debzoti/test/run-28012987572",
  "payload": {
    "event": "workflow_job",
    "action": "completed",
    "jobId": 82910419266,
    "runId": 28012987572,
    "jobName": "build",
    "status": "completed",
    "conclusion": "success",
    "url": "https://github.com/Debzoti/test/actions/runs/28012987572/job/82910419266",
    "timestamp": "2026-06-23T08:29:50.195Z"
  },
  "timestamp": 1782203390334
}
```

- **Room (party) = github username** = the repo owner. For build `Debzoti/test`,
connect to `…/party/Debzoti`.
- `**channel` = `<owner>/<repo>/run-<runId>`** — one user's socket carries events
for *all* their running projects, so we filter on `channel.startsWith(build.repo)`.
- **No history replay** — only events arriving after we connect. So there's nothing
to persist/replay; a buffer table would be dead weight (YAGNI).
- **Done signal**: `payload.action === 'completed'` → `payload.conclusion`
(`success` | `failure` | …).

## 3. Decisions (resolved — don't relitigate)


| Decision             | Choice                                                                              | Why                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| WS client lib        | **native global `WebSocket*`*                                                       | Node 22 ships it stable. No `ws` dep.                                              |
| Bridge model         | **per-SSE pass-through** (open WS when frontend connects, close on done/disconnect) | No replay + ephemeral status events = no buffer/table needed. Laziest correct fit. |
| Party key            | `build.repo.split('/')[0]` (owner = username)                                       | Matches PartyKit room naming.                                                      |
| Build correlation    | `channel.startsWith(build.repo)`                                                    | `channel` embeds `owner/repo/run-…`.                                               |
| Persist final status | `buildsDb.updateState(success/failure)` on `completed`                              | Already have the method; one line.                                                 |
| New env var          | `PARTYKIT_WS_URL` (default `wss://plutoploy-gh-bot.pratyay360.partykit.dev`)        | Don't hardcode the host.                                                           |


**Ceiling of the lazy model** (`// ponytail:` it in code): N frontend viewers of the
same build = N WS connections; logs before connect are lost. Acceptable because
PartyKit has no replay anyway and viewers are ~1. Upgrade path = the persistent
manager + `build_logs` table, only if multi-viewer/replay becomes real.

---

## Phase 0 — REQUIRED FIRST: Hono → `@hono/node-server`

The hand-rolled `createServer` bridge in `backend/server.ts` buffers the whole
request and pipes the response through a manual `res.write()` loop with **no header
flush / keep-alive**. SSE through it is unreliable — the client may see nothing
until the stream closes. The proper adapter is **already a dependency** and unused.

**Change `backend/server.ts`** — delete the entire `createServer(...)` block
(lines ~50–93) and replace the bottom of `startServer()`:

```ts
import { serve } from '@hono/node-server';
// ...app construction unchanged...

export function startServer() {
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`🚀 Deployment API running on port ${info.port}`);
  });
  process.on('SIGINT',  () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  return server;
}
export { app };
```

- `serve()` returns a Node `http.Server`, so `index.ts`'s `startServer()` call and
`server.close()` still work unchanged.
- Free wins: SSE flushes correctly **and** webhook HMAC stops desyncing (the raw
body no longer round-trips through a manual Buffer→Request rewrap).

**Verify Phase 0 before touching logs:** `npm run dev`, hit `GET /health`, and POST a
signed test to `/api/webhooks/github` — confirm it boots and HMAC passes.

---

## Phase 1 — WS→SSE bridge

Replace the polling loop in `backend/src/routes/github.routes.ts`
(`GET /builds/:id/logs`, currently lines ~173–269) with a WS bridge.

```ts
const PARTYKIT_WS_URL =
  process.env.PARTYKIT_WS_URL || 'wss://plutoploy-gh-bot.pratyay360.partykit.dev';

githubRoutes.get('/builds/:id/logs', requireAuth, async (c) => {
  const user = c.get('user');
  const build = buildsDb.getById(c.req.param('id')) as any;
  if (!build) return c.json({ error: 'Build not found' }, 404);
  if (build.user_id && build.user_id !== user.id)
    return c.json({ error: 'Unauthorized' }, 403);

  const owner = build.repo.split('/')[0];                 // party = github username
  const url = `${PARTYKIT_WS_URL}/party/${owner}`;

  return streamSSE(c, async (stream) => {
    const ws = new WebSocket(url);
    let settle: () => void;
    const done = new Promise<void>((res) => (settle = res));

    // 10-min safety net so a stuck build can't pin the connection forever
    const timer = setTimeout(() => settle(), 10 * 60 * 1000);

    ws.onopen = () => stream.writeSSE({ event: 'status', data: 'connected' });

    ws.onmessage = async (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (!msg?.channel?.startsWith(build.repo)) return;   // not this build
      const p = msg.payload ?? {};

      await stream.writeSSE({
        event: 'build',
        data: JSON.stringify({                              // forward only what UI needs
          event: p.event, action: p.action, job: p.jobName,
          status: p.status, conclusion: p.conclusion,
          url: p.url, ts: p.timestamp,
        }),
      });

      if (p.action === 'completed') {                       // success/failure detection
        const ok = p.conclusion === 'success';
        buildsDb.updateState(build.id, ok ? 'success' : 'failure');
        await stream.writeSSE({ event: 'done', data: p.conclusion ?? 'unknown' });
        settle();
      }
    };

    ws.onerror = () => settle();
    ws.onclose = () => settle();
    stream.onAbort(() => ws.close());                       // frontend went away

    await done;
    clearTimeout(timer);
    ws.close();
  });
});
```

### What the frontend receives (named SSE events)

- `event: status` — `connected`
- `event: build`  — JSON `{ event, action, job, status, conclusion, url, ts }`
- `event: done`   — final conclusion string; stream then closes

Frontend keeps using `EventSource` with `?token=` (already supported by
`extractToken`). No frontend contract break — just richer, real data instead of the
old canned `"Build in progress…"` strings.

## Phase 1.5 — env + docs

- Add `PARTYKIT_WS_URL` to `.env` (and `.env.example` if/when created) and to the
env table in `ARCHITECTURE.md` §6.
- One-line note in `ARCHITECTURE.md` Flow C: build logs now stream via gh-bot WS,
not GitHub-API polling.

---

## Edge cases / gotchas

- **Wrong party / closed build**: if the build already finished before the frontend
opens SSE, no events arrive (no replay) → the 10-min timer closes it. Frontend
should fall back to the build's stored `status` for already-finished builds.
- **Multiple projects on one user socket**: handled by `channel.startsWith(build.repo)`.
If a user has two repos with the same prefix, also match `run-<github_run_id>`
once `build.github_run_id` is set by the webhook.
- **Auth on the WS to gh-bot**: current contract is an open room keyed by username.
If gh-bot later requires a token, add `?token=` / header to the `new WebSocket(url)`.
- **Don't** trigger deploy from this stream — deploy stays on `/api/webhooks/github`.

## Status — DONE & verified live (2026-06-23)

- **Phase 0** ✅ `server.ts` now uses `@hono/node-server` `serve()` (−48 lines). Boots
clean; `/health` + `/` OK.
- **Phase 1** ✅ `GET /builds/:id/logs` rewritten as a PartyKit-WS → SSE bridge.
Decision logic extracted to the pure `interpretBuildEvent(raw, repo)`.
- **End-to-end** ✅ Listened on the real `party/Debzoti` room and ran a live GitHub
Action. All 6 events (`workflow_run`/`workflow_job` × requested→in_progress→
completed) arrived and parsed correctly. Transport, real-format parsing, channel
isolation, and success detection all confirmed against live data.
- **Terminal-event fix** ✅ One run emits **two** `completed` events — a
`workflow_job` one *and* a `workflow_run` one (and multi-job builds emit several
job-completions). So `done` triggers **only** on `event === 'workflow_run' && action === 'completed'`. Job-completions still forward as progress. Exactly one
`done` per build.

---

## Manual testing

Two levels. Level 1 needs no auth/DB and proves the feed; Level 2 exercises the real
SSE endpoint.

### Level 1 — prove logs arrive (no auth, no build record)

`backend/test_ws_live.ts` connects straight to the real PartyKit room and prints each
message + what `interpretBuildEvent` extracts.

```bash
PARTY=Debzoti node --import tsx/esm backend/test_ws_live.ts
# wait for "✅ CONNECTED" (PartyKit has NO replay — must be connected first)
# → now trigger the GitHub Action; events stream in live
```

Pure-logic regression check (no network):

```bash
node --import tsx/esm backend/test_logstream.ts   # → all checks passed
```

### Level 2 — the real SSE endpoint (`curl -N`)

```bash
npm run dev
curl -N "http://localhost:3000/api/builds/<BUILD_ID>/logs?token=<SESSION_TOKEN>"
# then trigger the Action. Expect a stream of:
#   event: status\n data: connected
#   event: build\n  data: {"event":"workflow_run","action":"in_progress",...}
#   event: done\n   data: success      ← then the stream closes
```

> **Auth is intentionally not the focus** (OAuth/DB are changing later). To test
> Level 2 without fighting it you need (a) a `builds` row whose `id` you pass, and
> (b) a session token, OR temporarily relax `requireAuth` on this one route while
> testing. Level 1 already proves the log functionality independent of auth — prefer
> it for log-path testing.

### What "passing" looks like

- `build` events stream as the Action progresses.
- A successful run ends with `event: done` / `data: success`, stream closes, and
`builds.status` is set to `success` (failure → `failure`).
- A second repo's events on the same user socket are **not** forwarded (isolation).

---

## Serving to the frontend

The endpoint is plain SSE with **named events**, so the frontend uses `EventSource`.
`EventSource` can't set headers, so the session token goes in the query string
(`extractToken` already accepts `?token=`).

```js
const es = new EventSource(
  `${API}/api/builds/${buildId}/logs?token=${sessionToken}`
);

es.addEventListener('status', (e) => {
  // e.data === 'connected'
});

es.addEventListener('build', (e) => {
  const ev = JSON.parse(e.data);
  // { event, action, job, status, conclusion, url, ts }
  appendLogLine(`${ev.event}/${ev.action}` + (ev.job ? ` (${ev.job})` : ''));
});

es.addEventListener('done', (e) => {
  // e.data === 'success' | 'failure' | ...
  markBuild(e.data);
  es.close();                 // server already closed; this is belt-and-suspenders
});

es.onerror = () => { /* reconnect or show 'stream lost' */ };
```

**Rendering tip:** the events are coarse *status* (queued → in_progress → completed),
not line-by-line shell output — drive a step/timeline UI from `event`+`action`+`job`,
not a raw log console. Use `ev.url` to deep-link to the GitHub Actions run.

**Already-finished builds:** since PartyKit has no replay, opening the stream for a
build that already completed yields no events until the 10-min timeout. The frontend
should first read the build's stored `status`; only open the SSE stream for builds
that are still running.

> Before prod: lock CORS to `FRONTEND_URL` (currently wide-open `cors()`).

## Out of scope (YAGNI for now)

- Persistent `build_logs` table / history replay (add only if multi-viewer or
reconnect-resume is needed).
- A shared WS connection manager (one socket per user) — only worth it if many
concurrent viewers appear.
- Changes to the injected workflow templates — gh-bot already sources the events.

