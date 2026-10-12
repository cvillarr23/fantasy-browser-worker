---
title: Read views
description: The ESPN REST read endpoints and view parameters the worker uses, what each returns, and which are unreliable.
sidebar_position: 2
---

Every league read is a GET on the reads host with one or more `view=` parameters. Use this page to pick the right view and to learn which ones lie during a practice draft.

```text
GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{seasonId}/segments/0/leagues/{leagueId}?view=mRoster&view=mSettings&view=mTeam
```

`buildLeagueReadUrl` in `espn_api.js` builds this URL. The request carries the `espn_s2` and `SWID` cookies from the browser context.

## Which view returns what?

| View | Returns | Used by | Confidence |
|---|---|---|---|
| `mRoster` | `teams[].roster.entries[]`: `playerId`, `lineupSlotId`, `playerPoolEntry.player.{fullName, defaultPositionId, injuryStatus}` | `readRoster`, `readRosters` | Confirmed live |
| `mSettings` | `settings.rosterSettings.lineupSlotCounts` (the league's slot shape) and `scoringPeriodId` | `readRoster`, `fetchDraftTotals` | Confirmed live, 08-11 |
| `mTeam` | `teams[]` with `lineupLocked`, `rosterLocked` and `transactionCounter` | `readRoster`, session checks | Confirmed live |
| `mPendingTransactions` | `pendingTransactions[]`. **The key is missing when nothing is pending.** | `readPendingTrades` | Empty state confirmed live, 10-03. Populated shape unverified. |
| `mTransactions2` | Executed history: `transactions[]` with `type`, `status`, `relatedTransactionId`, `items[]` | `readTradeHistory` | Confirmed live, 10-03 |
| `draftInit` | Full player catalog with `defaultPositionId`, `proTeamId`, `draftRanksByRankType.STANDARD.rank`, `ownership.percentOwned` | `fetchDraftPlayerPool` | Confirmed live, works in practice drafts |
| `mDraftDetail` | `draftDetail.picks[]` with `overallPickNumber` | `readDraftPicks`, `draft_sync.js` | **Unreliable for practice drafts** (see below) |
| `kona_league_communication` | League activity feed and chat as `topics[]` | `readLeagueChat` | Confirmed live, 10-03 |

:::warning[A missing key means empty]
ESPN omits an empty array rather than returning `[]`. Treat a missing `pendingTransactions` (or `transactions`) key as no rows. `readPendingTrades` reads both key names because the populated shape hasn't been seen yet.
:::

## Filtering with `x-fantasy-filter`

Some views accept a JSON filter in the `x-fantasy-filter` request header. ESPN honored both of these live. The worker filters the response again anyway.

| View | Filter |
|---|---|
| `mTransactions2` | `{"transactions":{"filterType":{"value":["TRADE_PROPOSAL","TRADE_ACCEPT","TRADE_DECLINE","TRADE_VETO","TRADE_UPHOLD"]}}}` |
| `kona_league_communication` | `{"topics":{"filterType":{"value":["CHAT_ALL_MEMBERS"]}, …}}` |

Without a `scoringPeriodId` query parameter, `mTransactions2` appears scoped to the current scoring period. Pass `&scoringPeriodId={n}` to read an earlier week.

## League chat without the iframe

`GET …/leagues/{leagueId}/communication/?view=kona_league_communication` returns the activity feed as `topics[]`.

| Topic | Contains |
|---|---|
| `ACTIVITY_TRANSACTIONS` | Adds, drops and trades |
| `ACTIVITY_SETTINGS` | League settings changes |
| `CHAT_ALL_MEMBERS` | League chat posts, with `messages[].{author, date, for, to, messageTypeId}` |

ESPN's league-manager posts carry `author: "LM"` and `content: null` for templated cards. No member post had been seen when this was recorded, so the member-post shape is unconfirmed.

<details>
<summary>Why not read the chat iframe?</summary>

- The clubhouse chat iframe (`iframe.chat--container--iframe`) exists only after you click the toggle `span.chat--container--header--title`.
- It loads `https://chat.espn.com/1/{leagueId}/{season}/0/directory`, which is the **room list**, not a message feed. It renders about 1 s after the click.
- Reading `body.innerText` straight after the click returns an empty string or the room list.

The REST feed avoids all of this, so `trade_bot.js` no longer navigates the clubhouse.

</details>

## `mDraftDetail` is unreliable for practice drafts

Confirmed live on 08-16 and 08-17: during a practice draft, `mDraftDetail` returned **zero picks** while the WebSocket confirmed every pick. After the draft, it returned an empty `draftDetail`. The [`cwendt94/espn-api` maintainer](https://github.com/cwendt94/espn-api/issues/558) reports the same thing: live drafts use a separate backend.

:::warning[Unverified for real league drafts]
Whether `mDraftDetail` works for a real, persisted league draft is still unverified.
:::

- `draftInit` and `mSettings` + `mTeam` kept working in the same rooms, because they read season data, not draft-instance state.
- Once a practice draft ends, these reads return `LEAGUE_NOT_FOUND_DELETED`.
- See [Draft room](draft-room.md) for how the worker copes.

## Other endpoints

| Endpoint | Purpose |
|---|---|
| `…/leagues/{leagueId}/teams/{teamId}/draftSecurity` | Part of the draft room's bootstrap. 200 means the session may act for that team. |
| `…/leaguedirectory/MOCKDRAFT_LOBBY` | Polled by the mock draft lobby while it waits to join a room. |

## Related

- [Transactions endpoint](transactions.md)
- [Trades](trades.md)
- [Draft room](draft-room.md)
