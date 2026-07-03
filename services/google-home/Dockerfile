FROM node:22-slim AS builder
WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/logger        packages/logger
COPY packages/otel          packages/otel
COPY packages/jwt           packages/jwt
COPY packages/queue         packages/queue
COPY packages/prisma-client packages/prisma-client
COPY packages/capability-validation packages/capability-validation
COPY services/google-home   services/google-home
COPY prisma                 prisma
COPY tsconfig.base.json ./

RUN npm ci
RUN npm run build -w @lattice/otel \
 && npm run build -w @lattice/logger \
 && npm run build -w @lattice/jwt \
 && npm run build -w @lattice/queue \
 && npm run build -w @lattice/prisma-client \
 && npm run build -w @lattice/capability-validation \
 && npm run build -w @lattice/google-home

FROM node:22-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/node_modules ./node_modules
RUN rm -rf node_modules/@lattice
COPY --from=builder /workspace/packages/logger/package.json  ./node_modules/@lattice/logger/package.json
COPY --from=builder /workspace/packages/logger/dist          ./node_modules/@lattice/logger/dist
COPY --from=builder /workspace/packages/logger/node_modules  ./node_modules/@lattice/logger/node_modules
COPY --from=builder /workspace/packages/otel/package.json    ./node_modules/@lattice/otel/package.json
COPY --from=builder /workspace/packages/otel/dist            ./node_modules/@lattice/otel/dist
COPY --from=builder /workspace/packages/otel/node_modules    ./node_modules/@lattice/otel/node_modules
COPY --from=builder /workspace/packages/jwt/package.json     ./node_modules/@lattice/jwt/package.json
COPY --from=builder /workspace/packages/jwt/dist             ./node_modules/@lattice/jwt/dist
COPY --from=builder /workspace/packages/jwt/node_modules     ./node_modules/@lattice/jwt/node_modules
COPY --from=builder /workspace/packages/queue/package.json   ./node_modules/@lattice/queue/package.json
COPY --from=builder /workspace/packages/queue/dist           ./node_modules/@lattice/queue/dist
COPY --from=builder /workspace/packages/queue/node_modules   ./node_modules/@lattice/queue/node_modules
COPY --from=builder /workspace/packages/prisma-client/package.json  ./node_modules/@lattice/prisma-client/package.json
COPY --from=builder /workspace/packages/prisma-client/dist          ./node_modules/@lattice/prisma-client/dist
COPY --from=builder /workspace/packages/prisma-client/node_modules  ./node_modules/@lattice/prisma-client/node_modules
COPY --from=builder /workspace/packages/capability-validation/package.json ./node_modules/@lattice/capability-validation/package.json
COPY --from=builder /workspace/packages/capability-validation/dist         ./node_modules/@lattice/capability-validation/dist

COPY --from=builder /workspace/services/google-home/dist ./dist

ENV NODE_ENV=production
EXPOSE 3010
CMD ["node", "dist/index.js"]
