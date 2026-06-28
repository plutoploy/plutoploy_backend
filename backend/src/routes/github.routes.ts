/**
 * GitHub Routes
 *
 * GET  /api/repos   — List repositories the user gave the GitHub App access to
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../middleware/auth.middleware.ts';
import { authDb, buildsDb } from '../db/database.ts';
import { generateInstallationToken, getInstallationRepos, injectWorkflowToRepo } from '../services/github.service.ts';
import { randomUUID } from 'crypto';
import type { AuthEnv } from '../middleware/auth.middleware.ts';

const githubRoutes = new Hono<AuthEnv>();

/**
 * GET /api/repos
 * Returns the list of repositories the authenticated user has granted
 * the GitHub App access to.
 *
 * Requires: session token (Authorization: Bearer <token> or cookie)
 */
githubRoutes.get('/repos', requireAuth, async (c) => {
    const { sub } = c.get('user');

    // Repos come from the GitHub App installation (the repos the user granted at
    // install time). Returns public + private together, each with a `private` flag.
    const installationId = await authDb.getUserInstallationId(sub);
    if (!installationId) {
        return c.json({
            error: 'GitHub App not installed',
            message: 'Please install the Plutoploy GitHub App to grant repo access.',
            install_url: process.env.GITHUB_APP_LINK
                ? `${process.env.GITHUB_APP_LINK}/installations/new`
                : null,
        }, 403);
    }

    try {
        const installationToken = await generateInstallationToken(installationId);
        const repos = await getInstallationRepos(installationToken);

        // Helper to format relative time
        const timeAgo = (dateStr: string) => {
            const seconds = Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / 1000);
            let interval = seconds / 31536000;
            if (interval > 1) return Math.floor(interval) + " years ago";
            interval = seconds / 2592000;
            if (interval > 1) return Math.floor(interval) + " months ago";
            interval = seconds / 86400;
            if (interval > 1) return Math.floor(interval) + " days ago";
            interval = seconds / 3600;
            if (interval > 1) return Math.floor(interval) + " hours ago";
            interval = seconds / 60;
            if (interval > 1) return Math.floor(interval) + " minutes ago";
            return Math.floor(seconds) + " seconds ago";
        };

        // 4. Return the format expected by the frontend
        return c.json({
            repos: repos.map(r => ({
                id: String(r.id),
                projectName: r.name,
                description: r.description,
                private: r.private,         // public/private — frontend separates on this
                commitHash: 'N/A',          // Not deployed yet, so no commit hash available here directly
                branch: r.default_branch,
                status: 'not_deployed',     // ponytail: no deploy yet → honest state. Frontend shows a "Deploy" button on this; real status joins from deployments table once builds exist.
                duration: '-',              // Not applicable until deployed
                timestamp: timeAgo(r.updated_at),
                // Keeping some originals just in case
                full_name: r.full_name,
                html_url: r.html_url
            })),
            count: repos.length,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to fetch repositories';
        console.error('[GitHub Routes] /api/repos error:', err);
        return c.json({ error: message }, 500);
    }
});

/**
 * POST /inject-workflow
 * Injects a deployment workflow and necessary docker config into a repository.
 *
 * Body: { repoFullName: string, runtime: 'node' | 'python', branch: string }
 */
githubRoutes.post('/inject-workflow', requireAuth, async (c) => {
    const { sub } = c.get('user');

    const body = await c.req.json().catch(() => null);

    if (!body) {
        return c.json({ error: 'Invalid request body' }, 400);
    }

    const {
        repoFullName,
        runtime,
        branch
    } = body;

    if (!repoFullName || !runtime || !branch) {
        return c.json({
            error: 'Missing required fields: repoFullName, runtime, branch'
        }, 400);
    }

    if (!['node', 'python'].includes(runtime)) {
        return c.json({
            error: 'Invalid runtime. Must be "node" or "python"'
        }, 400);
    }

    const installationId = await authDb.getUserInstallationId(sub);

    if (!installationId) {
        return c.json({
            error: 'GitHub App not installed'
        }, 403);
    }

    try {
        const installationToken =
            await generateInstallationToken(installationId);//Why Generating tokes ?

        await injectWorkflowToRepo(
            repoFullName,
            runtime as 'node' | 'python', // need to change here 
            branch,
            installationToken
        );

        const buildId = randomUUID();

        await buildsDb.create({
            id: buildId,
            repo: repoFullName,
            branch
        });

        return c.json({
            success: true,
            message: 'Workflow injected successfully',
            buildId
        });
    } catch (error) {
        console.error(
            '[GitHub Routes] /inject-workflow error:',
            error
        );

        return c.json({
            error:
                error instanceof Error
                    ? error.message
                    : 'Failed to inject workflow'
        }, 500);
    }

});


/**
 * GET /builds/:id/logs
 * Stream live GitHub Action build status to the frontend via SSE.
 *
 * Source: the external gh-bot/PartyKit server. It rebroadcasts GitHub webhook
 * events on a room keyed by github username (= repo owner) at
 * `${PARTYKIT_WS_URL}/party/<owner>`. One socket carries events for all of that
 * user's running projects, so we filter by `channel` (= `<owner>/<repo>/run-...`)
 * down to this build's repo. PartyKit has no replay — only events arriving after
 * we connect are seen.
 *
 * ponytail: one WS per open SSE stream, no buffer/table. PartyKit has no replay
 * and these are tiny status events, so a build_logs table would be dead weight.
 * Upgrade path = a shared per-user WS manager + build_logs table, only if
 * multi-viewer/replay becomes a real need.
 */
const PARTYKIT_WS_URL =
    process.env.PARTYKIT_WS_URL || 'wss://plutoploy-gh-bot.pratyay360.partykit.dev';

/**
 * Decide what to do with one raw PartyKit message for a given build repo.
 * Pure (no I/O) so it's unit-testable without a socket. Returns null to ignore.
 */
export function interpretBuildEvent(raw: string, repo: string): null | {
    forward: { event?: string; action?: string; job?: string; status?: string; conclusion?: string; url?: string; ts?: any };
    done: boolean;
    success: boolean;
} {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return null; }

    // Only events for this build's repo (channel = `<owner>/<repo>/run-...`)
    if (!msg?.channel || !String(msg.channel).startsWith(repo)) return null;

    const p = msg.payload ?? {};
    // Only the whole run completing is terminal. A single job completing is just a
    // step — a multi-job build emits several `workflow_job` completions before the
    // run is done, and one run also emits both a job- and a run-completion.
    const done = p.event === 'workflow_run' && p.action === 'completed';
    return {
        forward: {
            event: p.event, action: p.action, job: p.jobName,
            status: p.status, conclusion: p.conclusion, url: p.url, ts: p.timestamp,
        },
        done,
        success: done && p.conclusion === 'success',
    };
}

githubRoutes.get('/builds/:id/logs', requireAuth, async (c) => {
    const { sub } = c.get('user');
    const build = await buildsDb.getById(c.req.param('id')) as any;

    if (!build) {
        return c.json({ error: 'Build not found' }, 404);
    }

    // Make sure the build belongs to the requesting user
    if (build.user_id && build.user_id !== sub) {
        return c.json({ error: 'Unauthorized' }, 403);
    }

    const owner = String(build.repo).split('/')[0];      // party room = github username
    const url = `${PARTYKIT_WS_URL}/party/${owner}`;

    return streamSSE(c, async (stream) => {
        const ws = new WebSocket(url);
        let settle: () => void;
        const done = new Promise<void>((res) => { settle = res; });

        // Safety net: a stuck build must not pin the connection forever.
        const timer = setTimeout(() => settle(), 10 * 60 * 1000);

        ws.onopen = () => {
            void stream.writeSSE({ event: 'status', data: 'connected' });
        };

        ws.onmessage = async (ev) => {
            const r = interpretBuildEvent(ev.data as string, build.repo);
            if (!r) return;                              // not this build / unparseable

            await stream.writeSSE({ event: 'build', data: JSON.stringify(r.forward) });

            if (r.done) {                                // success/failure detection
                await buildsDb.updateState(build.id, r.success ? 'success' : 'failure');
                await stream.writeSSE({ event: 'done', data: r.forward.conclusion ?? 'unknown' });
                settle();
            }
        };

        ws.onerror = () => settle();
        ws.onclose = () => settle();
        stream.onAbort(() => ws.close());                // frontend disconnected

        await done;
        clearTimeout(timer);
        ws.close();
    });

});


export { githubRoutes };
