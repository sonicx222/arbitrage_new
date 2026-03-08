# CD-008 FIX: Multi-stage build — keeps build toolchain out of production image.
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S nodejs
RUN adduser -S executionengine -u 1001
RUN chown -R executionengine:nodejs /app
USER executionengine

EXPOSE 3005

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:${HEALTH_CHECK_PORT:-3005}/health || exit 1

CMD ["node", "--max-old-space-size=192", "dist/index.js"]
