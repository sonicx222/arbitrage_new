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

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["npm", "start"]