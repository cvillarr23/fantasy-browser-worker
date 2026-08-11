const fs = require("fs");

const SERVICE_ACCOUNT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const OPENBAO_ADDR = process.env.OPENBAO_ADDR || "http://openbao.openbao.svc.cluster.local:8200";
// Matches the `kubernetes` auth mount already enabled cluster-wide for ESO's own read-only role
// (homelab-deployment: scripts/openbao-init.sh) — this module authenticates the same way, just
// under a different, write-scoped role so callers here can write secrets, not just read them.
const KUBERNETES_AUTH_MOUNT = process.env.OPENBAO_K8S_AUTH_MOUNT || "kubernetes";
const KV_MOUNT = process.env.OPENBAO_KV_MOUNT || "secret";

/**
 * Exchanges this pod's own projected ServiceAccount token for a short-lived OpenBao client token,
 * via OpenBao's Kubernetes auth method. `role` must be bound (in OpenBao) to this pod's
 * ServiceAccount name/namespace — see homelab-deployment's openbao-init-espn-refresher.sh.
 */
async function kubernetesLogin(role) {
  const jwt = fs.readFileSync(SERVICE_ACCOUNT_TOKEN_PATH, "utf8").trim();

  const response = await fetch(`${OPENBAO_ADDR}/v1/auth/${KUBERNETES_AUTH_MOUNT}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, jwt }),
  });

  if (!response.ok) {
    throw new Error(`OpenBao kubernetes auth login failed: HTTP ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.auth.client_token;
}

/** Reads a KV v2 secret's current data (the {key: value} map, not the full metadata envelope). */
async function readSecret(token, path) {
  const response = await fetch(`${OPENBAO_ADDR}/v1/${KV_MOUNT}/data/${path}`, {
    headers: { "X-Vault-Token": token },
  });

  if (!response.ok) {
    throw new Error(`OpenBao read of ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.data.data;
}

/** Writes (fully replaces) a KV v2 secret's data. */
async function writeSecret(token, path, data) {
  const response = await fetch(`${OPENBAO_ADDR}/v1/${KV_MOUNT}/data/${path}`, {
    method: "POST",
    headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });

  if (!response.ok) {
    throw new Error(`OpenBao write of ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }
}

module.exports = { kubernetesLogin, readSecret, writeSecret };
