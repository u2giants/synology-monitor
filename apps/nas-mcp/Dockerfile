# NAS MCP server — exposes NAS diagnostic tools to AI agents via MCP over SSE
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json .
RUN npm install
COPY tsconfig.json .
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
# tools-config.json is copied at build time.
# To change which tools are enabled: edit the file, push to GitHub,
# and Coolify will automatically rebuild and redeploy this container.
COPY tools-config.json .
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "dist/index.js"]
