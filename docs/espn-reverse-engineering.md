# ESPN Fantasy Draft: Reverse-Engineering Notes

Everything in this doc was confirmed against real ESPN traffic — either by correlating actual
picks made in live practice drafts (`recon-output/websockets.jsonl`, captured via
`src/bots/draft_recon.js`), or by running the actual production code paths
(`src/bots/draft_room_socket.js`, `scripts/practice-draft-test.js`) live and observing the result.
Nothing here is guessed; where something is still a guess, it's labeled as such. Dates below are
when each finding was confirmed, all 2026.

## The draft-room WebSocket protocol

Host: `wss://fantasydraft.espn.com`. This is a *separate* backend from ESPN's general fantasy REST
API (`lm-api-reads`/`lm-api-writes.fantasy.espn.com`) — confirmed important because the REST API's
`mDraftDetail` view does not reliably reflect state on this backend (see "REST endpoints" below).

### JOIN URL (08-16/08-17)

```
wss://fantasydraft.espn.com/game-1/league-{leagueId}/JOIN
  ?1=1&2={leagueId}&3={teamId}&4={memberId}&5=1:{leagueId}:{teamId}:{memberId}:-301672673
  &6=false&7=false&8=KONA&nocache={random}
```

- `{memberId}` is the `SWID` cookie value **including its braces** (e.g.
  `{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}`).
- `-301672673` is a fixed constant — identical across captures against different leagues and
  different sessions (2026-08-10 and 2026-08-16/17). Not session-derived.
- Fields `1`, `6`, `7`, `8` are passed through as the literal constants observed (`8=KONA` matches
  the `x-fantasy-platform: kona-PROD` header `espn_api.js` sends on REST writes elsewhere) — their
  actual meaning is unconfirmed, just known-safe to replicate verbatim.
- Query string must be sent close to byte-identical to what a real client sends: `{`, `}`, `:` are
  literal, not percent-encoded (`URLSearchParams` percent-encodes them, `ws`'s own client does
  not — see `buildDraftSocketUrl` in `draft_room_socket.js`, which builds this by hand for that
  reason).

### Handshake auth (confirmed 08-16)

A standalone Node `ws` client (not a real browser) needs, on the WS upgrade request:
- `Cookie: espn_s2=...; SWID=...`
- `Origin: https://fantasy.espn.com`
- A real browser `User-Agent` string

A bare `Cookie` header alone got a `403` on the upgrade, before any application-level response —
almost certainly an edge/WAF check on `Origin` and/or a Node-identifying default User-Agent. All
three together got past it; unconfirmed which one (or both) the 403 was actually gating on.

### Frame types (all plain text, not JSON)

| Frame | Direction | Meaning |
|---|---|---|
| `INIT <base64 blob>` | server→client | Full draft-state sync, sent once per connection. Large (10-20KB+). |
| `TOKEN 1:{leagueId}:{teamId}:{memberId}:-301672673` | server→client | Echoes the JOIN token back. |
| `STATE <n>` | server→client | **Draft lifecycle flag — confirmed 2026-08-25** (real practice draft, league 20050783, 10 teams/160 picks): `1` seen once at connection start (in progress); `2` seen exactly once, immediately after the final `SELECTED`, and never again. The socket stayed open afterward (plain `PING`/`PONG` only) — it did **not** close. This is the fastest, most authoritative draft-completion signal available (see issue #62 below); previously unconfirmed and silently discarded. |
| `CLOCK <slot> <msRemaining> <teamId>` | server→client | Periodic countdown-clock update. |
| `AUTOSUGGEST <playerId>` | server→client | Best-available-player suggestion broadcast. |
| `AUTODRAFT <teamId> <bool>` | server→client | A team's autodraft toggle state changed. |
| `DRAFT_LIST <id> <id> ...` | both | The "add to queue" feature — sends the *full* queue on every change. **Not a pick** — easy to mistake for one; this is what produces "player added to queue" Adobe Analytics beacons. |
| `PING PING%20<unixMillisMs>` | client→server | Periodic (~15s) keepalive from a real client. Space sent as literal `%20`, not decoded. **Not a precondition for `SELECT`** — a real `SELECT` landed 12-19s after the prior `PING` with nothing else in between (confirmed 08-16), so `draft_room_socket.js` doesn't replicate it for its short-lived, one-pick-and-close usage. |
| `SELECTING <teamId> <clockMs>` | server→client | Turn notification — broadcast the instant a team goes on the clock. The reliable way to detect "whose turn is it," far better than polling REST. |
| `SELECT <playerId>` | client→server | **Submits a pick.** Confirmed 08-16 by direct correlation: a sent `SELECT 4362249` was immediately followed by a received `SELECTED 8 4362249 10 {ourSWID}` — our own pick, echoed back, attributed to our own team. |
| `SELECTED <teamId> <playerId> <round> [<memberId>]` | server→client | Confirms a pick landed. `memberId` present only when a human (not autodraft) made the pick. No overall-pick-number on this frame, only round. |
| `ERROR <code> <message>` | server→client | **Not silent** — confirmed 08-17 (`practice-draft-test.js --also-test-taken`, deliberately targeting an already-drafted player): server replies `ERROR 1 Invalid+Selection.` (message space-encoded as literal `+`) rather than just withholding a `SELECTED`. `draft_clicker.js` treats this as a `PermanentError` (the target is definitively gone — redelivery of the same message can never succeed) rather than the ambiguous "no confirmation within timeout" case. |

### What actually submits a pick

`SELECT <playerId>\n` on the JOIN'd socket. Verified twice, independently:
1. Correlated in a passive capture of a real user-driven pick (08-16).
2. Run live via `draft_room_socket.js`'s own `sendPick()` against a real practice draft
   (`scripts/practice-draft-test.js`, 08-16/17) — connected, waited for `SELECTING` naming our
   team, sent `SELECT`, got a matching `SELECTED` confirmation back in **~250ms**.

A real HTTP GET to `https://fantasydraft.espn.com/game-1/league-{id}/SELECT?1={playerId}&token=...`
was also observed once, captured from a browser's Network panel for a real pick — but not from a
session with simultaneous WS+HTTP logging active, so it's unconfirmed whether it's a redundant
path the real client also fires, or something else. Every pick this project's own code has
actually submitted used the WS frame only, with zero HTTP `/SELECT` calls logged alongside it
(confirmed via dual WS+HTTP capture on other real picks) — so WS is treated as sufficient and
primary; the HTTP form is not implemented anywhere.

### The room is single-session (confirmed 2026-08-17)

A new JOIN for the same `leagueId`/`teamId`/`memberId` **evicts** any existing connection for that
identity — verified directly: connecting `scripts/draft-watch.js` while the same user's own
browser tab was already open in the same room evicted the browser tab (shown ESPN's own
reconnect/exit prompt), not the newly-connecting script. The evicted side just sees its socket
close; no distinguishing close code was captured.

This is good news for `draft_clicker.js` specifically — its connection always wins, so it's never
the one that fails to join to submit a pick — but has two real side effects:
- Submitting a pick will momentarily boot the user's own browser tab if they have the draft room
  open at that exact moment (recoverable — they just reconnect; the pick itself already landed by
  the time this happens).
- A long-lived observer (`scripts/draft-watch.js`) is not safe to assume stays connected
  indefinitely: the user's own browser reconnecting, or `draft_clicker.js` briefly connecting to
  submit a pick, will silently evict it too. `draft-watch.js` auto-reconnects on eviction (short
  backoff) rather than going dark; `draft_room_socket.js` exposes `onClose` for this.

## REST endpoints

Host: `lm-api-reads.fantasy.espn.com` / `lm-api-writes.fantasy.espn.com` (`apis/v3/games/ffl/...`).

- **`view=mDraftDetail`** (`espn_api.js`'s `readDraftPicks`, `draft_sync.js`'s `fetchDraftDetail`):
  confirmed **unreliable for ephemeral practice/mock draft rooms** (2026-08-16/17) — returned zero
  picks throughout an entire draft despite multiple confirmed real picks landing (verified via the
  WS `SELECTED` broadcasts, which reflected every pick correctly and immediately), and after the
  draft completed, returned a *completely empty* `draftDetail` (0 pick slots, no
  `inProgress`/`drafted` flags) — not even a final snapshot. Independently corroborated by
  `cwendt94/espn-api` (the most widely-used unofficial ESPN fantasy API library)'s maintainer:
  ["Unfortunately you cannot [use the API for a live draft]... ESPN uses different APIs for the
  live draft so the data won't reflect correctly until afterwards."](https://github.com/cwendt94/espn-api/issues/558)
  Whether this endpoint is reliable for a **real, persisted** (non-ephemeral) league's draft is
  still unverified — untestable until an actual league draft is in progress.
- **`view=draftInit`** (`espn_api.js`'s `fetchDraftPlayerPool`), with a `filter` query param
  scoping to the current player pool: reliable, confirmed working repeatedly even against these
  same ephemeral rooms. Returns the full player catalog with `defaultPositionId` (ESPN's standard
  position ids — `5` = K, `16` = D/ST, among others), `draftRanksByRankType.STANDARD.rank`, and
  `ownership.percentOwned`. This is current-season player data, not draft-instance state, which is
  presumably why it kept working when `mDraftDetail` didn't.
- **`.../teams/{teamId}/draftSecurity`**: part of the draft room's own bootstrap sequence: 200 OK
  confirms the session is authorized to view/act on that team's draft.
- **`leaguedirectory/MOCKDRAFT_LOBBY`**: polled by the mock draft lobby page itself while waiting
  to join a room.

## Clubhouse: pending trades and league chat (issue #101, recon 2026-10-03)

Read-only headless probe against league 1248158344, team 8. `installWriteGuard` was on the whole
BrowserContext before the first navigation: it blocked 0 and allowed 0 writes, and both probes
only navigated and read. No trade was pending in the league, so only the empty state was observed.

- **Pending trades come from `view=mPendingTransactions`.** The clubhouse page's own bootstrap read
  is `GET .../leagues/{id}?rosterForTeamId={team}&view=mDraftDetail&view=mLiveScoring&view=mMatchupScore&view=mPendingTransactions&view=mPositionalRatings&view=mRoster&view=mSettings&view=mTeam&view=modular&view=mNav`.
  That is the only pending-specific view it requests, and the clubhouse makes no other
  trade-related call. With nothing pending, the response has **no `transactions` /
  `pendingTransactions` key at all**: ESPN omits the empty array rather than returning `[]`. The
  populated shape is UNVERIFIED. Presumably it carries `transactions[]` entries with
  `type: "TRADE_PROPOSAL"`, `status: "PENDING"` and `items[].{playerId, fromTeamId, toTeamId}`,
  matching the shape below. Confirm it against the first real pending trade.
- **`view=mTransactions2`** returns the league's executed transaction history (`type`
  ROSTER/FREEAGENT/WAIVER, `status: "EXECUTED"`, `isPending: false`). Each `items[]` entry carries
  real ESPN `playerId`s (negative for D/ST) plus `fromTeamId` / `toTeamId`. Filtering it with
  `x-fantasy-filter: {"transactions":{"filterType":{"value":["TRADE_PROPOSAL", ...]}}}` returned
  nothing this season, which is consistent with team 8's `mTeam`
  `transactionCounter.trades: 0`.
- **The clubhouse page has no inline trade section.** There is no `.trade-container`,
  `.no-pending-trades` or `.trade-card-wrapper`, and no empty-state "no pending trades" element.
  The only trade-related DOM is the "Trade & Acquisition Limits" tooltip and the nav's "Transaction
  Counter" link. The modal containers present (`changes-confirmation-modal`, `success-lightbox`)
  are empty and belong to lineup moves. Whether a real pending trade adds an inline card, a
  banner or a modal is still unobserved, so that half of #101's open question stays open until
  one exists.
- **League chat.** `CHAT_IFRAME_SELECTOR` (`iframe.chat--container--iframe`) is still correct, but
  the iframe is created only after the toggle is clicked (0 matches before the click). The
  toggle is `span.chat--container--header--title`; `getByText(/fantasy chat/i)` matches exactly
  one element, which is that span. The iframe loads
  `https://chat.espn.com/1/{leagueId}/{season}/0/directory`. That URL is the **room list**
  ("2026 League Chat", plus one entry per DM conversation), not a message feed, and it renders
  about 1s after the click (a spinner before that). So reading `body.innerText` straight after
  the click returns `""` or the room list, never messages.
- **`/communication/?view=kona_league_communication`** (reads host, GET) returns the league
  activity feed as `topics[]`: `ACTIVITY_TRANSACTIONS`, `ACTIVITY_SETTINGS`, and
  `CHAT_ALL_MEMBERS` (league-chat posts), with `messages[].{author, date, for, to, messageTypeId}`.
  It is a REST source for league chat that needs no iframe. An
  `x-fantasy-filter` of `{"topics":{"filterType":{"value":["CHAT_ALL_MEMBERS"]},...}}` is honored:
  it returns only that topic. This season it holds only ESPN's league-manager posts (`author: "LM"`;
  `content: null` for templated cards), with no member posts yet to confirm their shape.

**What the bot does now:** `trade_bot.js`'s `readTradeContext` uses `espn_api.js`'s
`readPendingTrades` (the view set above) and `readLeagueChat` (this feed) instead of loading the
clubhouse page. Neither negotiation nor the standalone scrape navigates anywhere any more.

## Draft-room DOM (verified 2026-08-16/17)

Issue #14 confirmed the **roster** page has no per-player DOM identifier at all
(`tr[data-player-id]` and every variant return zero matches — see `espn_selectors.json`'s own
header). The **draft room** is a different app; it does carry per-player identifiers, just not on
a `tr`:

- **Queue button**: `button.Button--queue.action-btn[data-player-id="{playerId}"]`
- **Draft button**: `button.Button--draft[data-player-id="{playerId}"]` (full class observed:
  `"Button Button--alt ttu Button--draft"`)

Both carry `data-player-id` directly on the button itself — no row/ancestor traversal needed to
correlate a button with a player. The Draft button specifically was hard to catch: it's only
rendered while the current user is actually on the clock, so `draft_recon.js`'s original
fixed-60-second-interval snapshots never once landed in that window. Fixed by triggering a capture
the instant a `SELECTING` frame names our own team (`captureOurTurnSnapshot` in `draft_recon.js`)
instead of polling blindly.

## Auth: two separate surfaces, only one needs a real login

This is the single most important distinction this reverse-engineering effort found, because it
looks like one auth problem but is actually two:

1. **`espn_s2`/`SWID` cookies** (what `auth.js`'s `createAuthenticatedSession` injects) are
   *sufficient* for both the REST API and the entire WS draft protocol above. Proven repeatedly —
   every real pick this project has submitted used cookie-only auth, no browser UI involved.
2. **The rendered browser page** additionally requires a full Disney/MyDisney identity SDK session
   — BAM SDK traffic to `espn.connections.edge.bamgrid.com`, a JWT `accessToken` obtained only via
   a real interactive login (captured once, 2026-08-10, in a `framesent` to that socket). Cookie
   injection never establishes this. Confirmed 2026-08-17: a Playwright page loaded with valid
   `espn_s2`/`SWID` cookies still showed ESPN's own "Log in Required" gate (a client-side React
   overlay, not a server redirect — never shows up in HTTP response logs) — while the exact same
   cookies kept REST calls and the WS protocol working perfectly underneath, at the same time.

**Practical effect**: anything that only talks to REST/WS (production `draft_clicker.js`, via
`draft_room_socket.js`) is unaffected by this. Anything that renders a page (`draft_recon.js`'s DOM
captures, `draft_room_dom.js`'s DOM-click fallback tier) needs a real login, not just cookies.

### Automated login is blocked (confirmed, not just untested)

A prior attempt to script the actual login form (`login_recon.js`, `espn-session-refresh` branch,
commit `c3fd986`) confirmed ESPN's login goes through a Disney OneID widget
(`cdn.registerdisney.go.com`, iframe-embedded) gated by **invisible reCAPTCHA Enterprise**
(`google.com/recaptcha/enterprise/anchor?...size=invisible...`, confirmed present in the captured
frame list). The real captured evidence (`recon-output/login-*` — gitignored locally, but the
finding is preserved here):
- Selectors matched correctly (`input[type="email"]`, `input[type="password"]`,
  `button[type="submit"]`) and the form filled correctly.
- Clicking submit did **nothing observable** — no error, no navigation; the modal just sat there
  with the fields still populated and the reCAPTCHA badge visible. That silent non-response is the
  signature of invisible reCAPTCHA intercepting the submit callback and never releasing it because
  the automated session's risk score came back too low.

This is closed, not "untested" — do not re-attempt scripting the login form. Beyond wasting effort
repeating this exact result, repeated automated login *attempts* against a real account risk
getting flagged by Disney's own fraud/bot detection, independent of whether any individual attempt
succeeds.

### The practical fix: session persistence, not automation

`draft_recon.js` (see `tryLoadStoredSession`/`launchWithManualLogin`) saves the full Playwright
`storageState()` (cookies + localStorage, which captures the Disney SDK session too) to
`.espn-storage-state.json` (gitignored) after a real manual login, and reuses it automatically on
every subsequent run — so a human only has to actually click through the login page occasionally
(whenever the saved session goes stale), not every run. `FORCE_MANUAL_LOGIN=1` forces a fresh
interactive login even when cookies are otherwise available, which is what actually establishing
that session requires.

For doing this login remotely (e.g. on draft day without physical access to a machine), see the
remote VNC login tool tracked in issue WORKER-11 — the key design point there is the same
distinction as above in reverse: it deliberately uses **real VNC** (X11-level input injection),
not a CDP-relayed remote-control page, specifically because CDP-dispatched input is still
programmatic input from the browser's perspective — the same category reCAPTCHA already silently
blocked once. VNC input is indistinguishable from a real mouse/keyboard because a human is
actually driving it, just over the network.

## Pick ingestion: three tiers, and why

`draft_sync.js` ingests picks from three sources at once. This is not redundancy for its own sake —
tiers 1 and 2 have a **confirmed simultaneous blind spot** for exactly the case that matters
(practice drafts), which is what issue #52 was opened about.

| Tier | Source | Strength | Failure mode |
|---|---|---|---|
| 1 | WS `SELECTED` frames | Fastest (~250ms), exact numeric ids | Room is single-session — any second connection for the same league/team/member **evicts** us, and the protocol has **no replay**. Every pick broadcast during the gap is lost. |
| 2 | REST `mDraftDetail` | Only source with a true `overallPickNumber` | Returns **zero picks for the entire duration** of a practice/mock draft (see above). |
| 3 | Rendered draft board (DOM observer + poller) | Shows the **full history** regardless of when we connected or who picked | Selector-dependent, and the board markup is **unverified** (see below). |

Tier 3 exists because tiers 1 and 2 fail *together* during a practice draft: the WS gets evicted
(by the user's own browser tab, or by `draft_clicker.js` connecting to submit a pick), and REST —
the natural backfill — has nothing. The rendered board is the only surface that still knows what
happened.

### Dedup: keyed on `player_id`, not `pick_number`

All three tiers funnel through `draft_pick_ledger.js`. Source precedence is
`rest > dom > init > ws`: WS publishes first (it's the fastest), higher tiers only ever *correct*
what it published.

The dedup key is **`player_id`**, deliberately not `pick_number`, because pick numbers are not
comparable across sources: WS frames carry none at all (`draft_sync.js` derives one from a local
counter, so one missed frame offsets every subsequent pick permanently), the DOM board may show a
round-relative label or nothing, and only REST has a real one. A player can be drafted exactly
once, so `player_id` is the only genuinely stable identity. Issue #52's composite
(`league_id + pick_number + player_id + team_id`) is retained as `pickIdentity()` for
equality/logging.

Two durability rules make that ledger safe to rely on as the *only* dedup gate:

- **Commit-after-write.** `evaluate()` decides; `commit()` records. `draft_sync.js` only commits
  once the Redis write actually lands. Recording earlier would mean a transient Redis failure
  permanently marks a pick as published while nothing was ever emitted — every later observation
  of it would then be dropped as a duplicate and the pick lost for the rest of the draft.
- **Seeded from the durable board on startup.** `seedLedgerFromBoard` rehydrates from
  `draft:{leagueId}:picks` (renamed off the shared `draft:{leagueId}:board` key by #56 — this doc
  previously lagged that rename) before any tier can ingest. Without it, a mid-draft worker restart
  starts cold, and the DOM observer's first full-board scan re-publishes the entire draft as new
  picks — minting fresh pick numbers in DOM scan order and overwriting the board hash's correct
  pick→player mapping. REST cannot cover for this, since it returns nothing for practice drafts.

Ingest is also serialized (one pick at a time) so that two tiers reporting the same pick
concurrently can't both pass `evaluate()` before either commits.

### Suggested pick: `AUTOSUGGEST` is on the WS, no DOM scraping needed (issue #31)

Issue #31 asked for ESPN's own suggested-next-pick, for fantasy-web-ui's comparison panel. Scope
note #1 there asked to confirm whether it's already on a WS frame before committing to DOM
scraping (which would mean touching `draft_room_dom.js` and the reCAPTCHA-blocked recon path
documented above) — it is: `AUTOSUGGEST <playerId>` (see the frame table above) is a real,
confirmed frame, not a guess — 154 instances captured in a single real practice draft
(`recon-output/websockets.jsonl`, 2026-08-25), one per pick cycle. It carries only a bare player
id, no name/position/team.

`draft_sync.js` resolves that id against a player catalog fetched once per draft
(`loadPlayerPool`, `espn_api.js`'s `fetchDraftPlayerPool` — the same `view=draftInit` call already
used elsewhere, which also carries `proTeamId` alongside the `defaultPositionId` it was already
returning) and publishes the result to `draft:{leagueId}:suggested` — a single overwritten Redis
key (`SET`, no TTL), not routed through the pick ledger/ingest pipeline: it isn't a pick, has no
dedup semantics, and would corrupt pick numbering if it were. A cold or failed catalog fetch
degrades the published suggestion to a bare `player_id` rather than dropping it or blocking sync.

Exposing this via fantasy-core-pipeline's `/v1/draft/status` (fantasy-core-pipeline#80) is a
separate, not-yet-done change in that repo.

### DOM board selectors are UNVERIFIED

Unlike the Draft/Queue buttons above, the draft **board / pick-history** markup has never been
captured while picks were on it. `draft_dom_observer.js` therefore tries a prioritized list of
candidate strategies (ending in a structure-free `[data-player-id][data-team-id]` scan that should
survive a redesign) and **logs every miss** with per-candidate match counts and a truncated
`sample_html` of the board. One look at the pod logs from a real draft is enough to fix the
selector — no extra live-testing round trip needed just to discover it's broken.

### Debugging a missing pick from pod logs

Structured fields to filter on (`component=`):
- `draft_ws` — socket open/close with per-socket frame and pick counts. A close logs at `warn`
  because it's usually an eviction, and tells you how big the gap is.
- `draft_dom_observer` — scan results, selector misses (with DOM sample), recovery.
- `draft_ingest` — every publish/correct/drop decision, with `source`, `pick_identity` and
  `decision`. `"DOM tier recovered N pick(s) the WebSocket never delivered"` is the headline #52
  signal: if it appears often, the socket is being evicted more than expected.
- `draft_health` — fixed-cadence heartbeat (also written to `draft:{leagueId}:health` in Redis)
  with `ws_connected`, `picks_known`, `last_pick_seen_at`, `pick_silence_ms` and per-tier counters.
  It emits regardless of activity **because silence is ambiguous** — a feed with no picks for two
  minutes looks identical whether it's healthy during a slow drafter's turn, evicted, session-
  expired, or running a stale selector.

### Draft completion (issue #62)

A genuinely finished draft used to look, at the transport layer, identical to a dead/evicted
connection: `mDraftDetail` 404s or goes empty (practice drafts never had it working anyway — see
above), and the DOM board scan misses (the board is gone). Before #62, `draft_sync.js` treated this
as always-transient and reconnected forever — a fresh headless Chromium every ~32s, indefinitely.
Live recon (2026-08-25, practice league 20050783, 10 teams/160 picks) found the WS does **not**
actually close on completion — it stays open, idle apart from `PING`/`PONG` — so the original
issue's assumption of a closing socket doesn't reproduce; what does reliably signal completion is
the `STATE 2` frame documented above.

Two — and only two — signals are treated as authoritative enough to declare the draft complete
(exit 0), checked every reconnect cycle:
- **`STATE 2` frame** (`state.draftCompleted`): **CONFIRMED 2026-08-25** — ESPN's own completion
  signal, fired exactly once immediately after the final `SELECTED` and never again. Sets
  `state.draftCompleted` the instant the WS frame handler sees it, breaking the connection loop
  without waiting on anything else.
- **Total-picks reached** (`fetchDraftTotals`, `state.expectedTotalPicks`): a `mSettings`+`mTeam`
  REST call learns `teams × draftable roster slots` once per league — excluding slot id `21` (IR),
  which is allocated roster space never filled during the draft itself. **CONFIRMED 2026-08-25
  working mid-draft** even for ephemeral practice drafts (unlike `mDraftDetail`, which never worked
  for them at all): the same league returned `teamCount=10`, `rosterSlotsPerTeam=17` (16 draftable
  + 1 IR) — naively summing all 17 would compute 170 and the fast path would never fire, since the
  draft only ever produced 160 picks (10 × 16). **CONFIRMED torn down post-completion**
  (`LEAGUE_NOT_FOUND_DELETED`, same as `mDraftDetail`'s documented post-completion behavior) — a
  reconnect landing after the draft ends gets `null` here, which is expected, not a bug: whatever
  total was already learned on an earlier cycle is preserved rather than cleared, since this is
  exactly the reconnect where it matters most.

A third counter — `state.consecutiveEmptyCycles`, N consecutive reconnect cycles with zero new
picks across all three tiers — is deliberately **not** a third way to call this terminal. Silence
is ambiguous: a sustained ESPN/network outage on a still-active draft looks identical to a finished
one at this layer, and wrongly declaring "complete" would permanently stop syncing a draft that's
still going. Instead it only escalates the "still retrying" log line from `warn` to `error` once it
reaches `DRAFT_STALL_TERMINAL_CYCLES` (env-tunable, default 3), and rides the reconnect-cap/backoff
machinery (`decideReconnectAction`, `MAX_RECONNECT_ATTEMPTS`) to a bounded, honest **failure** exit
(1) if neither real signal ever fires — "gave up, don't know if it finished" rather than a false
"it's done."

The heartbeat snapshot now also carries `terminal`, `terminal_reason` (`"state_2_frame"` or
`"total_picks_reached"` — `null` otherwise), `consecutive_empty_cycles`, and `expected_total_picks`
— the last two on every heartbeat (not just a terminal one), so the progression is visible in
logs/Grafana before a terminal call (or the stall-escalation threshold) fires. On a terminal
heartbeat, `draft:{leagueId}:connected` is deleted immediately (rather than left to its 60s TTL)
and the process exits 0 instead of continuing to reconnect. Proposal #4 from issue #62 (raw frame
types) is also captured now: every non-`INIT`, non-`SELECTED` frame increments
`ws.other_frames[type]` and logs once per type per run — this is exactly how `STATE 2` was found.

## Practice/mock drafts: quirks worth knowing

- Clicking "Practice Draft" from the mock draft lobby sometimes opens the actual draft room in a
  **brand-new browser tab** rather than navigating the current page in place (confirmed
  2026-08-17). Code that only watches the original page for a URL change will hang and eventually
  crash the whole session when that tab never comes. `mock_draft.js`'s `startFreshPracticeDraft`
  races both possibilities and returns `{ url, page }` — callers must use the returned `page`, not
  necessarily the one they passed in.
- The lobby's own "Practice Draft" auto-click is flaky (Playwright's `waitForURL` on it times out
  roughly as often as it succeeds) — there's always a manual-click fallback window in
  `draft_recon.js`.
- A player added to the *queue* (`DRAFT_LIST` frame, "Queue" button) is easy to mistake for an
  actual pick — it isn't one. Only `SELECT`/`SELECTED` are real picks.
- **Selector trap** (confirmed live 2026-08-21, stored session, headless): the lobby's "League
  Specific Practice Draft" *section heading* is a plain `<div>` whose text also matches
  `/practice draft/i` — a `getByText(/practice draft/i).first()` locator grabs that heading
  instead of the actual `<button>Practice Draft</button>` a few nodes later. The click on the
  heading doesn't error (a heading is a valid click target), it just does nothing — no
  navigation, no visible failure, just a silent no-op that looks identical to "the click never
  landed." Direct DOM query confirmed the fix: `getByText(/practice draft/i)` matches 3 elements
  (the heading, an unrelated table caption, and the button); `getByRole("button", { name:
  /practice draft/i })` matches exactly 1 (the button). `mock_draft.js` now tries role=button
  first for this reason.
- **Headless auto-join is still blocked even with the correct button — traced to the same
  reCAPTCHA Enterprise gate already confirmed for login** (confirmed live 2026-08-21; refines
  rather than supersedes the 2026-08-10 finding — same root cause, discovered here via a different
  symptom first). Full chain, traced step by step against a real practice draft:
  1. The lobby always embeds an invisible reCAPTCHA Enterprise iframe
     (`www.google.com/recaptcha/enterprise/anchor?...&size=invisible`) alongside the DisneyID
     identity iframe, present on page load — not something the click triggers.
  2. With no permission grant, clicking the correct "Practice Draft" button makes that reCAPTCHA
     iframe call `document.requestStorageAccess()` (confirmed via an injected wrapper logging the
     calling origin: `https://www.google.com`), which headless Chromium denies
     (`requestStorageAccess: Permission denied.`). The surrounding page's own React app doesn't
     handle that rejection and crashes (`Cannot read properties of undefined (reading
     'currentSeason')` / `'pageName'`).
  3. Granting it via CDP fixes step 2's crash: `Browser.setPermission({ permission: { name:
     "storage-access" }, setting: "granted", origin: "https://www.google.com", embeddingOrigin:
     "https://fantasy.espn.com" })` — note the permission name is kebab-case `"storage-access"`,
     not `"storageAccess"` (the latter is rejected as an invalid `PermissionDescriptor`).
     Playwright's own `context.grantPermissions()` doesn't cover this API; a raw CDP session
     (`context.newCDPSession(page)`) is needed.
  4. Even with that grant in place (no more crash, no more denial logged), the click still never
     navigates — silently, even after a 25s wait, with `navigator.webdriver` already `false`
     (confirming the `--disable-blink-features=AutomationControlled` launch flag works as
     intended). A completely silent no-op with no error and no crash is the documented signature
     of invisible reCAPTCHA Enterprise: it scores the session as automated via deeper
     behavioral/fingerprint signals than `navigator.webdriver` and simply never completes its
     challenge or releases whatever callback would trigger navigation.

  Not a selector problem, not fixable by granting more permissions or Chromium flags — reCAPTCHA
  Enterprise is specifically designed to resist exactly this kind of workaround, and it's the same
  mechanism already confirmed blocking automated login (see above). `DRAFT_ROOM_URL` (a human
  joins a room once, headless only resumes/observes it) remains the working path; don't spend more
  time trying to defeat the reCAPTCHA gate itself.

## IR moves

### Confirmed request and eligibility

The live capture on 2026-10-06 used league **1248158344**, team **8**, and
`submitLineup`'s normal transaction endpoint and headers:

```text
POST https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1248158344/transactions/
Content-Type: application/json
x-fantasy-source: kona
x-fantasy-platform: espn-fantasy-web
```

```json
{
  "isLeagueManager": false,
  "teamId": 8,
  "type": "ROSTER",
  "memberId": "<brace-wrapped SWID>",
  "scoringPeriodId": 5,
  "executionType": "EXECUTE",
  "items": [{
    "playerId": 4239996,
    "type": "LINEUP",
    "fromLineupSlotId": 20,
    "toLineupSlotId": 21
  }]
}
```

| Move | Result |
|---|---|
| Tony Pollard (`3916148`, ACTIVE), bench 20 → IR 21 | HTTP 409, `details[].type: TRAN_ROSTER_INELIGIBLE_IR_NOT_INJURED`; no change |
| Travis Etienne Jr. (`4239996`, INJURY_RESERVE), bench 20 → IR 21 | HTTP 200, `status: EXECUTED` |
| Etienne, IR 21 → bench 20 | HTTP 200, `status: EXECUTED`; reverted and the fresh roster matched the original player/slot snapshot |

The worker represents these as `{kind: "ir", player_id, slot: "IR"}` and
`{kind: "activate_ir", player_id, slot: "BENCH"}` in `optimized_swaps`. Each produces
one LINEUP item, and moves out of IR are ordered first. `planIrMove` accepts only
OUT / INJURY_RESERVE for a new IR move; ESPN remains the final authority.

Read-only follow-up on 2026-10-06 found **264** `mTransactions2` rows across scoring
periods 1–5, including seven executed moves into slot 21 and Etienne's revert.
Six earlier entries belonged to other teams; their current IR occupants comprise
two OUT players and four INJURY_RESERVE players. The history confirms those moves
executed, but does not retain their injury statuses at insertion time.

### Read-only eligibility evidence

Frontend build `9f97de9ffb23-1.506` provides additional evidence without writes:

- [team.js](https://cdn1.espn.net/kona/9f97de9ffb23-1.506/_next/88237a8a-c7d8-42de-bb1d-dd2019e38155/page/football/team.js)'s
  "Manage IR" list filters roster players by `player.injured` and excludes players
  already in the injury slot.
- [main-47cd1ababb50e7ff28c7.js](https://cdn1.espn.net/kona/9f97de9ffb23-1.506/_next/static/commons/main-47cd1ababb50e7ff28c7.js)'s
  player model reads `injured` directly from the API. Its injury-status metadata
  marks QUESTIONABLE, DOUBTFUL and SUSPENSION as `injured: false`, and OUT and
  INJURY_RESERVE as `injured: true`.
- `eligibleSlots` is insufficient: the live roster read includes 21 for healthy
  players too. The team's general slot-eligibility helper merely checks membership
  in that array, while the Manage IR list uses `injured`.

This supports the worker's conservative status set. Server rejection of
QUESTIONABLE / DOUBTFUL / SUSPENSION remains **unconfirmed**; no eligibility test
writes were sent during this investigation.

### An ineligible occupant blocking a later transaction: unconfirmed

Team 8's IR slot was **empty** in the follow-up read. Etienne remained on the bench
with INJURY_RESERVE status. Every current IR occupant elsewhere was OUT or
INJURY_RESERVE, so there was no naturally occurring healthy-IR state to inspect.

The history's three failed waiver claims were `FAILED_INVALIDPLAYERSOURCE` (two)
and `FAILED_PLAYERALREADYDROPPED` (one), unrelated to IR blocking. None of the rows
provided either requested rejection's HTTP status or `details[].type`.

The shared frontend disables trade proposals when `ineligibleIrPlayer` is true,
with a message asking the manager to fix the injury slot. Neither inspected bundle
contained a specific IR-blocking `TRAN_*` code. This does **not** confirm the claim
that every other transaction is rejected, nor the error body for a lineup move.
Capture it only when the state occurs naturally and a live write is approved.

`submitLineup` includes ESPN's response text in its failure message and the lineup
bot surfaces that error and records roster injury statuses in its failure artifact.
A captured HTTP 409 will be a `PermanentError`; an explicit activation instruction
based on an ESPN error code must wait until that code is observed.

### Full-roster add-only capture: pending

Team 8 had **16 players**, 16 configured non-IR slots (including seven bench slots),
and an empty IR slot. The settings also reported `isBenchUnlimited: true`; configured
slot totals alone are not empirical proof of how the add endpoint enforces capacity.
No add-only request was sent during this investigation.

The shared transaction service recognizes `TRAN_ROSTER_LIMIT_EXCEEDED_ONE`,
`TRAN_ROSTER_LIMIT_EXCEEDED_PLURAL`, their `_LM` variants, and trade-reserved variants.
It reads rejection bodies as `details[]` entries containing `type`, `message`,
optional `resolution`, and `metaData.teamid`. **The actual full-roster add's status
and body remain unconfirmed.** A roster-limit HTTP 409 fixture in the unit tests is
frontend-derived, not a live capture.

The proposed capture uses Matt Prater (`11122`, kicker) with no drop, using the same
endpoint and headers as above:

```json
{
  "isLeagueManager": false,
  "teamId": 8,
  "type": "FREEAGENT",
  "memberId": "<brace-wrapped SWID>",
  "scoringPeriodId": 5,
  "executionType": "EXECUTE",
  "items": [{"playerId": 11122, "type": "ADD"}]
}
```

Prater's read returned `onTeamId: 0`, `status: WAIVERS`, with a processing timestamp
of **2026-10-07T07:00:00Z**. That timestamp is not a guarantee he becomes a free
agent. Do not send the proposed FREEAGENT write unless a fresh read shows FREEAGENT.
Team 8 has one kicker against a position limit of three, so the chosen position
does not already exceed its limit.

For an approved capture:

1. Re-read Prater's availability, Team 8's roster/settings and pending transactions.
   Require FREEAGENT, verify the roster is still full, and save the player/slot
   snapshot. Use the fresh scoring period rather than hardcoding the example's 5.
2. Send one add-only request and retain its complete response status and body.
   Never retry a write with an ambiguous result before reconciling its state.
3. Re-read roster and pending transactions even after a rejection, comparing them
   to the snapshot. If a pickup lands, revert only that pickup with a DROP-only
   FREEAGENT transaction and re-read until the player/slot snapshot matches.
   Investigate any unexpectedly queued claim before concluding nothing changed.
4. Check the captured response through the submission helper's classification with
   a mocked response; this requires no second live write.

All writes need explicit approval, including an expected rejection. Keep cookies
in memory and out of capture files. HTTP 4xx other than 429 are permanent request
failures, except 401/403: both `submitLineup` and `submitWaiverClaim` raise
`SessionExpiredError` so authentication failures can retry after credentials are
refreshed. Rate limits, server errors and network failures remain retryable.

For an IR move followed by a pickup, wait for the IR action's `verified_complete`
before submitting the add-only action. Give each action its own idempotency key.

## Trade proposals: the submit request (issue #124)

Worked out on 2026-10-03 by **static analysis of ESPN's own frontend JS. Nothing was sent.** No
trade was proposed and no box was ticked. The only live browser run loaded the trade builder
(`buildTradeBuilderUrl`, league 1248158344, team 8 → team 1) to collect bundle URLs. It ran with
`installWriteGuard` on the BrowserContext, a stricter route that aborts every non-GET request to
any host, `routeWebSocket` closing every socket, and `serviceWorker.register` stubbed, all
installed before the first navigation. Result: guard **blocked 0 / allowed 0**. The stricter route
aborted 3 non-ESPN POSTs (bamgrid graphql, AWS WAF `mp_verify`). No WebSockets or service workers.
A second run made two GET-only `context.request` reads (below) and no navigation. Guard
0 / 0.

Sources: frontend build `platformVersion=35f16ade75be0a2c2a61e24b733d8f8958c8ce35`, under
`cdn1.espn.net/kona/35f16ade75be-1.504/_next/.../page/football/team/trade.js` (UI and `sendTrade`)
and `.../static/commons/main-396c1392ce19efb16ea8.js` (transaction service, model and HTTP layer).
The names below are the minified bundle's, so they will change between builds.

### Request

`sendTrade` (trade.js) → `TransactionService.proposeTrade` → `createTransaction` + `pushItems` →
`saveTransaction` → the shared POST helper:

- **`POST https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/{seasonId}/segments/0/leagues/{leagueId}/transactions/?platformVersion=<build hash>`**.
  This is the same endpoint as `submitLineup`. The host comes from `HOST_TYPE_FANTASY_WRITE_API`.
  `platformVersion` is added to every API call by the axios config.
- Headers: `Accept: application/json`, `Content-Type: application/json`, `X-Fantasy-Source: kona`,
  `X-Fantasy-Platform: espn-fantasy-web`, `withCredentials` (espn_s2/SWID cookies). These are
  identical to `submitLineup`'s verified headers.
- Body: `JSON.stringify` of the transaction model's `get()`:

```json
{
  "isLeagueManager": false,
  "teamId": 8,
  "type": "TRADE_PROPOSAL",
  "memberId": "{SWID-WITH-BRACES}",
  "scoringPeriodId": 4,
  "executionType": "EXECUTE",
  "items": [
    { "playerId": 3117251, "type": "TRADE", "fromTeamId": 1, "toTeamId": 8 },
    { "playerId": -16019,  "type": "TRADE", "fromTeamId": 1, "toTeamId": 8 },
    { "playerId": 4429795, "type": "TRADE", "fromTeamId": 8, "toTeamId": 1 },
    { "playerId": 4362238, "type": "TRADE", "fromTeamId": 8, "toTeamId": 1 }
  ],
  "expirationDate": "2026-10-05T15:04:05.123Z",
  "comment": ""
}
```

  - `teamId` is the **proposer** (us). Each item has `type: "TRADE"`. Its direction comes from the
    player's current team: theirs go `fromTeamId: them → toTeamId: us`, ours the reverse.
  - `scoringPeriodId` is `league.status.latestScoringPeriod`. `proposeTrade` passes no
    `transactionScoringPeriodId`. `memberId` is `guest.profile.swid`: the brace-wrapped SWID,
    same as `submitLineup`.
  - `expirationDate` is `moment().add(days, "days")`, where `days` defaults to **2** (options 1–7,
    "Keep trade open for:"). `JSON.stringify` serializes it with moment's `toJSON()`, which gives
    an ISO-8601 UTC timestamp with milliseconds. It is `null` when acting as LM. Only a
    `TRADE_PROPOSAL` body carries `expirationDate`.
  - `comment` is the note to the other manager. It is a plain string, sent as `""` when empty
    (the store default). It's included for `TRADE_PROPOSAL`, `TRADE_DECLINE` and `TRADE_VETO`.
  - Optional extra items: draft-pick trades (`{overallPickNumber, type: "DRAFT_TRADE", fromTeamId,
    toTeamId}`), FAAB (`{acquisitionBudget, type: "ACQUISITION_BUDGET_TRADE", fromTeamId, toTeamId}`),
    and roster-fix drops (`{playerId, type: "DROP", fromTeamId}`, when ESPN answers that a drop is
    required). `relatedTransactionId` is sent only on a counter (`TRADE_PROPOSAL` with a related id).
  - `isActingAsTeamOwner` / `skipTransactionCounters` are sent only when `isLeagueManager` is true.

  `submitLineup`'s verified body is the same envelope (`isLeagueManager, teamId, type, memberId,
  scoringPeriodId, executionType: "EXECUTE", items`). A trade changes `type`, the item shape, and
  adds `expirationDate` and `comment`.

  Confidence: **high** for endpoint, method, headers and envelope. They come from the same code
  path `submitLineup` was verified against in a live capture. **Medium-high** for the item and
  expiration encoding: this is read from code, not seen on the wire.

### How the client judges the response

- The HTTP layer resolves on every status (`validateResponse: () => true`). `saveTransaction`
  then splits on **`status >= 400`**:
  - **< 400 → `"success"`.** The response body is the created transaction (the client reads
    `response.scoringPeriodId`). The UI stores a toast in `sessionStorage.transaction` and
    redirects to our clubhouse.
  - **≥ 400 → `"error"`.** The body has `details[]`, each `{type, message, resolution?,
    metaData.teamid}`. `type` codes such as `TRAN_ROSTER_LIMIT_EXCEEDED_*`,
    `TRAN_ROSTER_POSITION_LIMIT_EXCEEDED*` or `TRAN_ROSTER_SLOT_LIMIT_EXCEEDED*` set
    `dropIsRequired`. The builder then asks for a roster-fix drop and resubmits.
  - A thrown request (network, timeout after 50 s) → `"exception"`.
- `trade_builder.js`'s predicate (`POST` + `lm-api-writes.fantasy.espn.com/.../transactions/` +
  `(\?|$)`) **matches** the real URL, including the `?platformVersion=` query string. Its
  "4xx but not 429 = definite rejection" rule matches the client's `>= 400` error branch.

### Reading pending offers back

- **`GET lm-api-reads…/leagues/{leagueId}?view=mPendingTransactions`** is what the clubhouse
  (`page/football/team.js`) and league home pages read. ESPN's league store reads the raw
  response's `pendingTransactions[]` (the #101 notes assumed `transactions`, also unobserved, so
  `espn_api.js`'s `readPendingTrades` reads both). The client finds trades with `type ∈ {TRADE_PROPOSAL, TRADE_ACCEPT}`
  where `teamId === team` or any `items[].fromTeamId/toTeamId === team`. The key is **left out
  entirely when nothing is pending**: the live read on 2026-10-03 returned 200 with no
  `pendingTransactions` key, so treat a missing key as `[]`.
- **`view=mTransactions2`**: `transactions[]` with keys `id, type, status, isPending, teamId,
  memberId, proposedDate, processDate, executionType, scoringPeriodId, relatedTransactionId,
  bidAmount, rating, items[]` (items: `playerId, fromTeamId, toTeamId, type, fromLineupSlotId,
  toLineupSlotId, overallPickNumber, isKeeper`). The live read returned 12 executed
  ROSTER/FREEAGENT/WAIVER rows, apparently scoped to the current scoring period.
- Neither has been seen holding one of *our* `TRADE_PROPOSAL`s yet, so the exact `status` string
  for an open offer (likely `PENDING`) is unconfirmed.

## Responding to incoming trades: still unverified

Nothing has accepted or declined a trade yet, so this section records what the
code assumes and how to confirm it. `trade_response.js` will not send either
action until the action is listed in `espn_api.js`'s
`VERIFIED_TRADE_RESPONSE_ACTIONS` and `PENDING_TRADE_SHAPE_VERIFIED` is set.

- **Request (hypothesis).** `buildTradeResponseBody` POSTs to the same
  `transactions/` endpoint with the `submitLineup` envelope. It sends
  `type: "TRADE_ACCEPT"` or `"TRADE_DECLINE"`, `relatedTransactionId` set to the
  offer's id, `items: []`, and `comment` on a decline only. The types appear in
  the frontend bundle, and `comment` is sent with `TRADE_DECLINE` (see "Trade
  proposals" above). The field that points at the offer, and whether the
  offer's items must be repeated, are guesses.
- **Pending shape.** `readPendingTrades` passes `expirationDate`,
  `relatedTransactionId` and `isPending` through when present. It keeps
  draft-pick (`DRAFT_TRADE`, `overallPickNumber`) and FAAB
  (`ACQUISITION_BUDGET_TRADE`, `acquisitionBudget`) items with `playerId: null`.
  The inbox records anything unexpected in `parse_issues` instead of guessing:
  - a status other than the presumed `PENDING`;
  - a missing `expirationDate`;
  - more than two teams;
  - an unknown item type.
- **History.** `readTradeHistory` reads `view=mTransactions2` with a TRADE_*
  `x-fantasy-filter`. The inbox uses it to learn why an offer left the pending
  list: a `TRADE_ACCEPT`, `TRADE_DECLINE`, `TRADE_VETO` or counter
  `TRADE_PROPOSAL` whose `relatedTransactionId` names the offer, or a
  `CANCELED` status on the offer itself. None of these rows has been seen yet.

How to confirm, read-only first:

1. Static analysis of the current trade bundle, with the write guard on, as in
   "Trade proposals". Find the accept and decline builders and the pending-trade
   status strings.
2. Read `mTransactions2` for prior seasons with the TRADE_* filter, per
   `scoringPeriodId`, to see real trade rows and how they link.
3. Leave `trade_inbox.js --refresh` running. The first real incoming offer is
   appended to `espn-pending-transactions.jsonl`. Turn it into a fixture (SWIDs
   redacted) and set `PENDING_TRADE_SHAPE_VERIFIED` in the same change.
4. The wire shape of a response can only come from a real one. The user clicks
   Accept or Decline themselves in a headed session while the request is
   recorded, the same pattern as `lineup_recon.js --watch-save`. The bot never
   clicks, and doing this needs explicit approval each time.
