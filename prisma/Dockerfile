FROM node:22-alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . ./prisma/

RUN mkdir -p /app/backend/node_modules

CMD ["sh", "-c", "cd /app/prisma && export PATH=/app/node_modules/.bin:$PATH && prisma migrate deploy && prisma db seed"]
