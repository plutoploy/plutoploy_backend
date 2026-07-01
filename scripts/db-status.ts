/**
 * DB Status — overview of all tables and their row counts + recent entries
 *
 * Usage: pnpm db:status
 */
import { prisma } from '../backend/src/db/database.ts';

console.log('=== Plutoploy DB Status ===\n');

// Users
const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
console.log(`Users: ${users.length}`);
console.table(users.map(u => ({
    id: u.id,
    login: u.login,
    email: u.email ?? '—',
    installationId: u.installationId ?? '—',
    created: u.createdAt.toISOString().slice(0, 10),
})));

// Deployments
const deployments = await prisma.deployment.findMany({ orderBy: { createdAt: 'desc' } });
console.log(`\nDeployments: ${deployments.length}`);
console.table(deployments.map(d => ({
    id: d.id.slice(0, 8),
    subdomain: d.subdomain,
    port: d.port,
    image: d.imageName.length > 40 ? d.imageName.slice(0, 40) + '...' : d.imageName,
    status: d.status,
    login: d.login ?? '—',
    created: d.createdAt.toISOString().slice(0, 10),
})));

// Builds
const builds = await prisma.build.findMany({ orderBy: { createdAt: 'desc' } });
console.log(`\nBuilds: ${builds.length}`);
console.table(builds.map(b => ({
    id: b.id.slice(0, 8),
    repo: b.repo,
    branch: b.branch,
    hostPort: b.hostPort ?? '—',
    status: b.status,
    commitSha: b.commitSha ? b.commitSha.slice(0, 7) : '—',
    created: b.createdAt.toISOString().slice(0, 10),
})));

// Routes
const routes = await prisma.route.findMany({ orderBy: { domain: 'asc' } });
console.log(`\nRoutes: ${routes.length}`);
console.table(routes.map(r => ({
    domain: r.domain,
    host: r.host,
    port: r.port,
})));

// Summary
console.log('\n=== Summary ===');
console.log(`Users: ${users.length}`);
console.log(`Deployments: ${deployments.length} (running: ${deployments.filter(d => d.status === 'running').length})`);
console.log(`Builds: ${builds.length} (queued: ${builds.filter(b => b.status === 'queued').length}, success: ${builds.filter(b => b.status === 'success').length}, failure: ${builds.filter(b => b.status === 'failure').length})`);
console.log(`Routes: ${routes.length}`);

await prisma.$disconnect();
