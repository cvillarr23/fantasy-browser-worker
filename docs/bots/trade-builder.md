---
title: Trade builder
description: How trade_builder.js fills ESPN's Propose Trade form and sends it only after five locks open and a human approves the exact offer.
sidebar_position: 9
---

The trade builder fills ESPN's "Propose Trade" form for an offer. It sends the offer only when every lock is open. With any lock closed it ticks the boxes, verifies them, screenshots them and stops.

:::danger[This sends real offers to other managers]
A live send needs `DRY_RUN=false`, `TRADE_SUBMIT_ENABLED=true`, an approval whose `offer_key` matches the offer, verified selectors, and verified counter linkage for a counter. An approval can't be reused for a different offer.
:::

```mermaid
stateDiagram-v2
    [*] --> awaiting_approval: no approval
    [*] --> submit_blocked: approval, a lock closed
    [*] --> submitting: approval, all locks open
    submitting --> submitted: ESPN accepts
    submitting --> failure: ESPN rejects (4xx)
    submitting --> unknown: no response, 5xx, 429
    unknown --> submitted: pending trades show a match
    unknown --> manual: no match
    submitted --> [*]
```

## What starts it?

| Source | Route |
|---|---|
| A generated proposal or counter | The worker calls `submitTradeOffer` itself and stages with no approval. |
| A human approves a staged offer | The core API publishes `trade_submissions` with the approval. |
| A manual run | `node src/bots/trade_builder.js '<json>'` |

## What does the message contain?

| Field | Required | Notes |
|---|---|---|
| `season` | Yes | Integer. |
| `to_team_id` | Yes | The other manager's team. Can't be our own. |
| `incoming_player_ids`, `outgoing_player_ids` | Yes | Non-empty ESPN ids, no duplicates, no overlap. |
| `source` | No | `counter_offer`, `proposal` or `manual`. Default `manual`. |
| `message` | No | A note to the manager. Part of the key. |
| `related_transaction_id` | No | The incoming offer this counters. Part of the key. |
| `thread_root_id` | No | Tracing only. Needs `related_transaction_id`. |
| `approval` | No | `{offer_key, approved_by}`. Without it the run is a dry fill. |
| `tracking_id` | No | |

League and our team come from `ESPN_LEAGUE_ID` and `ESPN_TEAM_ID`.

## What are the locks?

| # | Lock | Open when |
|---|---|---|
| 1 | `DRY_RUN` | Explicitly `false`. |
| 2 | `TRADE_SUBMIT_ENABLED` | `true`, `1` or `yes`. |
| 3 | Approval | `offer_key` equals the key recomputed from the offer. |
| 4 | Selectors | Every submit selector is listed under `_verified` in `espn_selectors.json`. |
| 5 | Counter linkage | Only for a counter: `COUNTER_LINKAGE_VERIFIED` is set in `espn_api.js`. |

The `offer_key` is a SHA-256 over league, season, both teams, the sorted id lists, the note and the related transaction. Reordering ids doesn't change it. Editing the note does.

## What does it read and write on ESPN?

| Step | Surface |
|---|---|
| Read rosters and pending trades | REST |
| Fill the form | Chromium on `…/football/team/trade?teamId=<them>&fromTeamId=<us>` |
| Send | The final click posts a `TRADE_PROPOSAL` transaction |

A browser-wide guard aborts every non-GET ESPN request until the instant before the final click.

## How does it verify?

- Rows are matched by player headshot id, falling back to name. Anything that isn't exactly one row fails closed.
- After ticking, the count of checked boxes must equal the requested count.
- The result's `messageAttached` says whether ESPN's form had a note field. If not, the note isn't sent.
- A real send is claimed in `execution_log` under an advisory lock keyed on `offer_key` before the click. A redelivery of a `submitted` offer is a no-op.
- When the click's outcome is unknown, or a redelivery finds a row stuck at `submitting`, the bot reads ESPN's pending trades. An exact match settles it as submitted. Anything else is a `PermanentError` for a person to check. It never re-clicks on a guess.

## What can go wrong?

| Failure | Result |
|---|---|
| Malformed offer, own team as target, approval for a different offer | `PermanentError` |
| A row doesn't resolve to exactly one player, or a box doesn't stay ticked | `PermanentError` |
| A box doesn't toggle after the click, on every one of 3 attempts (300 ms apart; each retry logs a warning) | `PermanentError` classified `espn_selection_rejected`, with ESPN's reason or `unknown`. The row's HTML and the reason are logged at error level and stored in the failure row. See [Trade proposal and scan](trade-proposal-and-scan.md). |
| ESPN rejects with 4xx | `PermanentError`, claim marked `failure` |
| ESPN returns 5xx or 429, or no response | Outcome unknown, reconciled as above |
| Claimed but never clicked | Claim released so a retry can run |

## Related

- [Trade proposal and scan](trade-proposal-and-scan.md)
- [Trade evaluation and negotiation](trade-evaluation-and-negotiation.md)
- [ESPN trades](../espn/trades.md)
