# Next.js production Dockerfile for Coolify deployment
# Build context must be the repo root (not apps/web/)
FROM node:22-alpine AS base
RUN npm install -g pnpm@9

# Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --no-frozen-lockfile

# Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-workspace.yaml ./
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

# Production — standalone output only, no pnpm or node_modules copy needed
FROM node:22-alpine AS runner
RUN apk add --no-cache wget
WORKDIR /app

# Standalone bundle (includes its own minimal node_modules + server.js)
COPY --from=builder /app/apps/web/.next/standalone ./
# Static assets and public dir are not included in standalone — copy separately
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
# Issue worker script (not part of Next.js build output)
COPY --from=builder /app/apps/web/scripts ./apps/web/scripts
# Entrypoint
COPY --from=builder /app/apps/web/docker-entrypoint.sh ./apps/web/docker-entrypoint.sh
RUN chmod +x /app/apps/web/docker-entrypoint.sh

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/health || exit 1

CMD ["/app/apps/web/docker-entrypoint.sh"]
