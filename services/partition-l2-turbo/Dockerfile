# P2 L2-Turbo Partition Service Dockerfile
# Deployment: Fly.io Singapore (asia-southeast1)
# Chains: Arbitrum, Optimism, Base
#
# Multi-stage build for optimized image size

FROM node:20-alpine AS builder

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

# Build shared packages first
WORKDIR /app/shared/types
RUN npm run build || true

WORKDIR /app/shared/config
RUN npm run build || true

WORKDIR /app/shared/core
RUN npm run build || true

# Build unified-detector (dependency)
WORKDIR /app/services/unified-detector
RUN npm run build || true

# Build partition service
WORKDIR /app/services/partition-l2-turbo
RUN npm run build

# Production image
FROM node:20-alpine AS production

WORKDIR /app

# Copy built files
COPY --from=builder /app/services/partition-l2-turbo/dist ./dist
COPY --from=builder /app/services/partition-l2-turbo/package*.json ./
COPY --from=builder /app/services/unified-detector/dist ./services/unified-detector/dist
COPY --from=builder /app/services/unified-detector/package*.json ./services/unified-detector/
COPY --from=builder /app/shared ./shared

# Install production dependencies only
RUN npm install --production

# Set P2 partition environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV PARTITION_ID=l2-turbo
ENV REGION_ID=asia-southeast1

# P2 partition configuration
# Chains: Arbitrum (42161), Optimism (10), Base (8453)
ENV PARTITION_CHAINS=arbitrum,optimism,base

# Health check port (different from P1)
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
CMD ["node", "dist/index.js"]
