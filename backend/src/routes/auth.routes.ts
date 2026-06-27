/**
 * Auth Routes — GitHub OAuth flow
 *
 * GET  /api/auth/github              → Redirect user to GitHub authorize page
 * GET  /api/auth/github/callback     → Handle GitHub redirect, issue session token
 * GET  /api/auth/me                  → Return the current authenticated user
 * POST /api/auth/logout              → Invalidate the current session
 * POST /api/auth/logout/all          → Invalidate ALL sessions for this user
 */

import { Hono }                      from 'hono';
import { randomUUID }                from 'crypto';
import { authDb }                    from '../db/database.ts';
import type { AuthEnv }              from '../middleware/auth.middleware.ts';
import { requireAuth, signToken } from '../middleware/auth.middleware.ts';
import {
    buildAuthorizationUrl,
    exchangeCodeForToken,
    getGitHubUser,
    getGitHubUserEmail,
    getUserAppInstallationId,
} from '../services/github.service.ts';

const authRoutes = new Hono<AuthEnv>();

// Session token lifetime: 30 days
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// In-memory CSRF state store (simple map; good enough for a single-process server)
// For multi-process deployments, move this to the DB or Redis.
const oauthStates = new Map<string, number>(); // state → expiry timestamp

/** Clean up expired CSRF states periodically */
setInterval(() => {
    const now = Date.now();
    for (const [state, expiry] of oauthStates.entries()) {
        if (expiry < now) oauthStates.delete(state);
    }
}, 5 * 60 * 1000); // every 5 minutes

/**
 * GET /api/auth/github
 * Redirects the browser to the GitHub OAuth authorization page.
 */
authRoutes.get('/github', (c) => {
    // Generate & store a short-lived CSRF state token (10 min TTL)
    const state = randomUUID();
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);

    const url = buildAuthorizationUrl(state);
    return c.redirect(url, 302);
});

/**
 * GET /api/auth/github/callback
 * GitHub redirects here after the user authorizes (or denies) the app.
 *
 * Query params from GitHub:
 *   ?code=<auth_code>&state=<state>  — on success
 *   ?error=access_denied&state=<s>  — on denial
 */
authRoutes.get('/github/callback', async (c) => {
    const { code, state, error, installation_id } = c.req.query();

    // --- Handle denial / errors from GitHub ---
    if (error) {
        const frontendUrl = process.env.FRONTEND_URL || '/';
        return c.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(error)}`);
    }

    // --- Validate CSRF state ---
    if (!state || !oauthStates.has(state)) {
        return c.json({ error: 'Invalid or expired OAuth state. Please try again.' }, 400);
    }

    const stateExpiry = oauthStates.get(state)!;
    oauthStates.delete(state); // one-time use

    if (Date.now() > stateExpiry) {
        return c.json({ error: 'OAuth state expired. Please try again.' }, 400);
    }

    if (!code) {
        return c.json({ error: 'Missing authorization code from GitHub.' }, 400);
    }

    try {
        // 1. Exchange code → access token
        const tokenData = await exchangeCodeForToken(code);

        // 2. Fetch GitHub user profile & installations
        const [githubUser, primaryEmail, fetchedInstallId] = await Promise.all([
            getGitHubUser(tokenData.access_token),
            getGitHubUserEmail(tokenData.access_token),
            getUserAppInstallationId(tokenData.access_token),
        ]);

        const finalInstallationId = installation_id ?? fetchedInstallId;

        // 3. Upsert user in DB — include installation_id from GitHub App
        const user = await authDb.upsertUser({
            githubId:       String(githubUser.id),
            login:          githubUser.login,
            name:           githubUser.name,
            email:          githubUser.email ?? primaryEmail,
            avatarUrl:      githubUser.avatar_url,
            accessToken:    tokenData.access_token,
            installationId: finalInstallationId,
        });

        if (!user) {
            throw new Error('Failed to persist user record');
        }

        console.log('[auth] installation_id saved:', finalInstallationId ?? 'not provided/found');

        // 4. Sign a JWT — login + id in payload, no DB session row needed
        const token = signToken({ sub: user.id, login: user.login });
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

        // 5. Respond — set HttpOnly cookie AND return JSON with token so SPAs can use either
        const frontendUrl = process.env.FRONTEND_URL || '';
        const isProduction = process.env.NODE_ENV === 'production';

        const cookieFlags = [
            `session_token=${encodeURIComponent(token)}`,
            `HttpOnly`,
            `Path=/`,
            `Max-Age=${SESSION_TTL_MS / 1000}`,
            `SameSite=Lax`,
            isProduction ? 'Secure' : '',
        ].filter(Boolean).join('; ');

        c.header('Set-Cookie', cookieFlags);

        if (frontendUrl) {
            return c.redirect(
                `${frontendUrl}?session_token=${encodeURIComponent(token)}`
            );
        }

        return c.json({
            success: true,
            session_token: token,
            expires_at: expiresAt,
            user: {
                id:              user.id,
                github_id:       user.githubId,
                login:           user.login,
                name:            user.name,
                email:           user.email,
                avatar_url:      user.avatarUrl,
                installation_id: user.installationId,
            },
        });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Authentication failed';
        console.error('[auth] GitHub callback error:', err);
        return c.json({ error: message }, 500);
    }
});


/**
 * GET /api/auth/me
 * Returns the profile of the currently authenticated user.
 * Requires a valid session token.
 */
authRoutes.get('/me', requireAuth, async (c) => {
    const { sub } = c.get('user');
    const user = await authDb.getUserById(sub);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({
        user: {
            id:         user.id,
            github_id:  user.githubId,
            login:      user.login,
            name:       user.name,
            email:      user.email,
            avatar_url: user.avatarUrl,
            created_at: user.createdAt,
        },
    });
});

/**
 * POST /api/auth/logout
 * Invalidates the current session token.
 */
authRoutes.post('/logout', requireAuth, (c) => {
    c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return c.json({ success: true, message: 'Logged out successfully' });
});

export { authRoutes };
