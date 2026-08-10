# Copilot instructions for fantasy-browser-worker

Headless Playwright/Node worker that consumes RabbitMQ messages from `fantasy-core-pipeline` and drives automated actions against the ESPN fantasy football UI.

## System architecture

This is one of three repos that make up the platform:
- **`fantasy-core-pipeline`**: the brain. A FastAPI gateway + Python ingestion/optimization scripts that decide *what* to do (e.g. "add this player, drop that one") and publish that decision as a message on RabbitMQ (`lineup_updates`, `waiver_actions` queues).
- **`fantasy-browser-worker`** (this repo): the hands. Consumes those messages and drives Playwright against the real ESPN UI to actually execute the action. The queue names and JSON payload field names this repo reads (`payload.player_id`, etc.) are a contract owned by `fantasy-core-pipeline` — if a field this code expects doesn't line up with what that repo publishes, that's a cross-repo bug, not something fixable here alone.
- **`fantasy-infra`**: the plumbing. Kustomize manifests (synced by Argo CD) that deploy this worker as a KEDA-scaled job and provision the shared RabbitMQ instance it connects to.

## Stack conventions

- `src/queue/connection.js` owns the single AMQP connection/channel: `prefetch(1)` (one job at a time, since each job spins up a Chromium instance), manual acks (`noAck: false`) — ack only after the handler resolves, `nack(msg, false, true)` (requeue) on handler failure. Any new consumer should follow this same ack-after-success discipline.
- `src/index.js`'s `handleIncomingMessage` is the single dispatch point from queue name to bot module. New queues/bots should be wired there, not consumed ad hoc elsewhere.
- `src/bots/*.js` are the actual browser automations; `src/bots/auth.js` builds the authenticated Playwright context (ESPN session cookies from `ESPN_S2`/`SWID` env vars) that bots reuse — don't duplicate browser-launch/cookie logic in individual bots.
- `src/selectors/espn_selectors.json` centralizes DOM selectors so bots don't hardcode CSS/XPath inline — new bot code should read from there.
- Message payload shapes are defined on the `fantasy-core-pipeline` side (`waiver_actions`, `lineup_updates` queues) — when reviewing a bot's payload field access (`payload.player_id`, etc.), check it actually matches what that producer publishes, not just what looks plausible.

## Things to double-check in review

- Variable name typos in credential/cookie-handling code are easy to miss and fail silently or dangerously (e.g. a stray/undefined variable name that happens to coincide with another name in scope) — read cookie/env-var plumbing character-by-character rather than skimming.
- `package.json` declares `lint`/`format` scripts (`eslint`, `prettier`) but there's no committed `.eslintrc`/`.prettierrc` in this repo yet — don't assume CI or a local `npm run lint` is actually enforcing style ahead of review.
- Browser resource cleanup: every bot that opens a `browser`/`context` needs to close it in a `finally` (see `waiver_sniper.js`) — flag any new bot that can leak a Chromium process on an error path.
- This worker processes one job at a time by design (`prefetch(1)`) to protect a constrained pod memory limit — don't suggest concurrency/parallelism changes without also addressing that constraint.
