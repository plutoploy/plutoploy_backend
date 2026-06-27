import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 requires a driver adapter; pg connects via DATABASE_URL.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });

console.log('✅ Prisma client initialized (PostgreSQL)');

// Deployment operations
export const deploymentDb = {
    create: (deployment: {
        deployId: string;
        subdomain: string;
        port: number;
        imageName: string;
        containerId: string;
        repo?: string;
        login?: string;
    }) =>
        prisma.deployment.create({
            data: {
                id: deployment.deployId,
                subdomain: deployment.subdomain,
                port: deployment.port,
                imageName: deployment.imageName,
                containerId: deployment.containerId,
                repo: deployment.repo ?? null,
                login: deployment.login ?? null,
                status: 'running',
            },
        }),

    getById: (deployId: string) =>
        prisma.deployment.findUnique({ where: { id: deployId } }),

    getBySubdomain: (subdomain: string) =>
        prisma.deployment.findUnique({ where: { subdomain } }),

    getAll: () =>
        prisma.deployment.findMany({ orderBy: { createdAt: 'desc' } }),

    getByLogin: (login: string) =>
        prisma.deployment.findMany({ where: { login }, orderBy: { createdAt: 'desc' } }),

    updateStatus: (deployId: string, status: string) =>
        prisma.deployment.update({ where: { id: deployId }, data: { status } }),

    delete: (deployId: string) =>
        prisma.deployment.delete({ where: { id: deployId } }),

    getUsedPorts: async (): Promise<number[]> => {
        const rows = await prisma.deployment.findMany({
            select: { port: true },
            orderBy: { port: 'asc' },
        });
        return rows.map((r) => r.port);
    },

    subdomainExists: async (subdomain: string): Promise<boolean> =>
        (await prisma.deployment.count({ where: { subdomain } })) > 0,
};

// Builds operations
export const buildsDb = {
    create: (build: { id: string; repo: string; branch: string; subdomain?: string }) =>
        prisma.build.create({
            data: {
                id: build.id,
                repo: build.repo,
                branch: build.branch,
                subdomain: build.subdomain ?? null,
                status: 'queued',
            },
        }),

    getById: (id: string) => prisma.build.findUnique({ where: { id } }),

    getLatestByRepo: (repo: string) =>
        prisma.build.findFirst({ where: { repo }, orderBy: { createdAt: 'desc' } }),

    updateState: (id: string, status: string, githubRunId?: string) =>
        prisma.build.update({
            where: { id },
            data: { status, ...(githubRunId ? { githubRunId } : {}) },
        }),
};

// Caddy routes operations
export const routesDb = {
    upsert: (domain: string, host: string, port: number) =>
        prisma.route.upsert({
            where: { domain },
            create: { domain, host, port },
            update: { host, port },
        }),

    getByDomain: (domain: string) =>
        prisma.route.findUnique({ where: { domain } }),

    getAll: () => prisma.route.findMany({ orderBy: { domain: 'asc' } }),

    delete: (domain: string) =>
        prisma.route.delete({ where: { domain } }).catch(() => null), // tolerate missing row
};

// Auth / User operations
export const authDb = {
    upsertUser: (user: {
        githubId: string;
        login: string;
        name?: string | null;
        email?: string | null;
        avatarUrl?: string | null;
        accessToken?: string;
        installationId?: string | null;
    }) => {
        const data = {
            login: user.login,
            name: user.name ?? null,
            email: user.email ?? null,
            avatarUrl: user.avatarUrl ?? null,
            accessToken: user.accessToken ?? null,
            installationId: user.installationId ?? null,
        };
        return prisma.user.upsert({
            where: { githubId: user.githubId },
            create: { githubId: user.githubId, ...data },
            update: data,
        });
    },

    getUserInstallationId: async (userId: number): Promise<string | null> => {
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { installationId: true },
        });
        return row?.installationId ?? null;
    },

    getUserByGithubId: (githubId: string) =>
        prisma.user.findUnique({ where: { githubId } }),

    getUserById: (id: number) => prisma.user.findUnique({ where: { id } }),

    createSession: (userId: number, token: string, expiresAt: string) =>
        prisma.session.create({
            data: { userId, token, expiresAt: new Date(expiresAt) },
        }),

    getSessionUser: async (token: string) => {
        const session = await prisma.session.findUnique({
            where: { token },
            include: { user: true },
        });
        if (!session || session.expiresAt <= new Date()) return undefined;
        return session.user;
    },

    deleteSession: (token: string) =>
        prisma.session.delete({ where: { token } }).catch(() => null),

    deleteAllUserSessions: (userId: number) =>
        prisma.session.deleteMany({ where: { userId } }),

    purgeExpiredSessions: () =>
        prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } }),
};

// Type for returned user rows (Prisma camelCase)
export type UserRow = NonNullable<Awaited<ReturnType<typeof authDb.getUserByGithubId>>>;

// Graceful shutdown
const shutdown = async () => {
    await prisma.$disconnect();
};
process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
});
