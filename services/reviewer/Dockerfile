FROM oven/bun:1.2-slim AS base

WORKDIR /app

# Dependency install — cached unless package.json/bun.lock changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source.
COPY src ./src
COPY tsconfig.json ./

# Railway provides PORT; we default to 3000 for local.
ENV PORT=3000
EXPOSE 3000

# Bun runs TypeScript directly; no separate build step needed.
CMD ["bun", "run", "src/server.ts"]
