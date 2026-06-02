FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

# Copy source files and the trained ONNX model
COPY . .

EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
