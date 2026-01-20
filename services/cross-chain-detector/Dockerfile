# Multi-stage build for cross-chain-detector service
# FIX 3.2: Build from monorepo root to include workspace dependencies

# Stage 1: Build the application (needs devDependencies for TypeScript)
FROM node:18-alpine AS builder

WORKDIR /app

# Copy root package files for workspace setup
COPY package*.json ./
COPY tsconfig.json ./

# Copy shared packages that this service depends on
COPY shared/types/ ./shared/types/
COPY shared/config/ ./shared/config/
COPY shared/core/ ./shared/core/
COPY shared/ml/ ./shared/ml/

# Copy this service
COPY services/cross-chain-detector/ ./services/cross-chain-detector/

# Install all dependencies including devDependencies for build
# Using --workspaces to handle monorepo structure
RUN npm ci --workspaces --include-workspace-root

# Build shared packages first (in dependency order)
RUN npm run build --workspace=shared/types
RUN npm run build --workspace=shared/config
RUN npm run build --workspace=shared/core
RUN npm run build --workspace=shared/ml

# Build the service
RUN npm run build --workspace=services/cross-chain-detector

# Stage 2: Production image (only runtime dependencies)
FROM node:18-alpine AS production

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
COPY --from=builder /app/shared/ml/dist/ ./shared/ml/dist/
COPY --from=builder /app/shared/ml/package.json ./shared/ml/

# Copy built service (dist only)
COPY --from=builder /app/services/cross-chain-detector/dist/ ./services/cross-chain-detector/dist/
COPY --from=builder /app/services/cross-chain-detector/package.json ./services/cross-chain-detector/

# Install production dependencies only
RUN npm ci --workspaces --include-workspace-root --omit=dev

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S crosschaindetector -u 1001 -G nodejs

RUN chown -R crosschaindetector:nodejs /app
USER crosschaindetector

EXPOSE 3004

# Set working directory to the service
WORKDIR /app/services/cross-chain-detector

# FIX 3.1: Health check port now configurable via HEALTH_CHECK_PORT env var
# Override with: docker run -e HEALTH_CHECK_PORT=3005
# The health check script reads the environment variable at runtime
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "const port = process.env.HEALTH_CHECK_PORT || process.env.CROSS_CHAIN_DETECTOR_PORT || '3004'; require('http').get('http://localhost:' + port + '/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
