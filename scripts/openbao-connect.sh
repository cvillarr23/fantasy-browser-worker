#!/usr/bin/env bash
# Port-forwards the in-cluster OpenBao (homelab-deployment/apps/openbao/) to localhost and
# authenticates the local `bao` CLI via Google OIDC, so ESPN_S2/SWID can be pulled straight from
# vault by auth.js's resolveEspnCookies() fallback instead of logging into ESPN by hand every run
# (see src/bots/auth.js, src/bots/draft_recon.js).
#
# All progress/status output goes to stderr; the ONLY thing printed to stdout is the one env-var
# assignment the calling shell needs, in that shell's own syntax — so this is meant to be run via
# command substitution + eval, not sourced (this is a bash script; a plain `source` from a fish
# shell won't work, since fish doesn't execute bash syntax):
#
#   fish:      eval (scripts/openbao-connect.sh)
#   bash/zsh:  eval "$(scripts/openbao-connect.sh)"
#
# What it does:
#   1. Starts `kubectl port-forward -n openbao svc/openbao-active 8200:8200` in the background,
#      detached so it survives after this script returns (skipped if 8200 is already reachable).
#      PID recorded in /tmp/openbao-port-forward.pid; stop it later with:
#        kill "$(cat /tmp/openbao-port-forward.pid)"
#   2. Checks `bao token lookup` first — if the cached token (~/.vault-token, from a prior OIDC
#      login) is still valid, reuses it and skips straight to step 3. Otherwise runs
#      `bao login -method=oidc role=admin` (opens a browser — log in with the Google account
#      allowlisted by homelab-deployment's scripts/openbao-oidc-setup.sh); `bao` caches the new
#      token to ~/.vault-token itself, honoring whatever TTL OIDC issues it with (observed: 1h) —
#      no token handling needed here beyond checking whether it's still within that TTL.
#   3. Prints the BAO_ADDR assignment for your shell to stdout.
#
# Prerequisite this does NOT set up: CLI OIDC login needs a localhost callback
# (http://localhost:8250/oidc/callback) registered as an allowed redirect URI, both on the OpenBao
# "admin" role (homelab-deployment's openbao-oidc-setup.sh only registered the browser/UI callback,
# not this one) and on the Google OAuth client itself (console.cloud.google.com/apis/credentials).
# If login fails with a redirect_uri mismatch, that's the fix needed, not something this script can
# do on its own — the role side can be patched with the cluster root token the same way
# openbao-oidc-setup.sh writes it; the Google Cloud Console side is a manual step.
set -uo pipefail # no -e: errors here shouldn't kill an interactive shell via eval

NAMESPACE="openbao"
SERVICE="svc/openbao-active"
LOCAL_PORT="8200"
PID_FILE="/tmp/openbao-port-forward.pid"
BAO_ADDR="http://127.0.0.1:${LOCAL_PORT}"

if curl -s -o /dev/null "${BAO_ADDR}/v1/sys/health"; then
  echo "==> Port ${LOCAL_PORT} already reachable, reusing existing port-forward." >&2
else
  echo "==> Starting port-forward to ${SERVICE} in namespace ${NAMESPACE}..." >&2
  kubectl port-forward -n "$NAMESPACE" "$SERVICE" "${LOCAL_PORT}:8200" \
    >/tmp/openbao-port-forward.log 2>&1 &
  echo $! >"$PID_FILE"
  disown

  ready=0
  for _ in $(seq 1 20); do
    if curl -s -o /dev/null "${BAO_ADDR}/v1/sys/health"; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    echo "==> Port-forward did not come up — check /tmp/openbao-port-forward.log" >&2
    exit 1
  fi
fi

# Reuse the cached token (~/.vault-token) if bao token lookup says it's still valid, rather than
# forcing a fresh browser OIDC login on every invocation of this script.
EXISTING_TTL="$(BAO_ADDR="$BAO_ADDR" bao token lookup -format=json 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin)["data"]["ttl"])
except Exception:
    print(0)
' 2>/dev/null)"
EXISTING_TTL="${EXISTING_TTL:-0}"

if [ "$EXISTING_TTL" -gt 30 ] 2>/dev/null; then
  echo "==> Reusing cached OpenBao token (${EXISTING_TTL}s left before it expires)." >&2
else
  echo "==> No valid cached token — logging in via Google OIDC (a browser window should open)..." >&2
  if ! BAO_ADDR="$BAO_ADDR" bao login -method=oidc role=admin >&2; then
    echo "==> OIDC login failed — see this script's header comment for the CLI redirect_uri prerequisite." >&2
    exit 1
  fi
fi

echo "==> Logged in. BAO_ADDR=${BAO_ADDR}" >&2

if [ "$(basename "${SHELL:-}")" = "fish" ]; then
  echo "set -gx BAO_ADDR ${BAO_ADDR}"
else
  echo "export BAO_ADDR=${BAO_ADDR}"
fi
