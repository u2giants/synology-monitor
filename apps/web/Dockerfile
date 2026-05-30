# Next.js production Dockerfile for Coolify deployment
# Build context must be the repo root (not apps/web/)
FROM node:22-alpine AS base
RUN npm install -g pnpm@9

# Dependencies
FROM base AS deps
WORKDIR /app
COPY .npmrc package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --no-frozen-lockfile

# Build
FROM base AS builder
WORKDIR /app
# With node-linker=hoisted, deps live flat in the root node_modules and
# packages/shared has no node_modules of its own — copy the root store plus the
# workspace-link node_modules under apps/web.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY .npmrc package.json pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY turbo.json ./

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG BUILD_SHA
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV BUILD_SHA=$BUILD_SHA

WORKDIR /app/apps/web
RUN npx next build

# Production
FROM node:22-alpine AS runner
RUN npm install -g pnpm@9
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/web ./apps/web
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE 3000
WORKDIR /app/apps/web
RUN chmod +x /app/apps/web/docker-entrypoint.sh
CMD ["/app/apps/web/docker-entrypoint.sh"]
