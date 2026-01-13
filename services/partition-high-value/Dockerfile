# P3 High-Value Partition Detector Service
# Chains: Ethereum, zkSync, Linea
# Region: Oracle Cloud US-East (us-east1)
#
# High-Value partition characteristics:
# - Longer health checks (30s) for Ethereum's ~12s blocks
# - Standard failover timeout (60s) for mainnet stability
# - Heavy resource profile for Ethereum mainnet processing

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./
COPY shared/types/package.json ./shared/types/
COPY shared/config/package.json ./shared/config/
COPY shared/core/package.json ./shared/core/
COPY services/unified-detector/package.json ./services/unified-detector/
COPY services/partition-high-value/package.json ./services/partition-high-value/

# Install dependencies
RUN npm ci --workspace=services/partition-high-value

# Copy source code
COPY shared/types/ ./shared/types/
COPY shared/config/ ./shared/config/
COPY shared/core/ ./shared/core/
COPY services/unified-detector/ ./services/unified-detector/
COPY services/partition-high-value/ ./services/partition-high-value/
COPY tsconfig*.json ./

# Build
RUN npm run build --workspace=shared/types && \
    npm run build --workspace=shared/config && \
    npm run build --workspace=shared/core && \
    npm run build --workspace=services/unified-detector && \
    npm run build --workspace=services/partition-high-value

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
COPY --from=builder /app/services/partition-high-value/package.json ./services/partition-high-value/
COPY --from=builder /app/services/partition-high-value/dist ./services/partition-high-value/dist

# Install production dependencies only
RUN npm ci --omit=dev --workspace=services/partition-high-value

# Set working directory to service
WORKDIR /app/services/partition-high-value

# P3 partition configuration
# Chains: Ethereum (1), zkSync (324), Linea (59144)
ENV PARTITION_CHAINS=ethereum,zksync,linea

# Health check port (different from P1: 3001, P2: 3002)
ENV HEALTH_CHECK_PORT=3003

# Health check - longer interval for Ethereum's ~12s blocks
# P11-FIX: Check for 200 status (both healthy and degraded return 200)
HEALTHCHECK --interval=30s --timeout=15s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3003/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Expose health check port
EXPOSE 3003

LABEL maintainer="arbitrage-team"
LABEL service="partition-high-value"
LABEL partition.id="high-value"
LABEL partition.chains="ethereum,zksync,linea"
LABEL partition.region="us-east1"
LABEL partition.provider="oracle"

# Start P3 partition service
CMD ["node", "dist/index.js"]
