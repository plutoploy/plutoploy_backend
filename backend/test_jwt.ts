/**
 * Minimal self-check for the JWT auth path. Run: npx tsx backend/test_jwt.ts
 * ponytail: one check on the security path — sign→verify roundtrip + tamper reject.
 */
import assert from 'node:assert';
process.env.JWT_SECRET = 'test-secret';
const { signToken } = await import('./src/middleware/auth.middleware.ts');
const jwt = (await import('jsonwebtoken')).default;

const token = signToken({ sub: 42, login: 'octocat' });

// roundtrip: payload survives
const decoded = jwt.verify(token, 'test-secret') as any;
assert.equal(decoded.sub, 42);
assert.equal(decoded.login, 'octocat');

// wrong secret is rejected
assert.throws(() => jwt.verify(token, 'wrong-secret'));

// tampered token is rejected
assert.throws(() => jwt.verify(token.slice(0, -2) + 'xx', 'test-secret'));

console.log('✅ JWT auth path OK');
