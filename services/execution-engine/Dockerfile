# Multi-stage build for execution-engine service
# Builds from monorepo root to include workspace dependencies

# Stage 1: Build (needs devDependencies for TypeScript)
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root package files for workspace setup
COPY package*.json ./
COPY tsconfig.json ./

# Copy shared packages that this service depends on
COPY shared/types/ ./shared/types/
COPY shared/config/ ./shared/config/
COPY shared/core/ ./shared/core/
COPY shared/metrics/ ./shared/metrics/

# Copy this service
COPY services/execution-engine/ ./services/execution-engine/

# Install all dependencies including devDependencies for build
RUN npm ci --workspaces --include-workspace-root

# Build shared packages in dependency order
RUN npm run build --workspace=shared/types
RUN npm run build --workspace=shared/config
RUN npm run build --workspace=shared/metrics
RUN npm run build --workspace=shared/core

# Build the service
RUN npm run build --workspace=services/execution-engine

# Stage 2: Production image (only runtime dependencies)
FROM node:22-alpine AS production

WORKDIR /app

# Copy root package files for workspace setup
COPY package*.json ./
COPY --from=builder /app/tsconfig.json ./

# Copy built shared packages (dist only)
COPY --from=builder /app/shared/types/dist/ ./shared/types/dist/
COPY --from=builder /app/shared/types/package.json ./shared/types/
COPY --from=builder /app/shared/config/dist/ ./shared/config/dist/
COPY --from=builder /app/shared/config/package.json ./shared/config/
COPY --from=builder /app/shared/core/dist/ ./shared/core/dist/
COPY --from=builder /app/shared/core/package.json ./shared/core/
COPY --from=builder /app/shared/metrics/dist/ ./shared/metrics/dist/
COPY --from=builder /app/shared/metrics/package.json ./shared/metrics/

# Copy built service (dist only)
COPY --from=builder /app/services/execution-engine/dist/ ./services/execution-engine/dist/
COPY --from=builder /app/services/execution-engine/package.json ./services/execution-engine/

# Install production dependencies only
RUN npm ci --workspaces --include-workspace-root --omit=dev

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S executionengine -u 1001 -G nodejs

RUN chown -R executionengine:nodejs /app
USER executionengine

EXPOSE 3005

# Set working directory to the service
WORKDIR /app/services/execution-engine

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:${HEALTH_CHECK_PORT:-3005}/health || exit 1

CMD ["node", "--max-old-space-size=192", "dist/index.js"]
