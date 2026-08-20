FROM node:20-bookworm-slim

# Install system dependencies needed for Playwright headless browser rendering, plus (additive,
# opt-in) xvfb/x11vnc/novnc/websockify for WORKER-11's remote-login Job (scripts/start-vnc.sh) —
# only that Job's container command starts any of these; src/index.js's default CMD below never
# touches them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    x11-utils \
    && rm -rf /var/lib/apt/lists/*

# OpenBao CLI — needed so remote_login.js can `bao login -method=kubernetes` + `bao kv put` the
# captured session state in-cluster (see docs/espn-reverse-engineering.md and the WORKER-11
# companion fantasy-infra issue for the auth-method/role/policy prerequisite this depends on).
# auth.js's existing OpenBao reads (local dev only, via scripts/openbao-connect.sh) never needed
# this in the image before, since they run on the developer's own machine, not in-cluster.
ARG OPENBAO_VERSION=2.6.2
RUN ARCH="$(dpkg --print-architecture)" \
    && wget -q "https://github.com/openbao/openbao/releases/download/v${OPENBAO_VERSION}/openbao_${OPENBAO_VERSION}_linux_${ARCH}.deb" -O /tmp/bao.deb \
    && dpkg -i /tmp/bao.deb \
    && rm /tmp/bao.deb

WORKDIR /app

COPY package*.json ./
RUN npm ci

# --with-deps also apt-get installs Chromium's OS-level shared library dependencies (glib, nss,
# etc.) for the detected distro — without it, the binary downloads fine but fails to launch at
# runtime with "error while loading shared libraries: libglib-2.0.so.0: ...".
RUN npx playwright install --with-deps chromium

COPY . .
RUN chmod +x scripts/start-vnc.sh

# Applies to every `node <file>.js` invocation of this image, not just src/index.js's default CMD
# below -- k8s Jobs/CronJobs override the container command to run bot files directly
# (e.g. `node src/bots/draft_sync.js`), bypassing index.js entirely. Bootstrapping OTel here
# instead of via a per-file require() means every entrypoint gets tracing automatically, with
# nothing to remember to wire up when a new one is added. Also applies to ad-hoc
# `docker exec ... node ...` debugging sessions in the running container.
ENV NODE_OPTIONS="--require /app/src/telemetry/init.js"

CMD ["node", "src/index.js"]
