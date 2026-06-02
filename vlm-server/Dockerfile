FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

# Copy source files and the trained ONNX model
COPY . .

EXPOSE 3000

# Run via ts-node (mirrors npm start) — node:22-slim ships with glibc which
# is required by the native binaries in onnxruntime-node and sharp.
CMD ["node", "--loader", "ts-node/esm", "server.ts"]
