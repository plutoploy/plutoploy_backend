// Prints each user's saved installationId — confirm the /setup write without SQL.
// Usage: pnpm db:check   (optionally: pnpm db:check <login>)
import { prisma } from '../backend/src/db/database.ts';

const login = process.argv[2];
const users = await prisma.user.findMany({
    where: login ? { login } : undefined,
    select: { id: true, login: true, installationId: true },
    orderBy: { id: 'asc' },
});

if (users.length === 0) {
    console.log(login ? `No user "${login}"` : 'No users yet.');
} else {
    console.table(users.map(u => ({ ...u, installationId: u.installationId ?? '—' })));
}

await prisma.$disconnect();
