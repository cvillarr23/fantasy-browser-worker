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
| `STATE <n>` | server→client | Seen once at connection start; exact meaning unconfirmed (likely draft-in-progress flag). |
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
