# fantasy-browser-worker

## ESPN draft protocol / auth reverse-engineering

All of it — the `fantasydraft.espn.com` WebSocket protocol, which REST endpoints are reliable vs
not for ephemeral practice drafts, the verified draft-room DOM selectors, and the
cookie-auth-vs-real-login distinction (including why automated login is a dead end, confirmed via
`recaptcha` enterprise blocking it) — is written up in
[`docs/espn-reverse-engineering.md`](docs/espn-reverse-engineering.md). Read that before touching
`draft_room_socket.js`, `draft_room_dom.js`, `draft_recon.js`, or `mock_draft.js` — it'll save
re-discovering things that already cost real live-testing time to pin down.

## WORKER-06: draft pick submission

- `draft_clicker.js`'s primary path (`draft_room_socket.js`, a standalone `ws` sidecar) needs only
  `espn_s2`/`SWID` cookies — no browser page, no real login, unaffected by the auth-surface split
  documented above. `draft_room_dom.js` (the DOM-click fallback tier) does render a page, so it
  *is* affected — see the docs.
- The REST draft-board read (`espn_api.js`'s `readDraftPicks`) is confirmed unreliable for
  ephemeral practice/mock drafts (never reflects picks, even after the draft completes) —
  unverified against a real persisted league draft. `draft_clicker.js`'s idempotency/conflict
  check inherits this limitation; don't trust it blindly until that's verified against a real
  draft.
- A rejected `SELECT` (already-drafted player) comes back as an explicit `ERROR <code> <message>`
  frame, not silence — `draft_clicker.js` treats this as a `PermanentError` specifically so
  `connection.js`'s requeue-on-transient-`Error` behavior (no backoff, channel-wide `prefetch(1)`)
  doesn't retry a doomed pick forever.
- A live league's `draft_sync.js` publisher can be launched automatically by
  `fantasy-core-pipeline`'s `POST /v1/draft/start` (alongside the listener Job it already
  creates), labeled `app=live-draft-sync,league-id=<league>` — mirroring how
  `POST /v1/draft/practice/sync-job` already launches the practice publisher. `POST
  /v1/draft/stop` Foreground-deletes-and-waits that Job the same way it already does for
  practice's connector, so `draft:{league}:picks`/`draft_picks:{league}` clear automatically
  instead of requiring the operator-confirmed `confirm_publisher_stopped=true` stopgap
  (core-pipeline#77/#99) — issue #66. `draft_sync.js` itself needed no change for this: it
  already supports a pure env-var launch (`ESPN_LEAGUE_ID`/`ESPN_TEAM_ID`/`CURRENT_YEAR`) via
  `enterDraftRoom`'s live branch. `k8s/test-draft-sync-job.yaml` remains for manual/dev-only
  testing outside that orchestrated flow — a publisher started that way is unlabeled and
  invisible to `/stop`'s automatic clear, so it still needs `confirm_publisher_stopped=true`.

## WORKER-12: LLM client with cloud-provider fallback + local Ollama last resort

- `src/lib/llm_client.js` exports `completeWithFallback(prompt, opts)`. Transport + fallback +
  rate limiting + instrumentation only — no business logic (trade negotiation, rumor parsing)
  belongs here; that's WORKER-04 (`trade_bot.js`) and WORKER-13 (`rumor_digest_bot.js`) calling
  into this instead.
- Provider chain order/models come from `LLM_PROVIDER_PRIORITY`
  (`provider:model,provider:model,...`), default
  `groq:llama-3.1-70b-versatile,gemini:gemini-1.5-flash,ollama:llama3.1:8b`. API keys resolve
  env-first (`GROQ_API_KEY`, `GEMINI_API_KEY`) then fall back to OpenBao at
  `secret/fantasy/<provider>` (field `<provider>_api_key`) — same env-then-OpenBao shape as
  `auth.js`'s `resolveEspnCookies`. Ollama needs no key; it's an unauthenticated in-cluster
  endpoint (`OLLAMA_URL`, default `http://ollama.default.svc.cluster.local:11434`).
- Deliberately scoped to calling an *already-running* Ollama endpoint. Actually provisioning
  Ollama on-demand (scale a Deployment 0→1 when the 32GB homelab node has room) is cluster
  work that belongs in `fantasy-infra`, not here — a connection failure here just means "treat
  as unavailable, fall through/fail," never "go start a pod."
- Two independent layers decide whether a provider gets tried: a proactive in-memory
  sliding-window rate limiter (`<PROVIDER>_RPM_LIMIT`, process-local, skips a provider before
  spending a real request once its own budget looks exhausted) and reactive fallback (any
  request failure — real 429, quota message in the body, timeout, 5xx — moves to the next
  provider in the chain). `error_type` in the metrics row distinguishes which one fired.
- Every attempt (not just the winner) writes a best-effort row to `llm_call_metrics` via its own
  small pool, mirroring `src/db/execution_log.js`'s never-throws pattern. That table's DDL lives
  in `fantasy-core-pipeline` (`src/models.py`/`src/migrations.py`, Python) — this repo has no
  migrations of its own, same as `execution_log`. CORE-14 (fantasy-core-pipeline#31) is the
  Grafana dashboard that consumes it.
- Throws a plain `Error` (not `PermanentError`) when every provider in the chain is
  skipped/fails — this is a transient/config condition, not a doomed payload, so a
  queue-triggered caller should get `connection.js`'s normal requeue-with-backoff, not a
  permanent drop.

## WORKER-13: rumor/news-driven waiver & lineup signal bot

- `src/bots/rumor_digest_bot.js` exports `runRumorDigest()`. Phase 1 (issue #27) is **advisory
  only** — it reads CORE-13's `raw_signals`, calls WORKER-12's `completeWithFallback` once per
  run, and writes structured verdicts to a new `rumor_signals` table. It never touches
  `waiver_actions`/`lineup_updates` — auto-executing a claim or swap off a rumor signal is #81, a
  separate, currently-blocked follow-up issue, not this one.
- Scheduled-job entrypoint (`require.main === module` + `withInstrumentation`, mirroring
  `check_espn_session.js`), **not** a queue consumer — no change to `src/index.js`'s dispatch map
  or `connection.js`'s `targetQueues`. The production CronJob schedule belongs in `fantasy-infra`
  as its own issue, the same way CORE-13's ingestion CronJob (INFRA-11) was scoped separately
  from CORE-13 itself; `k8s/test-rumor-digest-job.yaml` is manual/dev-only, same convention as
  `k8s/test-lineup-bot-job.yaml`.
- No separate watermark/cursor table. `rumor_signals.max_raw_signal_id` is stamped onto every row
  a run writes (including `no_op` verdicts) with that run's batch-max `raw_signals.id`; the
  digest's watermark is just `MAX(max_raw_signal_id)` across the whole table. This only holds
  because the prompt (`buildDigestSystemPrompt`) requires one verdict per distinct player in the
  batch, even a `no_op` one — if the model ever omits a player, the watermark still advances past
  their raw_signal, but no verdict gets recorded for them until a future run happens to mention
  them again.
- If there are no new `raw_signals` rows since the watermark, the run skips `completeWithFallback`
  entirely and writes nothing — CORE-13's polling interval doesn't always produce fresh rumors,
  and an empty batch shouldn't burn a request against WORKER-12's rate-limited free-tier chain.
- **`rumor_signals.player_id` (and every `player_id` this bot handles) is the internal Sleeper id
  space — the same one `raw_signals.player_id`/`players.player_id` use in
  `fantasy-core-pipeline` — NOT an ESPN id.** `parseDigestResponse` only ever accepts a
  `player_id` that was in the batch it was given (the model's own input), specifically as a
  safety rail against it inventing or forwarding an ESPN-space id. This is the exact
  id-namespace collision `fantasy-core-pipeline`'s `_reject_internal_player_id` (`api/routes.py`)
  exists to guard against elsewhere (ESPN 12483 is Matthew Stafford, internal 12483 is Jack
  Bech) — #81 must add the same guard (translate through `players.espn_id`) before dispatching a
  real `waiver_actions`/`lineup_updates` message off a `rumor_signals` row.
- CROSS-REPO DEPENDENCY, same category as `trade_bot.js`'s `fetchRosterDeficits`: the
  `rumor_signals` table (and its `player_id`/`sentiment`/`confidence`/`suggested_action`/
  `source_raw_signal_ids`/`max_raw_signal_id` columns) is new DDL in `fantasy-core-pipeline`
  (`src/models.py`/`src/migrations.py`) — this repo has no migrations of its own. `src/db/
  rumor_signals.js` talks to it via direct Postgres, same `DB_HOST`/`DB_NAME`/`DB_USER`/
  `DB_PASSWORD` shape as `execution_log.js`/`llm_client.js`, but — unlike those two — its reads
  and writes are **not** best-effort: a failure propagates as a plain `Error` so a scheduled run
  fails loudly and simply retries next interval, rather than silently losing signals the way a
  swallowed metrics-write failure would.

## WORKER-16: Ollama start/ready + async LLM request queue

- #34 was contingent on WORKER-15 (a Discord chat bot that would've blocked on Ollama's cold
  start). WORKER-15 closed `not_planned` and got rescoped entirely out of this repo (a web-UI
  chat panel now lives in `fantasy-core-pipeline#153`/`fantasy-web-ui#97` instead), so **there is
  no real caller for any of this as of this writing** — it was built anyway, per explicit product
  decision, as infrastructure ahead of a caller. Don't assume a caller exists.
- `startOllama()`/`isOllamaReady()` (`src/lib/llm_client.js`) are plain exported functions, not a
  new HTTP endpoint — this repo has no HTTP server anywhere and no external caller to justify
  standing one up. `isOllamaReady()` deliberately bypasses the KEDA interceptor and hits the real
  Ollama Service directly (`OLLAMA_DIRECT_URL`) — going through the interceptor to check
  readiness would itself trigger/extend scale-up, defeating a passive "is it already warm" check.
  `startOllama()` fires a cheap GET (`/api/tags`) through the interceptor and returns once the
  request settles or times out — it never waits out a full cold-start round trip.
- The async request loop (`src/lib/llm_async_queue.js`) is a reusable four-function interface —
  `requestLlmAsync()`/`getLlmRequestResult()`/`waitForLlmResult()`/`processAsyncLlmRequest()` —
  not a one-off tied to a specific caller, since none exists yet. `requestLlmAsync()` inserts a
  `pending` row in `llm_async_requests` *before* publishing to the new `llm_requests` queue, so a
  poll immediately after it resolves never races an empty table. Reply is Postgres-polling, not
  an AMQP `replyTo`/correlationId — no request/response queue convention exists elsewhere in this
  repo to extend, and a polled table reuses the same pool shape `llm_client.js`'s metrics writer
  already uses.
- Deliberately a separate module from `llm_client.js`, which CLAUDE.md's own WORKER-12 section
  scopes to "transport + fallback + rate limiting + instrumentation only" — this is a distinct
  orchestration concern layered on top.
- `llm_requests` joins `connection.js`'s `targetQueues`, so it shares the existing channel-wide
  `prefetch(1)` with every Chromium-driven job (same constraint already called out for
  `trade_evaluations`) — a slow LLM call can block a lineup/waiver/draft job behind it, or vice
  versa.
- CROSS-REPO DEPENDENCY, same category as WORKER-13's `rumor_signals`: `llm_async_requests`'
  DDL lives in `fantasy-core-pipeline`, not here. Contract for a Python publisher that can't
  import `llm_async_queue.js` directly: publish JSON `{ request_id: uuid, prompt: string, opts:
  { callSite, systemPrompt, maxTokens, temperature } }` onto `llm_requests`, then poll
  `llm_async_requests` by `request_id` for `status`/`result_text`/`error_message`. Unlike
  `llm_client.js`'s metrics writes, `processAsyncLlmRequest()`'s row UPDATEs are **not**
  best-effort — that row is the actual response channel a caller polls, so a swallowed write
  failure would silently strand a waiting caller.

## Local dev / recon tooling

- `scripts/openbao-connect.sh`: port-forwards the in-cluster OpenBao and authenticates the local
  `bao` CLI via Google OIDC (reuses a cached token if still valid — doesn't force a browser login
  every run). Run via `eval "$(scripts/openbao-connect.sh)"` (bash/zsh) or
  `eval (scripts/openbao-connect.sh)` (fish). Needs `http://localhost:8250/oidc/callback`
  registered as an allowed redirect URI on both the OpenBao `admin` role and the Google OAuth
  client — if login fails with a redirect_uri mismatch, that's the fix needed.
- `src/bots/draft_recon.js`: one-off recon tool against a real practice draft. Auth priority:
  saved session (`.espn-storage-state.json`, gitignored) → `FORCE_MANUAL_LOGIN=1` or no cookies
  anywhere → cookie injection. Only the first two actually render a working page (see the auth
  split in the docs). Always headed — this tool exists for a human to watch traffic and interact.
- `scripts/practice-draft-test.js` / `scripts/test-draft-pick.js`: live-test `draft_clicker.js`'s
  actual submission path against a real practice draft, without needing to hand-pick a target
  (auto-selects a guaranteed-available low-priority candidate — worst-ranked kicker) or race to
  catch your own turn manually.
- `scripts/draft-watch.js`: read-only advisory watcher — connects to the draft WS in observe-only
  mode, never submits anything. Safe to run alongside the real bot.
- `src/bots/debug_capture.js`: `captureDebugSnapshot(page, label)` — DOM + screenshot capture, on
  by default (set `DEBUG_CAPTURE=0` to disable), always overwrites `debug-<label>-latest.*` rather
  than accumulating files. Any bot holding a Playwright `page` can call this.
