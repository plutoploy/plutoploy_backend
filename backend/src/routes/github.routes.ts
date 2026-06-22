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
    const user = c.get('user');

    // 1. Look up their installation_id
    const installationId = authDb.getUserInstallationId(user.id);

    if (!installationId) {
        return c.json({
            error: 'GitHub App not installed',
            message: 'Please install the Plutoploy GitHub App on your account to grant repo access.',
            install_url: process.env.GITHUB_APP_LINK
                ? `${process.env.GITHUB_APP_LINK}/installations/new`
                : null,
        }, 403);
    }

    try {
        // 2. Generate a short-lived Installation Access Token
        const installationToken = await generateInstallationToken(installationId);

        // 3. Fetch repos via the Installation API
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
                description: r.description, // <-- ADDED THIS
                commitHash: 'N/A',          // Not deployed yet, so no commit hash available here directly
                branch: r.default_branch,
                status: 'success',          // Mocking 'success' for now, can be updated with real deploy status later
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
    const user = c.get('user');

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

    const installationId = authDb.getUserInstallationId(user.id);

    if (!installationId) {
        return c.json({
            error: 'GitHub App not installed'
        }, 403);
    }

    try {
        const installationToken =
            await generateInstallationToken(installationId);

        await injectWorkflowToRepo(
            repoFullName,
            runtime as 'node' | 'python',
            branch,
            installationToken
        );

        const buildId = randomUUID();

        buildsDb.create({
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
 * Stream GitHub Action build logs to the frontend via SSE.
 */
githubRoutes.get('/builds/:id/logs', requireAuth, async (c) => {
    const user = c.get('user');
    const buildId = c.req.param('id');


    const build = buildsDb.getById(buildId) as any;

    if (!build) {
        return c.json({
            error: 'Build not found'
        }, 404);
    }

    // Important: make sure build belongs to user
    if (build.user_id && build.user_id !== user.id) {
        return c.json({
            error: 'Unauthorized'
        }, 403);
    }

    return streamSSE(c, async (stream) => {
        const startTime = Date.now();
        const timeoutMs = 10 * 60 * 1000; // 10 minutes

        let lastStatus = '';
        let lastRunId = '';

        await stream.writeSSE({
            data: 'Build initialized...'
        });

        while (true) {
            const currentBuild = buildsDb.getById(buildId) as any;

            if (!currentBuild) {
                await stream.writeSSE({
                    data: 'Build record not found.'
                });
                break;
            }

            if (Date.now() - startTime > timeoutMs) {
                await stream.writeSSE({
                    data: 'Build monitoring timed out.'
                });
                break;
            }

            if (
                currentBuild.github_run_id &&
                currentBuild.github_run_id !== lastRunId
            ) {
                lastRunId = currentBuild.github_run_id;

                await stream.writeSSE({
                    data: `GitHub Action started (${lastRunId})`
                });
            }

            if (
                currentBuild.status &&
                currentBuild.status !== lastStatus
            ) {
                lastStatus = currentBuild.status;

                switch (currentBuild.status) {
                    case 'pending':
                        await stream.writeSSE({
                            data: 'Waiting for GitHub Actions...'
                        });
                        break;

                    case 'in_progress':
                        await stream.writeSSE({
                            data: 'Build in progress...'
                        });
                        break;

                    case 'success':
                        await stream.writeSSE({
                            data: 'Build completed successfully.'
                        });
                        return;

                    case 'failure':
                        await stream.writeSSE({
                            data: 'Build failed.'
                        });
                        return;
                }
            }

            await stream.sleep(1000);
        }
    });

});


export { githubRoutes };
