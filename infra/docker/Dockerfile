# Shared base: Node + pnpm
FROM node:22-alpine AS base

RUN npm install -g pnpm@10.13.1

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# Build stage: full dependencies, compile TypeScript to dist/
FROM base AS builder

# --ignore-scripts skips the husky "prepare" hook, which has no place in an image.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
COPY src ./src

RUN pnpm build

# Production dependencies only
FROM base AS prod-deps

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Runtime stage
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=4000

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# Migrations are applied by scripts/migrate.mjs at deploy time.
COPY --chown=node:node drizzle/migrations ./drizzle/migrations
COPY --chown=node:node scripts/migrate.mjs ./scripts/migrate.mjs

USER node

EXPOSE 4000

CMD ["node", "dist/index.js"]
