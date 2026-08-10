FROM node:20-bookworm-slim

# Install system dependencies needed for Playwright headless browser rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Explicitly install only the Chromium browser binary required for the engine
RUN npx playwright install chromium

COPY . .

CMD ["node", "src/index.js"]
