# Build from the repository root:  docker build -f apps/admin/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
# The API address and the photo origin are built into the dashboard, so they are build arguments.
ARG API_INTERNAL_URL=http://api:4400
ARG PHOTO_ORIGIN=""
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=""
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=""
ENV API_INTERNAL_URL=$API_INTERNAL_URL \
    PHOTO_ORIGIN=$PHOTO_ORIGIN \
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY \
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=$NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID \
    GEOATTEND_RELEASE=true \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @geoattend/admin --include-workspace-root --ignore-scripts
COPY packages/shared packages/shared
COPY apps/admin apps/admin
RUN npm run build -w @geoattend/admin

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
RUN useradd --system --uid 10001 geoattend && chown -R geoattend /app
USER geoattend
WORKDIR /app/apps/admin
EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://localhost:3400/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "--port", "3400"]
