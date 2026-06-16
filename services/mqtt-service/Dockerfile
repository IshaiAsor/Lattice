FROM node:22-alpine AS builder
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages/logger  packages/logger
COPY packages/otel    packages/otel
COPY packages/queue   packages/queue
COPY services/mqtt-service services/mqtt-service
COPY tsconfig.base.json ./

RUN npm ci
RUN npm run build -w @lattice/logger \
 && npm run build -w @lattice/otel \
 && npm run build -w @lattice/queue \
 && npm run build -w @lattice/mqtt-service

FROM node:22-slim
WORKDIR /app

COPY --from=builder /workspace/node_modules ./node_modules
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

COPY --from=builder /workspace/services/mqtt-service/dist ./dist

ENV NODE_ENV=production
EXPOSE 3005
CMD ["node", "dist/index.js"]
