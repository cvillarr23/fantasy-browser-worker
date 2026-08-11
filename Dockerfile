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

# --with-deps also apt-get installs Chromium's OS-level shared library dependencies (glib, nss,
# etc.) for the detected distro — without it, the binary downloads fine but fails to launch at
# runtime with "error while loading shared libraries: libglib-2.0.so.0: ...".
RUN npx playwright install --with-deps chromium

COPY . .

CMD ["node", "src/index.js"]
