# Monorepo-aware build: ota-manager consumes the @lattice/logger and @lattice/queue workspace
# packages, whose dist/ are build artifacts (not committed), so we build them in a builder stage.
FROM node:20-slim AS builder
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/logger packages/logger
COPY packages/queue packages/queue
COPY services/ota-manager services/ota-manager

RUN npm ci
RUN npm run build -w @lattice/logger \
 && npm run build -w @lattice/queue

FROM node:20-slim
WORKDIR /app

# Preserve the workspace layout so the hoisted node_modules/@lattice/logger symlink
# (→ ../../packages/logger) still resolves, and pino resolves from the root node_modules.
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages ./packages
COPY --from=builder /workspace/services/ota-manager ./services/ota-manager

WORKDIR /app/services/ota-manager
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
