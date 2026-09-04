# Keep the Node LTS patch and Debian suite explicit; review both during routine image updates.
ARG NODE_VERSION=22.19.0

FROM node:${NODE_VERSION}-bookworm-slim AS base

ENV NODE_ENV=production
WORKDIR /app

# PGDG publishes PostgreSQL 16 for both amd64 and arm64. The signed repository
# metadata selects the package matching the build platform automatically.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gpg; \
    install -d -m 0755 /usr/share/postgresql-common/pgdg; \
    curl --fail --show-error --silent https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssl postgresql-client-16; \
    test -x /usr/lib/postgresql/16/bin/pg_dump; \
    test -x /usr/lib/postgresql/16/bin/pg_restore; \
    apt-get purge -y --auto-remove curl gpg; \
    rm -rf /var/lib/apt/lists/*

FROM base AS dependencies

ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY src ./src
RUN ./node_modules/.bin/prisma generate --schema=prisma/schema.prisma \
    && npm run build

FROM base AS production-dependencies

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./

RUN install -d -o node -g node -m 0700 /var/lib/mercado-artesanal/backups \
    && chown -R node:node /app

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

FROM base AS migration

ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma/schema.prisma ./prisma/schema.prisma
COPY --chown=node:node prisma/migrations ./prisma/migrations

USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"]
