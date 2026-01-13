# P4 Solana-Native Partition Detector Service
# Chain: Solana (non-EVM)
# Region: Fly.io US-West (us-west1)
#
# Solana-Native partition characteristics:
# - Fast health checks (10s) for ~400ms block times
# - Short failover timeout (45s) for quick recovery
# - Heavy resource profile for high-throughput chain
# - Non-EVM: uses program account subscriptions

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./
COPY shared/types/package.json ./shared/types/
COPY shared/config/package.json ./shared/config/
COPY shared/core/package.json ./shared/core/
COPY services/unified-detector/package.json ./services/unified-detector/
COPY services/partition-solana/package.json ./services/partition-solana/

# Install dependencies
RUN npm ci --workspace=services/partition-solana

# Copy source code
COPY shared/types/ ./shared/types/
COPY shared/config/ ./shared/config/
COPY shared/core/ ./shared/core/
COPY services/unified-detector/ ./services/unified-detector/
COPY services/partition-solana/ ./services/partition-solana/
COPY tsconfig*.json ./

# Build
RUN npm run build --workspace=shared/types && \
    npm run build --workspace=shared/config && \
    npm run build --workspace=shared/core && \
    npm run build --workspace=services/unified-detector && \
    npm run build --workspace=services/partition-solana

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/shared/types/package.json ./shared/types/
COPY --from=builder /app/shared/types/dist ./shared/types/dist
COPY --from=builder /app/shared/config/package.json ./shared/config/
COPY --from=builder /app/shared/config/dist ./shared/config/dist
COPY --from=builder /app/shared/core/package.json ./shared/core/
COPY --from=builder /app/shared/core/dist ./shared/core/dist
COPY --from=builder /app/services/unified-detector/package.json ./services/unified-detector/
COPY --from=builder /app/services/unified-detector/dist ./services/unified-detector/dist
COPY --from=builder /app/services/partition-solana/package.json ./services/partition-solana/
COPY --from=builder /app/services/partition-solana/dist ./services/partition-solana/dist

# Install production dependencies only
RUN npm ci --omit=dev --workspace=services/partition-solana

# Set working directory to service
WORKDIR /app/services/partition-solana

# P4 partition configuration
# Chain: Solana (non-EVM, uses program account subscriptions)
ENV PARTITION_CHAINS=solana

# Health check port (different from P1: 3001, P2: 3002, P3: 3003)
ENV HEALTH_CHECK_PORT=3004

# Health check - fast interval for Solana's ~400ms blocks
# P11-FIX: Check for 200 status (both healthy and degraded return 200)
HEALTHCHECK --interval=10s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3004/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Expose health check port
EXPOSE 3004

LABEL maintainer="arbitrage-team"
LABEL service="partition-solana"
LABEL partition.id="solana-native"
LABEL partition.chains="solana"
LABEL partition.region="us-west1"
LABEL partition.provider="fly"
LABEL partition.evm="false"

# Start P4 partition service
CMD ["node", "dist/index.js"]
