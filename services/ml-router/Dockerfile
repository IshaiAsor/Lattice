FROM node:20-alpine AS builder
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages/logger packages/logger
COPY packages/otel   packages/otel
COPY packages/queue  packages/queue
COPY services/ml-router services/ml-router
COPY tsconfig.base.json ./

RUN npm ci
RUN npm run build -w @lattice/logger \
 && npm run build -w @lattice/otel \
 && npm run build -w @lattice/queue \
 && npm run build -w @lattice/ml-router

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /workspace/node_modules ./node_modules
# npm workspace packages land as symlinks pointing at /workspace/packages/* which
# doesn't exist in this stage. Remove them and copy the real built directories.
RUN rm -rf node_modules/@lattice
COPY --from=builder /workspace/packages/logger/package.json ./node_modules/@lattice/logger/package.json
COPY --from=builder /workspace/packages/logger/dist         ./node_modules/@lattice/logger/dist
COPY --from=builder /workspace/packages/otel/package.json   ./node_modules/@lattice/otel/package.json
COPY --from=builder /workspace/packages/otel/dist           ./node_modules/@lattice/otel/dist
COPY --from=builder /workspace/packages/queue/package.json  ./node_modules/@lattice/queue/package.json
COPY --from=builder /workspace/packages/queue/dist          ./node_modules/@lattice/queue/dist

COPY --from=builder /workspace/services/ml-router/dist ./dist
COPY --from=builder /workspace/services/ml-router/models.json ./models.json

ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "dist/index.js"]
