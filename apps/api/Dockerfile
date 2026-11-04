# Build from the repository root:  docker build -f apps/api/Dockerfile .
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN npm ci --workspace @geoattend/api --include-workspace-root --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN useradd --system --uid 10001 geoattend && chown -R geoattend /app
USER geoattend
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4400/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/api/src/server.ts"]
