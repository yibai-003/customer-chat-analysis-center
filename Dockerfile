# syntax=docker/dockerfile:1

FROM node:22.23.2-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json vite.config.ts ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY scripts/check-installation.mjs ./scripts/check-installation.mjs
RUN npm run build

FROM node:22.23.2-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.23.2-bookworm-slim AS runtime
ARG APP_VERSION=0.1.0
ARG APP_COMMIT_SHA=development
ARG APP_BUILD_TIME=development
ARG APP_IMAGE=development
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/app.db
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT_SHA=${APP_COMMIT_SHA} \
    APP_BUILD_TIME=${APP_BUILD_TIME} \
    APP_IMAGE=${APP_IMAGE}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json .npmrc tsconfig.json ./
COPY --from=build /app/dist ./dist
COPY src ./src
COPY config ./config
COPY knowledge ./knowledge
RUN mkdir -p /app/data && chown -R node:node /app/data /app/knowledge
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/server/launcher.ts"]
