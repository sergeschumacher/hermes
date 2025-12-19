FROM node:20-alpine

LABEL maintainer="Hermes"
LABEL description="IPTV Media Manager"

# Install build dependencies and runtime tools
RUN apk add --no-cache python3 make g++ sqlite ffmpeg

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build step)
RUN npm ci

# Copy application files
COPY . .

# Build Tailwind CSS
RUN npm run build:css

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create data directory
RUN mkdir -p /data/config /data/cache /data/temp /data/downloads

# Set environment variables
ENV NODE_ENV=production
ENV DATA_PATH=/data

# Expose port
EXPOSE 3000

# Volume for persistent data
VOLUME ["/data", "/downloads", "/temp"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "index.js"]
