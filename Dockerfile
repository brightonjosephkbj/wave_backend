# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

# System deps: ffmpeg (for merging), python3 + pip (for yt-dlp), curl
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (latest stable)
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp

# Copy app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Create tmp dir
RUN mkdir -p /app/tmp && chmod 777 /app/tmp

# Non-root user for security
RUN useradd -m wave && chown -R wave:wave /app
USER wave

EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
