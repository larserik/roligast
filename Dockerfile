# Build stage: has a compiler and Python so native modules (better-sqlite3) can
# be built from source when a prebuilt binary cannot be downloaded.
FROM node:22-slim AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Runtime stage: slim image without the build tools.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV DATABASE_PATH=/data/roligast.db \
    PORT=3000

EXPOSE 3000
CMD ["node", "src/server.js"]
