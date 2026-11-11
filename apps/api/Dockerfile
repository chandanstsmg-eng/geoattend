# Build from the repository root:  docker build -f apps/api/Dockerfile .
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# pg_dump and pg_restore for db:backup, db:backup:production and db:restore. They must be at least the
# server's major version (PostgreSQL 17 in docker-compose.yml): Debian bookworm's own client is 15, and
# pg_dump 15 refuses to dump a 17 server. So the client comes from the PostgreSQL project's repository.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @geoattend/api --include-workspace-root --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN useradd --system --uid 10001 geoattend && chown -R geoattend /app
USER geoattend
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://localhost:4400/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node directly, not npx, so stop signals reach the server and it can shut down cleanly.
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
