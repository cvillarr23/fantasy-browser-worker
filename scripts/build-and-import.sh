#!/usr/bin/env bash
# Builds the worker image and imports it into the cluster's containerd for local testing.
#
# This does its work over SSH on the actual k8s node (cvill-server / `server` in ~/.ssh/config) —
# NOT on this desktop. Docker networking on this desktop is broken (unrelated veth/bridge issue),
# and more fundamentally, this desktop was never the right place to build from: it only has remote
# kubectl access to the cluster, it isn't a node. See scripts/remote-build-and-import.sh, which
# does the actual build/import work over there.
#
# Requires:
#   - SSH access to the node (Host "server" in ~/.ssh/config, or override NODE via env)
#   - Passwordless sudo for /usr/bin/ctr on the node (see fantasy-browser-worker README/PR notes
#     for the one-time `/etc/sudoers.d/ctr-nopasswd` setup) — docker.service itself may still need
#     an interactive sudo the first time if it's not already enabled+running on the node.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

NODE="${NODE:-server}"
REMOTE_DIR="${REMOTE_DIR:-~/fantasy-browser-worker}"

echo "==> Syncing repo to ${NODE}:${REMOTE_DIR}..."
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude recon-output \
  ./ "${NODE}:${REMOTE_DIR}/"

echo "==> Running remote build/import on ${NODE}..."
# -t allocates a pty so sudo can prompt interactively if docker.service isn't already running
# (harmless once it's enabled — subsequent runs won't need a password for that step).
ssh -t "${NODE}" "cd ${REMOTE_DIR} && bash scripts/remote-build-and-import.sh"
