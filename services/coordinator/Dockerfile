FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN npm run build

RUN addgroup -g 1001 -S nodejs
RUN adduser -S coordinator -u 1001

RUN chown -R coordinator:nodejs /app
USER coordinator

EXPOSE 3000

## SA-1Q-008 FIX: Use wget instead of curl — node:22-alpine includes wget but not curl
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

# RT-3P-001: --max-old-space-size=192 reduces major GC pressure (15.8% major GC ratio at default)
CMD ["node", "--max-old-space-size=192", "dist/index.js"]