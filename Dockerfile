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

# Applies to every `node <file>.js` invocation of this image, not just src/index.js's default CMD
# below -- k8s Jobs/CronJobs override the container command to run bot files directly
# (e.g. `node src/bots/draft_sync.js`), bypassing index.js entirely. Bootstrapping OTel here
# instead of via a per-file require() means every entrypoint gets tracing automatically, with
# nothing to remember to wire up when a new one is added. Also applies to ad-hoc
# `docker exec ... node ...` debugging sessions in the running container.
ENV NODE_OPTIONS="--require /app/src/telemetry/init.js"

CMD ["node", "src/index.js"]
