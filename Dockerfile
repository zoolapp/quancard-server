# syntax=docker/dockerfile:1.7
# QuanCard self-hosted server: one image serving the API and the static web client.

FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
ARG QC_VERSION=0.1.0
ENV QC_VERSION=${QC_VERSION}
RUN pnpm --filter @quancard/protocol build \
 && pnpm --filter @quancard/server build \
 && pnpm --filter @quancard/web build \
 && pnpm --filter @quancard/server deploy --prod --legacy /out \
 && rm -rf /out/src /out/test /out/tsconfig*.json

FROM node:26-alpine
ARG QC_VERSION=0.1.0
LABEL org.opencontainers.image.title="quancard-server" \
      org.opencontainers.image.description="Zero-knowledge self-hosted vault and sync server for QuanCard" \
      org.opencontainers.image.source="https://github.com/zoolapp/quancard-server" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${QC_VERSION}"
RUN addgroup -S -g 10001 quancard && adduser -S -D -H -u 10001 -G quancard quancard \
 && mkdir -p /data && chown quancard:quancard /data && chmod 700 /data
WORKDIR /app
COPY --from=build --chown=root:root /out /app
COPY --from=build --chown=root:root /src/apps/web/dist /app/web
ENV NODE_ENV=production \
    QC_DATA_DIR=/data \
    QC_WEB_ROOT=/app/web \
    QC_PORT=8080 \
    QC_VERSION=${QC_VERSION} \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
