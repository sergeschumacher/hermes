# Build stage - includes dev dependencies for building CSS
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev for tailwindcss)
RUN npm ci

# Copy application files
COPY . .

# Build Tailwind CSS
RUN npm run build:css

# Production stage
FROM node:20-alpine

LABEL maintainer="Hermes"
LABEL description="IPTV Media Manager"

# Install runtime dependencies (ffmpeg needed for transcoding)
RUN apk add --no-cache python3 py3-setuptools make g++ sqlite ffmpeg

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application files from builder (includes built CSS)
COPY --from=builder /app/web/static/css/output.css ./web/static/css/output.css
COPY . .

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
