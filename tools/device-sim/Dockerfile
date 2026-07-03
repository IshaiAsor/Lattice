FROM node:22-slim
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY tools/device-sim tools/device-sim

RUN npm ci

WORKDIR /workspace/tools/device-sim
ENTRYPOINT ["node", "index.js"]
