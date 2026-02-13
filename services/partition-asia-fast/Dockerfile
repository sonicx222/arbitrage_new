# DEPRECATED: This Dockerfile is ORPHANED and not referenced by any docker-compose file.
# Production deployments use services/unified-detector/Dockerfile for P1-P3 partitions,
# orchestrated via infrastructure/docker/docker-compose.partition.yml.
# This file is retained for reference only and may be removed in a future cleanup.
#
# P1 Asia-Fast Partition Service Dockerfile
# Deployment: Oracle Cloud Singapore (asia-southeast1)
# Chains: BSC, Polygon, Avalanche, Fantom
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
COPY services/partition-asia-fast/ ./services/partition-asia-fast/

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
WORKDIR /app/services/partition-asia-fast
RUN npm run build

# Production image
FROM node:22-alpine AS production

WORKDIR /app

# Copy built files
COPY --from=builder /app/services/partition-asia-fast/dist ./dist
COPY --from=builder /app/services/partition-asia-fast/package*.json ./
COPY --from=builder /app/services/unified-detector/dist ./services/unified-detector/dist
COPY --from=builder /app/services/unified-detector/package*.json ./services/unified-detector/
COPY --from=builder /app/shared ./shared

# Install production dependencies only
RUN npm install --production

# Set P1 partition environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV PARTITION_ID=asia-fast
ENV REGION_ID=asia-southeast1

# P1 partition configuration
# Chains: BSC (56), Polygon (137), Avalanche (43114), Fantom (250)
ENV PARTITION_CHAINS=bsc,polygon,avalanche,fantom

# Health check port
ENV HEALTH_CHECK_PORT=3001

# Health check
# P11-FIX: Check for 200 status (both healthy and degraded return 200)
HEALTHCHECK --interval=15s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Expose health check port
EXPOSE 3001

# Labels for deployment
LABEL maintainer="arbitrage-team"
LABEL service="partition-asia-fast"
LABEL partition.id="asia-fast"
LABEL partition.chains="bsc,polygon,avalanche,fantom"
LABEL partition.region="asia-southeast1"
LABEL partition.provider="oracle"

# Start P1 partition service
CMD ["node", "dist/index.js"]
