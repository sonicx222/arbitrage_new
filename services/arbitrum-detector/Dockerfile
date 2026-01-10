FROM node:18-alpine

# Install dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY . .

# Build TypeScript
RUN npm run build

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S arbitrumdetector -u 1001

# Change ownership
RUN chown -R arbitrumdetector:nodejs /app
USER arbitrumdetector

# Expose health check port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

# Start application
CMD ["npm", "start"]