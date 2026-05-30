# NAS MCP server — exposes NAS diagnostic tools to AI agents via MCP over SSE.
# Build context is the REPO ROOT (not apps/nas-mcp): the tool catalog is the
# single source in packages/shared, reached via the src/nas-tools.ts symlink, so
# the build must see packages/shared. tsc resolves the symlink in place
# (preserveSymlinks) and emits dist/nas-tools.js, keeping dist/index.js intact.
FROM node:22-alpine AS builder
WORKDIR /app/apps/nas-mcp
COPY apps/nas-mcp/package.json .
RUN npm install
COPY apps/nas-mcp/tsconfig.json .
COPY apps/nas-mcp/src/ ./src/
# Shared tool catalog (single source) — the symlink apps/nas-mcp/src/nas-tools.ts
# points at ../../../packages/shared/src/nas-tools.ts, so it must exist here.
COPY packages/shared/src/ /app/packages/shared/src/
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app/apps/nas-mcp
COPY --from=builder /app/apps/nas-mcp/dist ./dist
COPY --from=builder /app/apps/nas-mcp/node_modules ./node_modules
# tools-config.json is copied at build time.
# To change which tools are enabled: edit the file, push to GitHub,
# and Coolify will automatically rebuild and redeploy this container.
COPY apps/nas-mcp/tools-config.json .
EXPOSE 3001
CMD ["node", "dist/index.js"]
