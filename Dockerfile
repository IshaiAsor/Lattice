# ==========================================
# STAGE 0: Base with common settings
# ==========================================
FROM node:bookworm-slim AS base
WORKDIR /app
# Install essentials if needed (none for now)

# ==========================================
# STAGE 1: Build the Angular UI
# ==========================================
FROM base AS ui-build
WORKDIR /app/backoffice
COPY backoffice/package*.json ./
# Cache dependencies
RUN npm install
# Copy source and build
COPY backoffice/ ./
RUN npm run build --configuration=production

# ==========================================
# STAGE 2: Build the Node.js Backend
# ==========================================
FROM base AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
# Cache dependencies
RUN npm install
# Copy source and build
COPY backend/ ./
RUN npm run build
# Keep only production dependencies
RUN npm prune --production

# ==========================================
# STAGE 3: Final Production Image
# ==========================================
FROM node:bookworm-slim
WORKDIR /app/backend

# Create a non-root user for security (optional but recommended)
# RUN useradd -m myuser && chown -R myuser /app
# USER myuser

# Copy built backend
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/package*.json ./

# Copy built UI directly into dist/public
COPY --from=ui-build /app/backoffice/dist/backoffice ./dist/public

EXPOSE 3000
CMD ["node", "dist/index.js"]
