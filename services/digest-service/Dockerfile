FROM node:22-slim AS builder
WORKDIR /workspace

# Prisma v7 needs openssl present to fetch/run the query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/logger        packages/logger
COPY packages/otel          packages/otel
COPY packages/queue         packages/queue
COPY packages/prisma-client packages/prisma-client
COPY packages/ml            packages/ml
COPY packages/ioredis       packages/ioredis
COPY services/digest-service services/digest-service
# Root schema is the single source of truth; prisma-client's prepare step reads it.
COPY prisma prisma
COPY tsconfig.base.json ./

RUN npm ci
RUN npm run build -w @lattice/logger \
 && npm run build -w @lattice/otel \
 && npm run build -w @lattice/queue \
 && npm run build -w @lattice/prisma-client \
 && npm run build -w @lattice/ml \
 && npm run build -w @lattice/ioredis \
 && npm run build -w @lattice/digest-service

FROM node:22-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/node_modules ./node_modules
# npm workspace packages land as symlinks pointing at /workspace/packages/* which
# doesn't exist in this stage. Remove them and copy the real built directories.
RUN rm -rf node_modules/@lattice
COPY --from=builder /workspace/packages/logger/package.json  ./node_modules/@lattice/logger/package.json
COPY --from=builder /workspace/packages/logger/dist          ./node_modules/@lattice/logger/dist
COPY --from=builder /workspace/packages/logger/node_modules  ./node_modules/@lattice/logger/node_modules
COPY --from=builder /workspace/packages/otel/package.json    ./node_modules/@lattice/otel/package.json
COPY --from=builder /workspace/packages/otel/dist            ./node_modules/@lattice/otel/dist
COPY --from=builder /workspace/packages/otel/node_modules    ./node_modules/@lattice/otel/node_modules
COPY --from=builder /workspace/packages/queue/package.json   ./node_modules/@lattice/queue/package.json
COPY --from=builder /workspace/packages/queue/dist           ./node_modules/@lattice/queue/dist
COPY --from=builder /workspace/packages/queue/node_modules   ./node_modules/@lattice/queue/node_modules
COPY --from=builder /workspace/packages/prisma-client/package.json  ./node_modules/@lattice/prisma-client/package.json
COPY --from=builder /workspace/packages/prisma-client/dist          ./node_modules/@lattice/prisma-client/dist
# Includes the generated .prisma/client (query engine + client) the package resolves.
COPY --from=builder /workspace/packages/prisma-client/node_modules  ./node_modules/@lattice/prisma-client/node_modules
COPY --from=builder /workspace/packages/ml/package.json             ./node_modules/@lattice/ml/package.json
COPY --from=builder /workspace/packages/ml/dist                     ./node_modules/@lattice/ml/dist
COPY --from=builder /workspace/packages/ioredis/package.json        ./node_modules/@lattice/ioredis/package.json
COPY --from=builder /workspace/packages/ioredis/dist                ./node_modules/@lattice/ioredis/dist

COPY --from=builder /workspace/services/digest-service/dist ./dist

ENV NODE_ENV=production
EXPOSE 3006
CMD ["node", "dist/index.js"]
