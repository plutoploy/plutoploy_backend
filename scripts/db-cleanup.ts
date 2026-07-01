/**
 * DB Cleanup — remove stale/orphaned data
 *
 * Usage:
 *   pnpm db:cleanup                 # dry-run (shows what would be deleted)
 *   pnpm db:cleanup --confirm       # actually delete
 */
import { prisma } from '../backend/src/db/database.ts';

const dryRun = !process.argv.includes('--confirm');

if (dryRun) {
    console.log('=== DRY RUN (pass --confirm to execute) ===\n');
}

// 1. Failed/stuck builds older than 24h
const staleBuildsDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
const staleBuilds = await prisma.build.findMany({
    where: {
        status: { in: ['queued', 'in_progress'] },
        createdAt: { lt: staleBuildsDate },
    },
});
console.log(`Stale builds (queued/in_progress > 24h): ${staleBuilds.length}`);
for (const b of staleBuilds) {
    console.log(`  ${b.id} | ${b.repo} | ${b.status} | ${b.createdAt.toISOString()}`);
}

if (!dryRun && staleBuilds.length > 0) {
    await prisma.build.updateMany({
        where: { id: { in: staleBuilds.map(b => b.id) } },
        data: { status: 'timeout' },
    });
    console.log(`  → Marked ${staleBuilds.length} builds as 'timeout'\n`);
}

// 2. Orphaned routes — routes with no matching deployment
const allRoutes = await prisma.route.findMany();
const allDeployments = await prisma.deployment.findMany({ select: { subdomain: true } });
const deployedDomains = new Set(
    allDeployments.map(d => `${d.subdomain}.${process.env.DOMAIN || 'yourdomain.com'}`)
);
const orphanedRoutes = allRoutes.filter(r => !deployedDomains.has(r.domain));
console.log(`\nOrphaned routes (no matching deployment): ${orphanedRoutes.length}`);
for (const r of orphanedRoutes) {
    console.log(`  ${r.domain} → ${r.host}:${r.port}`);
}

if (!dryRun && orphanedRoutes.length > 0) {
    for (const r of orphanedRoutes) {
        await prisma.route.delete({ where: { domain: r.domain } }).catch(() => null);
    }
    console.log(`  → Deleted ${orphanedRoutes.length} orphaned routes\n`);
}

// 3. Failed deployments older than 7 days
const oldFailedDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const oldFailed = await prisma.deployment.findMany({
    where: {
        status: { in: ['failed', 'stopped'] },
        createdAt: { lt: oldFailedDate },
    },
});
console.log(`\nOld failed/stopped deployments (> 7d): ${oldFailed.length}`);
for (const d of oldFailed) {
    console.log(`  ${d.id} | ${d.subdomain} | ${d.status} | ${d.createdAt.toISOString()}`);
}

if (!dryRun && oldFailed.length > 0) {
    await prisma.deployment.deleteMany({
        where: { id: { in: oldFailed.map(d => d.id) } },
    });
    console.log(`  → Deleted ${oldFailed.length} old deployments\n`);
}

console.log('\nDone.');
await prisma.$disconnect();
