/**
 * Auth Middleware — JWT-based (stateless)
 * Verifies a signed JWT from Authorization header, cookie, or ?token= query param.
 * JWT payload: { sub: userId, login: githubLogin, iat, exp }
 */

import type { Context, MiddlewareHandler } from 'hono';
import jwt from 'jsonwebtoken';

export type JwtPayload = {
    sub: number;   // user.id
    login: string; // github username
};

export type AuthEnv = {
    Variables: {
        user: JwtPayload;
    };
};

const JWT_SECRET = process.env.JWT_SECRET || 'changeme-set-JWT_SECRET-in-env';

export function signToken(payload: JwtPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

export function extractToken(c: Context): string | null {
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim();

    const cookieHeader = c.req.header('Cookie') ?? '';
    const match = cookieHeader.match(/(?:^|;\s*)session_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]!);

    const queryToken = c.req.query('token');
    if (queryToken) return queryToken;

    return null;
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const token = extractToken(c as unknown as Context);
    if (!token) return c.json({ error: 'Unauthorized — no token provided' }, 401);

    try {
        const payload = jwt.verify(token, JWT_SECRET) as unknown as JwtPayload;
        c.set('user', payload);
        await next();
    } catch {
        return c.json({ error: 'Unauthorized — invalid or expired token' }, 401);
    }
};

export const optionalAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const token = extractToken(c as unknown as Context);
    if (token) {
        try {
            const payload = jwt.verify(token, JWT_SECRET) as unknown as JwtPayload;
            c.set('user', payload);
        } catch { /* no-op */ }
    }
    await next();
};
