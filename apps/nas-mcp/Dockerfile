# NAS MCP server — exposes NAS diagnostic tools over Streamable HTTP.
# Build context is the REPO ROOT (not apps/nas-mcp): the tool catalog is the
# single source in packages/shared, reached via the src/nas-tools.ts symlink, so
# the build must see packages/shared. tsc resolves the symlink in place
# (preserveSymlinks) and emits dist/nas-tools.js, keeping dist/index.js intact.
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/nas-mcp/package.json ./apps/nas-mcp/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @synology-monitor/nas-mcp...
COPY apps/nas-mcp/tsconfig.json ./apps/nas-mcp/tsconfig.json
COPY apps/nas-mcp/src/ ./apps/nas-mcp/src/
# Shared tool catalog (single source) — the symlink apps/nas-mcp/src/nas-tools.ts
# points at ../../../packages/shared/src/nas-tools.ts, so it must exist here.
COPY packages/shared/src/ /app/packages/shared/src/
RUN pnpm --filter @synology-monitor/nas-mcp run build

FROM node:22-alpine AS runner
WORKDIR /app/apps/nas-mcp
RUN apk add --no-cache curl
COPY --from=builder /app/apps/nas-mcp/dist ./dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/nas-mcp/node_modules ./node_modules
# tools-config.json is copied at build time.
# To change which tools are enabled: edit the file, push to GitHub,
# and Coolify will automatically rebuild and redeploy this container.
COPY apps/nas-mcp/tools-config.json .
EXPOSE 3001
CMD ["node", "dist/index.js"]
