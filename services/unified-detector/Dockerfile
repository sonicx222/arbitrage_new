# Unified Detector Service Dockerfile
# Multi-stage build for optimized image size

FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY tsconfig*.json ./

# Copy shared packages
COPY shared/ ./shared/

# Copy service files
COPY services/unified-detector/ ./services/unified-detector/

# Install dependencies
RUN npm install

# Build shared packages first
WORKDIR /app/shared/types
RUN npm run build || true

WORKDIR /app/shared/config
RUN npm run build || true

WORKDIR /app/shared/core
RUN npm run build || true

# Build service
WORKDIR /app/services/unified-detector
RUN npm run build

# Production image
FROM node:20-alpine AS production

WORKDIR /app

# Copy built files
COPY --from=builder /app/services/unified-detector/dist ./dist
COPY --from=builder /app/services/unified-detector/package*.json ./
COPY --from=builder /app/shared ./shared

# Install production dependencies only
RUN npm install --production

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Start service
CMD ["node", "dist/index.js"]
