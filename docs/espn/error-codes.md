---
title: Error codes
description: The TRAN_* rejection codes, transaction history statuses, draft-room errors and HTTP statuses ESPN returns, what each means, and how the worker classifies them.
sidebar_position: 6
---

Look up an ESPN rejection here. The **Source** column says whether the code was seen on the wire or only read from ESPN's frontend.

## Rejection body shape

A rejected write returns HTTP 4xx (409 so far) with a `details[]` array. This example combines a captured `type` and `message` with the field names ESPN's frontend reads:

```json
{
  "details": [
    {
      "type": "TRAN_ITEM_TO_TEAM_ID_MISSING",
      "message": "Required field toTeamId missing from ADD TransactionItem",
      "resolution": null,
      "metaData": { "teamid": 8 }
    }
  ]
}
```

`parseRejectionDetails` in `espn_api.js` extracts `details[]`. Trade responses attach it to the thrown error as `error.details`.

## `TRAN_*` codes

| Code | Meaning | Source | Fix |
|---|---|---|---|
| `TRAN_ROSTER_INELIGIBLE_IR_NOT_INJURED` | The player moved into IR slot 21 isn't OUT or INJURY_RESERVE. | **Confirmed live**, 10-06, HTTP 409 | Only move OUT or INJURY_RESERVE players to IR. |
| `TRAN_ITEM_TO_TEAM_ID_MISSING` | An `ADD` item has no `toTeamId`. | **Confirmed live**, 10-07, HTTP 409 | Send `toTeamId` on every ADD. `submitWaiverClaim` does. |
| `TRAN_ROSTER_LIMIT_EXCEEDED_ONE` | The move would put one player over the roster size. | From the bundle | Add a roster-fix `DROP`. |
| `TRAN_ROSTER_LIMIT_EXCEEDED_PLURAL` | Same, several players over. | From the bundle | Add `DROP`s. |
| `TRAN_ROSTER_LIMIT_EXCEEDED_*_LM` and trade-reserved variants | League-manager and pending-trade forms of the above. | From the bundle | — |
| `TRAN_ROSTER_POSITION_LIMIT_EXCEEDED*` | Over a position's maximum. | From the bundle | Drop a player at that position. |
| `TRAN_ROSTER_SLOT_LIMIT_EXCEEDED*` | Over a lineup slot's count. | From the bundle | Drop a player or change the slot. |

ESPN's trade builder treats any of the three `*_LIMIT_EXCEEDED*` families as "a drop is required" and asks for a roster-fix drop before resubmitting. The exact status and body of a full-roster add is still unconfirmed. The roster-limit 409 fixture in the unit tests is built from the bundle, not a capture.

:::note[Not yet seen]
No specific code for "a healthy player is blocking IR" was found in the bundles. Don't write handling for an error code until it has been captured.
:::

## Transaction history statuses

These appear in `mTransactions2` rows, not in a rejection body.

| Status | Meaning | Source |
|---|---|---|
| `EXECUTED` | The transaction went through. | Confirmed live |
| `FAILED_INVALIDPLAYERSOURCE` | A waiver claim failed because the player wasn't available from that source. | Confirmed live (history) |
| `FAILED_PLAYERALREADYDROPPED` | A claim's drop player was already gone. | Confirmed live (history) |
| `CANCELED` | A trade offer was withdrawn. | Assumed by the inbox, unverified |
| `PENDING` | Presumed status of an open trade offer. | Unverified |

## Read errors

| Response | Meaning |
|---|---|
| `LEAGUE_NOT_FOUND_DELETED` | The league is gone. Practice-draft leagues return this once the draft ends. |
| HTTP 404 on a league read | Same: the room or league no longer exists. `PermanentError`, never retried. |

## Draft-room errors

| Frame | Meaning | Worker behavior |
|---|---|---|
| `ERROR 1 Invalid+Selection.` | The pick was refused, for example because the player is already drafted. | `PermanentError`, plus a notice on `draft_pick_rejected:{leagueId}` so core can try the next player within the same clock. |
| 403 on the WebSocket upgrade | The edge refused the handshake: missing `Origin`, a non-browser `User-Agent`, or bad cookies. | See [Draft room](draft-room.md#joining-the-room). |

## How the worker classifies HTTP statuses

| Status | Error class | Retried? | Why |
|---|---|---|---|
| 401, 403 | `SessionExpiredError` | Yes, after 30 s | The session is bad, not the request. A refreshed cookie can make it succeed. |
| Other 4xx except 429 | `PermanentError` | No | ESPN definitely refused. A requeue would fail the same way and block other consumers. |
| 429, 5xx | Plain `Error` | Yes, after 5 s | Transient. For a trade response the outcome is unknown, so reconcile before retrying. |
| Network error, timeout | Plain `Error` | Yes | The write may have landed. Never retry an ambiguous write before re-reading state. |

## Related

- [Transactions endpoint](transactions.md)
- [Trades](trades.md)
- [How bots run](../how-bots-run.md)
