/**
 * DB Reset — wipe all data from all tables (DESTRUCTIVE)
 *
 * Usage:
 *   pnpm db:reset                   # shows warning, does nothing
 *   pnpm db:reset --confirm         # actually wipes all data
 */
import { prisma } from '../backend/src/db/database.ts';

const confirmed = process.argv.includes('--confirm');

if (!confirmed) {
    console.log('⚠️  This will DELETE ALL DATA from all tables.');
    console.log('   Pass --confirm to proceed.\n');
    console.log('   Usage: pnpm db:reset --confirm');
    await prisma.$disconnect();
    process.exit(0);
}

console.log('Wiping all data...\n');

// Order matters — delete dependents first
const builds = await prisma.build.deleteMany();
console.log(`Builds deleted: ${builds.count}`);

const deployments = await prisma.deployment.deleteMany();
console.log(`Deployments deleted: ${deployments.count}`);

const routes = await prisma.route.deleteMany();
console.log(`Routes deleted: ${routes.count}`);

const users = await prisma.user.deleteMany();
console.log(`Users deleted: ${users.count}`);

console.log('\nAll tables wiped.');
await prisma.$disconnect();
