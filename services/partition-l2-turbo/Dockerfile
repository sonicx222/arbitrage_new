# DEPRECATED: This Dockerfile is ORPHANED and not referenced by any docker-compose file.
# Production deployments use services/unified-detector/Dockerfile for P1-P3 partitions,
# orchestrated via infrastructure/docker/docker-compose.partition.yml.
# This file is retained for reference only and may be removed in a future cleanup.
#
# P2 L2-Turbo Partition Service Dockerfile
# Deployment: Fly.io Singapore (asia-southeast1)
# Chains: Arbitrum, Optimism, Base
#
# Multi-stage build for optimized image size

FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY tsconfig*.json ./

# Copy shared packages
COPY shared/ ./shared/

# Copy unified-detector (dependency)
COPY services/unified-detector/ ./services/unified-detector/

# Copy partition service files
COPY services/partition-l2-turbo/ ./services/partition-l2-turbo/

# Install dependencies
RUN npm install

# Build shared packages in dependency order (fail fast on build errors)
# Note: Proper build order is types -> config -> core -> unified-detector -> partition
WORKDIR /app/shared/types
RUN npm run build

WORKDIR /app/shared/config
RUN npm run build

WORKDIR /app/shared/core
RUN npm run build

# Build unified-detector (dependency)
WORKDIR /app/services/unified-detector
RUN npm run build

# Build partition service
WORKDIR /app/services/partition-l2-turbo
RUN npm run build

# Production image
FROM node:22-alpine AS production

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/services/partition-l2-turbo/dist ./dist
COPY --from=builder /app/services/partition-l2-turbo/package*.json ./
COPY --from=builder /app/services/unified-detector/dist ./services/unified-detector/dist
COPY --from=builder /app/services/unified-detector/package*.json ./services/unified-detector/
COPY --from=builder /app/shared/types/package.json ./shared/types/
COPY --from=builder /app/shared/types/dist ./shared/types/dist
COPY --from=builder /app/shared/config/package.json ./shared/config/
COPY --from=builder /app/shared/config/dist ./shared/config/dist
COPY --from=builder /app/shared/core/package.json ./shared/core/
COPY --from=builder /app/shared/core/dist ./shared/core/dist

# Install production dependencies only
RUN npm install --production

# =====================================================================
# P2 L2-Turbo Partition Environment Variables
# =====================================================================
# REQUIRED AT RUNTIME (set via Fly.io secrets or deployment config):
#   - REDIS_URL: Redis connection string
#   - ARBITRUM_WS_URL: WebSocket URL for Arbitrum (Alchemy/Infura/QuickNode)
#   - OPTIMISM_WS_URL: WebSocket URL for Optimism
#   - BASE_WS_URL: WebSocket URL for Base
#
# L2 chains have ~250ms blocks; WebSocket connections are critical for
# real-time price feeds required for competitive arbitrage trading.
# =====================================================================

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV PARTITION_ID=l2-turbo
ENV REGION_ID=asia-southeast1

# Chains: Arbitrum (42161), Optimism (10), Base (8453)
ENV PARTITION_CHAINS=arbitrum,optimism,base

# Health check port (P1: 3001, P2: 3002, P3: 3003, P4: 3004)
ENV HEALTH_CHECK_PORT=3002

# Health check - faster interval for L2 chains
# P11-FIX: Check for 200 status (both healthy and degraded return 200)
HEALTHCHECK --interval=10s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Expose health check port
EXPOSE 3002

# Labels for deployment
LABEL maintainer="arbitrage-team"
LABEL service="partition-l2-turbo"
LABEL partition.id="l2-turbo"
LABEL partition.chains="arbitrum,optimism,base"
LABEL partition.region="asia-southeast1"
LABEL partition.provider="fly"

# Start P2 partition service
# FIX #4: --unhandled-rejections=throw converts unhandled rejections to uncaught exceptions,
# which trigger graceful shutdown via the existing uncaughtException handler.
# This prevents zombie state where the service appears healthy but has lost functionality.
CMD ["node", "--unhandled-rejections=throw", "dist/index.js"]
