# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer cache: only re-runs when package files change)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Build the Angular app
COPY . .
RUN npm run build -- --configuration production

# ─── Stage 2: Serve ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf

# Angular 17+ outputs to dist/<project>/browser/
COPY --from=builder /app/dist/backoffice/browser /usr/share/nginx/html

# Non-root: nginx worker runs as nginx user by default in the alpine image
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/health || exit 1
