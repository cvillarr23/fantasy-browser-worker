#!/bin/sh
# WORKER-11: container entrypoint for the manually-triggered remote-login k8s Job ONLY —
# src/index.js's production CMD never touches this. Starts a virtual X11 display, a real VNC
# server on top of it, and a noVNC web client fronting that VNC server, then hands off to
# remote_login.js with DISPLAY already pointed at that virtual display.
#
# This chain is the load-bearing piece behind WORKER-11: x11vnc injects VNC input at the X11
# level, straight into the X server, indistinguishable to Chromium from a real mouse/keyboard —
# unlike a CDP relay (Page.mouse/keyboard), which is still programmatic input from the browser's
# perspective and was already confirmed blocked by reCAPTCHA Enterprise once (see
# docs/espn-reverse-engineering.md). Do not replace this with anything CDP-based.
#
# -nopw (no VNC password) is deliberate, not an oversight: per issue #24, the Tailscale tailnet
# ingress (homelab-deployment#8) is the intended access boundary, not VNC auth — this port is only
# ever meant to be reached via `kubectl port-forward` or that tailnet-only ingress, never exposed
# more broadly. Set VNC_PASSWORD to opt into `x11vnc -rfbauth` instead if that trust boundary ever
# changes.
set -eu

DISPLAY_NUM="${VNC_DISPLAY:-:99}"
RESOLUTION="${VNC_RESOLUTION:-1280x800x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

cleanup() {
  echo "==> Shutting down Xvfb/x11vnc/websockify..." >&2
  kill "${WEBSOCKIFY_PID:-}" "${X11VNC_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
}
trap cleanup TERM INT

echo "==> Starting Xvfb on ${DISPLAY_NUM} (${RESOLUTION})..." >&2
Xvfb "$DISPLAY_NUM" -screen 0 "$RESOLUTION" -nolisten tcp &
XVFB_PID=$!

# Wait for the X socket before anything tries to attach to it.
ready=0
for _ in $(seq 1 20); do
  if xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "==> Xvfb did not come up on ${DISPLAY_NUM}" >&2
  exit 1
fi

export DISPLAY="$DISPLAY_NUM"

echo "==> Starting x11vnc on port ${VNC_PORT}..." >&2
if [ -n "${VNC_PASSWORD:-}" ]; then
  PASSWD_FILE="$(mktemp)"
  x11vnc -storepasswd "$VNC_PASSWORD" "$PASSWD_FILE"
  x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -forever -shared -rfbauth "$PASSWD_FILE" &
else
  x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -forever -shared -nopw &
fi
X11VNC_PID=$!

echo "==> Starting websockify/noVNC on port ${NOVNC_PORT}..." >&2
websockify --web=/usr/share/novnc/ "$NOVNC_PORT" "localhost:${VNC_PORT}" &
WEBSOCKIFY_PID=$!

echo "==> Ready. noVNC web client on :${NOVNC_PORT}, handing off to remote_login.js..." >&2
exec node src/bots/remote_login.js
