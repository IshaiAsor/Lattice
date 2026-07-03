# ─── Stage 1: Build (development config) ─────────────────────────────────────
# Used only by compose.test.yaml — bakes in environment.development.ts's localhost:* URLs
# (see fileReplacements in angular.json) instead of production's subdomain-derivation scheme,
# so the built bundle can talk to the integration-test stack's host-published ports.
FROM node:20-alpine AS builder-test

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build -- --configuration development

# ─── Stage 2: Serve (development config) ─────────────────────────────────────
FROM nginx:1.27-alpine AS runtime-test

RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder-test /app/dist/backoffice /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/health || exit 1

# ─── Stage 3: Build (production config) ──────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer cache: only re-runs when package files change)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Build the Angular app
COPY . .
RUN npm run build -- --configuration production

# ─── Stage 4: Serve (production config) ──────────────────────────────────────
# Production/staging default target. Kept LAST so a plain `docker build` (no --target)
# produces the prod bundle, not the localhost-hardcoded test bundle above.
FROM nginx:1.27-alpine AS runtime

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist/backoffice /usr/share/nginx/html

# Non-root: nginx worker runs as nginx user by default in the alpine image
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/health || exit 1
