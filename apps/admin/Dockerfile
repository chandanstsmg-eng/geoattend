# Build from the repository root:  docker build -f apps/admin/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=""
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=""
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY \
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=$NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
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
EXPOSE 3400
CMD ["npm", "run", "start", "-w", "@geoattend/admin"]
