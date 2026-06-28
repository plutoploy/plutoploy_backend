/**
 * GitHub App Service
 * Handles all communication with GitHub's App API, OAuth, and REST endpoints.
 */

import fs from 'fs';
import path from 'path';
import { createSign } from 'crypto';

const GITHUB_OAUTH_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';

// Path to private key — placed in project root, gitignored via *.pem.
// Override with GITHUB_APP_PEM_PATH; falls back to the file in the repo root.
const PEM_PATH = path.resolve(
    process.cwd(),
    process.env.GITHUB_APP_PEM_PATH || 'plutoploy-gh-bot.2026-06-28.private-key.pem',
);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHubUser {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string;
    html_url: string;
    public_repos: number;
    followers: number;
}

export interface GitHubTokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
    error?: string;
    error_description?: string;
}

export interface GitHubRepo {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    html_url: string;
    description: string | null;
    default_branch: string;
    updated_at: string;
    language: string | null;
}

// ─── JWT / Installation Token ─────────────────────────────────────────────────

/**
 * Create a signed JWT for GitHub App authentication.
 * Valid for 60 seconds — used only to get an Installation Access Token.
 */
function createAppJwt(): string {
    const appId = process.env.GITHUB_APP_ID;
    if (!appId) throw new Error('GITHUB_APP_ID must be set in environment');

    if (!fs.existsSync(PEM_PATH)) {
        throw new Error(`GitHub App private key not found at: ${PEM_PATH}`);
    }

    const privateKey = fs.readFileSync(PEM_PATH, 'utf-8');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iat: now - 60,    // issued 60s ago (clock skew buffer)
        exp: now + 600,   // expires in 10 minutes
        iss: appId,
    };

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signing = `${header}.${body}`;

    const sign = createSign('RSA-SHA256');
    sign.update(signing);
    sign.end();
    const signature = sign.sign(privateKey, 'base64url');

    return `${signing}.${signature}`;
}

// ponytail: in-memory token cache. GitHub installation tokens live 1h; reuse
// until ~2min before expiry instead of minting one per request. Dies on restart
// (fine — it just re-mints). Move to Redis only if you run multiple processes.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Generate a short-lived Installation Access Token (valid 1 hour).
 * This token is used for all GitHub API calls on behalf of a user.
 * Cached per installationId until ~2min before expiry.
 */
export async function generateInstallationToken(installationId: string): Promise<string> {
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAt - 120_000 > Date.now()) {
        return cached.token;
    }

    console.log('\n[GitHub App] ── Generating Installation Token ───────────');
    console.log('[GitHub App] Installation ID:', installationId);

    const jwt = createAppJwt();

    const response = await fetch(
        `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Plutoploy/1.0',
            },
        }
    );

    if (!response.ok) {
        const body = await response.text();
        console.error('[GitHub App] Installation token error:', body);
        throw new Error(`Failed to generate installation token: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { token: string; expires_at: string };
    console.log('[GitHub App] Token generated, expires at:', data.expires_at);
    console.log('[GitHub App] ─────────────────────────────────────────────\n');

    tokenCache.set(installationId, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
    return data.token;
}

/**
 * Fetch all repositories the user has given the App access to.
 */
export async function getInstallationRepos(installationToken: string): Promise<GitHubRepo[]> {
    console.log('\n[GitHub App] ── Fetching Installation Repos ─────────────');
    const repos: GitHubRepo[] = [];
    let url: string | null = `${GITHUB_API_BASE}/installation/repositories?per_page=100`;

    // GitHub paginates using Link headers
    while (url) {
        const response : any = await ghFetch(url, {
            headers: {
                Authorization: `Bearer ${installationToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Plutoploy/1.0',
            },
        });

        if (!response.ok) {
            const body = await response.text();
            console.error('[GitHub App] Repo list error:', body);
            throw new Error(`Failed to fetch repos: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { repositories: GitHubRepo[]; total_count: number };
        repos.push(...data.repositories);

        // Check for next page via Link header
        const linkHeader = response.headers.get('Link') ?? '';
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = nextMatch ? (nextMatch[1] ?? null) : null;
    }

    console.log('[GitHub App] Total repos fetched:', repos.length);
    console.log('[GitHub App] ─────────────────────────────────────────────\n');

    return repos;
}

// ─── OAuth flow (unchanged — GitHub App uses same OAuth exchange) ─────────────

/**
 * fetch() with retries — the network to GitHub here is flaky (intermittent
 * UND_ERR_CONNECT_TIMEOUT / socket closed). 3 attempts turns a ~1-in-3 failure
 * into ~1-in-27, so a login doesn't die on a single dropped connection.
 * ponytail: bump `attempts` if the link is worse; not a substitute for fixing the network.
 */
async function ghFetch(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fetch(url, init);
        } catch (err) {
            lastErr = err;
            console.warn(`[GitHub] fetch failed (attempt ${i}/${attempts}): ${url}`);
            if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i));
        }
    }
    throw lastErr;
}

/**
 * Exchange OAuth authorization code for an access token.
 * Uses GitHub App CLIENT_ID/SECRET (was previously OAuth App credentials).
 */
export async function exchangeCodeForToken(code: string): Promise<GitHubTokenResponse> {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set in environment');
    }

    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code });

    console.log('\n[GitHub] ── Token Exchange ─────────────────────────────');
    console.log('[GitHub] POST', GITHUB_OAUTH_URL);
    console.log('[GitHub] client_id:', clientId);

    const response = await ghFetch(`${GITHUB_OAUTH_URL}?${params.toString()}`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });

    console.log('[GitHub] Response status:', response.status, response.statusText);

    if (!response.ok) {
        throw new Error(`GitHub token exchange failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as GitHubTokenResponse;

    console.log('[GitHub] Token response:', {
        access_token: data.access_token ? `${data.access_token.slice(0, 6)}...` : 'MISSING',
        token_type: data.token_type,
        scope: data.scope,
        error: data.error,
        error_description: data.error_description,
    });
    console.log('[GitHub] ─────────────────────────────────────────────────\n');

    if (data.error) {
        throw new Error(`GitHub OAuth error: ${data.error} — ${data.error_description}`);
    }

    return data;
}

/**
 * Fetch the authenticated user's GitHub profile using an access token.
 */
export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
    console.log('\n[GitHub] ── Fetching User Profile ───────────────────────');

    const response = await ghFetch(`${GITHUB_API_BASE}/user`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Plutoploy/1.0',
        },
    });

    console.log('[GitHub] User API status:', response.status, response.statusText);

    if (!response.ok) {
        const body = await response.text();
        console.error('[GitHub] User API error body:', body);
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const user = await response.json() as GitHubUser;

    console.log('[GitHub] User profile received:', {
        id: user.id,
        login: user.login,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url ? '✅ present' : '❌ missing',
        public_repos: user.public_repos,
    });
    console.log('[GitHub] ─────────────────────────────────────────────────\n');

    return user;
}

/**
 * Fetch the authenticated user's primary verified email.
 */
export async function getGitHubUserEmail(accessToken: string): Promise<string | null> {
    console.log('[GitHub] ── Fetching User Emails ────────────────────────');

    try {
        const response = await ghFetch(`${GITHUB_API_BASE}/user/emails`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Plutoploy/1.0',
            },
        });

        if (!response.ok) {
            console.warn('[GitHub] Could not fetch emails — continuing without email');
            return null;
        }

        const emails = await response.json() as Array<{
            email: string;
            primary: boolean;
            verified: boolean;
        }>;

        const primary = emails.find(e => e.primary && e.verified);
        console.log('[GitHub] Primary verified email:', primary?.email ?? 'none found');
        console.log('[GitHub] ─────────────────────────────────────────────────\n');

        return primary?.email ?? null;
    } catch (err) {
        console.error('[GitHub] Email fetch threw an exception:', err);
        return null;
    }
}

// NOTE: removed getUserAppInstallationId(). GET /user/installations needs a
// *GitHub App* user-to-server token, but login here uses a separate OAuth App
// token, so it always returned 403. installation_id is captured via the Setup
// URL redirect (/api/auth/github/setup) instead.

/**
 * Build the GitHub App authorization URL.
 * Routes through the App installation page so users grant repo access + login in one step.
 */
export function buildAuthorizationUrl(state: string): string {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const callbackUrl = process.env.GITHUB_CALLBACK_URL
        || `http://${process.env.DOMAIN || 'localhost'}:${process.env.PORT || '3000'}/api/auth/github/callback`;

    if (!clientId) throw new Error('GITHUB_CLIENT_ID must be set in environment');

    // Always use standard OAuth. Users who haven't installed the app can be 
    // prompted to do so separately, or we can fetch their installations post-login.
    const authUrl = `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        scope: 'read:user user:email',
        state,
    }).toString()}`;

    console.log('\n[GitHub] ── Building Authorization URL ──────────────────');
    console.log('[GitHub] Full URL:', authUrl);
    console.log('[GitHub] ─────────────────────────────────────────────────\n');

    return authUrl;
}

// ─── Workflow Injection ───────────────────────────────────────────────────────

/**
 * Uploads a single file to a GitHub repository using the Installation App Token.
 */
async function uploadFileToRepo(
    repoFullName: string,
    filePath: string,
    contentStr: string,
    commitMessage: string,
    branch: string,
    installationToken: string
): Promise<void> {
    console.log(`[GitHub App] Uploading file to ${repoFullName}: ${filePath}`);

    let sha: string | undefined;

    // 1. Check if file exists to get SHA
    try {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/contents/${filePath}?ref=${branch}`;
        const existingRes = await fetch(url, {
            headers: {
                Authorization: `Bearer ${installationToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Plutoploy/1.0',
            },
        });

        if (existingRes.ok) {
            const data = await existingRes.json() as { sha: string };
            sha = data.sha;
            console.log(`[GitHub App] File exists, sha: ${sha}`);
        } else if (existingRes.status !== 404) {
            console.warn(`[GitHub App] Warning fetching sha for ${filePath}: ${existingRes.status}`);
        }
    } catch (err) {
        console.warn(`[GitHub App] Error fetching sha for ${filePath}:`, err);
    }

    // 2. Put the file
    const contentBase64 = Buffer.from(contentStr).toString('base64');
    
    const putUrl = `${GITHUB_API_BASE}/repos/${repoFullName}/contents/${filePath}`;
    const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${installationToken}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Plutoploy/1.0',
        },
        body: JSON.stringify({
            message: commitMessage,
            content: contentBase64,
            branch,
            ...(sha ? { sha } : {})
        })
    });

    if (!putRes.ok) {
        const body = await putRes.text();
        console.error(`[GitHub App] Error uploading ${filePath}:`, body);
        throw new Error(`Failed to upload ${filePath}: ${putRes.status} ${putRes.statusText}`);
    }
    
    console.log(`[GitHub App] successfully uploaded ${filePath}`);
}

/**
 * Orchestrates the workflow injection process for a repository.
 */
export async function injectWorkflowToRepo(
    repoFullName: string,
    runtime: 'node' | 'python',
    branch: string,
    installationToken: string
): Promise<void> {
    console.log(`\n[GitHub App] ── Injecting Workflow (${runtime}) ─────────`);
    console.log(`[GitHub App] Repo: ${repoFullName}, Branch: ${branch}`);

    const templatesPath = path.resolve(process.cwd(), 'backend/src/templates');
    
    // Load file contents
    const readTemplate = (subPath: string) => fs.readFileSync(path.join(templatesPath, subPath), 'utf-8');

    let workflowContent = '';
    let dockerfileContent = '';

    if (runtime === 'node') {
        workflowContent = readTemplate('workflows/node.yml');
        dockerfileContent = readTemplate('docker/Dockerfile.node');
    } else {
        workflowContent = readTemplate('workflows/python.yml');
        dockerfileContent = readTemplate('docker/Dockerfile.python');
    }

    // Replace the default main branch inside the workflow template if needed
    workflowContent = workflowContent.replace(/branches: \["main"\]/g, `branches: ["${branch}"]`);

    const dockerComposeContent = readTemplate('docker/docker-compose.yml');
    const dockerIgnoreContent = readTemplate('docker/.dockerignore');

    const timestamp = Date.now();
    const commitMessage = `chore: install plutoploy ${runtime} deployment config - ${timestamp}`;

    // Upload sequentially
    await uploadFileToRepo(repoFullName, '.github/workflows/build.yml', workflowContent, commitMessage, branch, installationToken);
    await uploadFileToRepo(repoFullName, 'Dockerfile', dockerfileContent, commitMessage, branch, installationToken);
    await uploadFileToRepo(repoFullName, '.dockerignore', dockerIgnoreContent, commitMessage, branch, installationToken);

    console.log('[GitHub App] ── Workflow Injection Complete ────────────\n');
}
