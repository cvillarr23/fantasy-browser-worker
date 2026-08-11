#!/usr/bin/env bash
# Runs ON the k8s node itself (cvill-server) — not meant to be run from your desktop directly.
# See build-and-import.sh, which rsyncs the repo here and invokes this over SSH.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE_TAG="fantasy-browser-worker:test"
# The k8s snap (Canonical's `k8s` snap, classic confinement) runs its own containerd instance,
# separate from the system default at /run/containerd/containerd.sock — confirmed via `ps aux`.
CONTAINERD_SOCK="/var/snap/k8s/common/k8s-containerd/k8s-containerd/run/containerd/containerd.sock"
CTR="sudo /usr/bin/ctr --address ${CONTAINERD_SOCK}"

if ! systemctl is-active --quiet docker; then
  echo "==> docker.service is down, starting it (one-time interactive sudo if not already enabled)..."
  sudo systemctl enable --now docker
fi

echo "==> Building ${IMAGE_TAG}..."
docker build -t "${IMAGE_TAG}" .

echo "==> Importing ${IMAGE_TAG} into the k8s snap's containerd (namespace k8s.io)..."
docker save "${IMAGE_TAG}" | ${CTR} -n k8s.io images import -

# `ctr images import` from a docker-archive commonly normalizes a bare "name:tag" into a fully
# qualified "docker.io/library/name:tag" reference. imagePullPolicy: Never needs an exact string
# match against what's already present, so alias it back to the bare tag the Job manifest uses.
IMPORTED_REF=$(${CTR} -n k8s.io images list -q | grep -E "(^|/)${IMAGE_TAG}\$" | head -1 || true)
if [ -n "${IMPORTED_REF}" ] && [ "${IMPORTED_REF}" != "${IMAGE_TAG}" ]; then
  echo "==> Aliasing ${IMPORTED_REF} -> ${IMAGE_TAG}"
  ${CTR} -n k8s.io images tag "${IMPORTED_REF}" "${IMAGE_TAG}"
fi

echo "==> Images matching fantasy-browser-worker in containerd:"
${CTR} -n k8s.io images list | grep fantasy-browser-worker || echo "  (none found — import may have failed)"

echo "==> Done. ${IMAGE_TAG} should now be available to the cluster with imagePullPolicy: Never."
