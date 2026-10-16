---
title: Trade proposal and scan
description: How the worker finds a weak position on another team, scores candidate trades with core and stages the best one for approval.
sidebar_position: 8
---

The trade scan CronJob runs the proposal generator twice a week. The generator picks targets, asks an LLM for candidate packages, scores each with core, and stages the best package for each of up to 3 teams, best first. A person must approve each one before anything is sent.

```mermaid
flowchart TD
    cron["trade-scan CronJob\nWed + Fri 13:00 Chicago"] --> gate{"regular season,\nweeks 1-18?"}
    gate -->|no| noop["no-op"]
    gate -->|yes| claim["claim today's scan\n(advisory lock + execution_log)"]
    claim --> inbox["refresh trade inbox"]
    inbox --> target["rank weak positions\n(up to 3 teams, + 2 bye partners)"]
    target --> ctx["core: GET /v1/trade/context"]
    ctx --> llm1["LLM: up to 8 candidate packages"]
    llm1 --> score["core: POST /v1/trade/score\nper package"]
    score --> rank["rank useful packages"]
    rank --> llm2["LLM: pitch from evidence\n(best package per team, up to 3)"]
    llm2 --> stage["trade builder: stage each offer"]
```

## What starts it?

| Path | Use |
|---|---|
| `trade-scan` CronJob runs `node src/bots/trade_scan.js --stage` | Production. Wednesday and Friday at 13:00 America/Chicago. |
| `node src/bots/trade_scan.js --check` | Safe check. Reads the calendar only. No claim, database write, browser or LLM. |
| `trade_proposals` queue | The consumer exists, but there is no KEDA trigger and no producer. Don't use it. |

The Sleeper NFL state API supplies `season` and `week`. Preseason, postseason, week 0 and February to August are successful no-ops. Stale or invalid season data fails closed. This is a calendar gate, not an ESPN trade-deadline check, so suspend the CronJob when trading closes.

## What does the message contain?

| Field | Required | Notes |
|---|---|---|
| `season` | Yes | Integer, 2000 or later. |
| `week` | Yes | Integer, 1 to 18. |
| `exclude_team_ids` | No | Array of ESPN team ids to skip. |
| `tracking_id` | No | |

## How is a package chosen?

A position counts as weak when a team is short of starters there, or its `net_vorp` is below the league average for it. The worker keeps the worst weakness on each of up to 3 teams. When our bye outlook has crunch weeks, it adds up to 2 more teams with a weakness whose own crunch weeks miss ours, marked `bye_partner`, so the model sees partners that can spare a starter for our empty weeks.

A package is useful only if all of these hold:

- Our lineup gain is positive.
- The counterparty's lineup doesn't get worse.
- Neither roster goes over its limit.
- Every traded player is mapped.
- At least one horizon week was scored.

The best useful package for each counterparty is staged, up to 3, each with its own pitch and its `rank` in the evaluation. A package whose pitch is rejected or whose evaluation is too large is skipped, and the next one is still staged. Useful packages rank by schedule-weighted `final_score` first, then by value per scored week, then by more scored weeks, a complete horizon and the larger counterparty change. Unscored weeks are unknown, never zero.

The package prompt includes each player's `nfl_bye_week` and the bye outlook (crunch weeks) of our team and of each target team, all from the trade context. The model is asked to prefer packages that cover our crunch weeks, ideally with a partner whose crunch weeks differ from ours, and never to move a player over a single bye. Ranking still uses only core's score, which already counts every bye week of the horizon.

The pitch comes from a second LLM call that sees only counterparty-facing evidence. That evidence includes any of their bye crunch weeks the trade covers (`bye_coverage.counterparty.fixed`). It must cite evidence ids and may not state a number outside that evidence.

## What does a run return?

| Result | Meaning |
|---|---|
| `no_target` | No team has a weak position to target. |
| `no_offer` with a `reason` | `no_packages`, `no_valid_packages`, `no_useful_offer`, `pitch_rejected` or `evaluation_too_large` (the first alternative's reason, when every alternative failed). Nothing is staged. |
| Staged offers | The result keeps the best offer's `target`, `offer`, `evaluation` and `submission` at the top level, and lists every staged one in `offers`. The scan reports `offersStaged`. Each row carries `counter_offer.evaluation` (version `proposal-evaluation-v1`) with the exact score request, the verbatim score, the ranking and the pitch. |
| Error | Core couldn't score any package. Nothing is ever staged unscored. |

A staging failure returns `fill_failed` with the computed offer instead of regenerating on a retry. A failure on any alternative fails the CronJob.

## How is a repeat run prevented?

An atomic Postgres advisory lock and a durable `trade_scan_claim` row in `execution_log` allow one attempt per league, team and Chicago calendar date. The claim persists on no-target, no-offer, error and timeout. There are no automatic retries, because a different pitch has a different approval key.

The CLI has a 15-minute hard deadline. The CronJob uses `backoffLimit: 0`, forbids concurrent runs and bounds runtime to 16 minutes.

## What can go wrong?

| Failure | Result |
|---|---|
| Invalid `season`/`week`, or `ESPN_LEAGUE_ID`/`ESPN_TEAM_ID` not a positive id | `PermanentError` |
| Core can't score any package | Error, nothing staged, CronJob exits non-zero |
| LLM or core read failure on the queue path | Delayed retry |
| Same-day second run | Refused by the claim |

## Related

- [Trade builder](trade-builder.md)
- [Trade inbox](trade-inbox.md)
