import { defineConfig, env } from 'prisma/config';

// ponytail: native Node 22 .env loader — no `dotenv` dependency. Already-set vars
// (DATABASE_URL from docker-compose) are NOT overwritten; ignore a missing .env
// (prod sets env directly).
try { process.loadEnvFile('.env'); } catch {}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env("DATABASE_URL") || process.env.DATABASE_URL,  
  },
});
