FROM node:22-slim

# Prisma's query engine needs openssl on debian-slim.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ponytail: node_modules (and the already-generated Prisma client) are built on
# the HOST and copied in, because the build sandbox's route to npmjs.org is
# unusably slow (~18 KiB/s). The Prisma client is engine-less (@prisma/adapter-pg),
# so it's pure JS and safe to copy across machines.
# Upgrade path: once the builder network is fixed (or via a registry mirror),
# go back to `COPY package.json pnpm-lock.yaml ./ && pnpm install --frozen-lockfile`
# for a reproducible, host-independent build.
COPY . .

# Client is already generated on the host (node_modules/.prisma) and copied in,
# so no `prisma generate` here — that keeps the build fully offline.
# ponytail: invoke node/prisma directly, NOT via pnpm. pnpm v11 verifies node_modules
# against its store before running and — because node_modules is COPIED from the host —
# decides it's foreign, tries to purge+reinstall, and dies (no network). The start
# script is just a node call, so pnpm buys us nothing here.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node --env-file=.env --import tsx/esm index.ts"]
