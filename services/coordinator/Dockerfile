# Multi-stage build for coordinator service
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
COPY shared/security/ ./shared/security/

# Copy this service
COPY services/coordinator/ ./services/coordinator/

# Install all dependencies including devDependencies for build
RUN npm ci --workspaces --include-workspace-root

# Build shared packages in dependency order
RUN npm run build --workspace=shared/types
RUN npm run build --workspace=shared/config
RUN npm run build --workspace=shared/core
RUN npm run build --workspace=shared/security

# Build the service
RUN npm run build --workspace=services/coordinator

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
COPY --from=builder /app/shared/security/dist/ ./shared/security/dist/
COPY --from=builder /app/shared/security/package.json ./shared/security/

# Copy built service (dist only)
COPY --from=builder /app/services/coordinator/dist/ ./services/coordinator/dist/
COPY --from=builder /app/services/coordinator/package.json ./services/coordinator/

# Install production dependencies only
RUN npm ci --workspaces --include-workspace-root --omit=dev

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S coordinator -u 1001 -G nodejs

RUN chown -R coordinator:nodejs /app
USER coordinator

EXPOSE 3000

# Set working directory to the service
WORKDIR /app/services/coordinator

## SA-1Q-008 FIX: Use wget instead of curl — node:22-alpine includes wget but not curl
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

# RT-3P-001: --max-old-space-size=192 reduces major GC pressure (15.8% major GC ratio at default)
CMD ["node", "--max-old-space-size=192", "dist/index.js"]
