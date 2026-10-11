---
title: Message contracts
description: Every RabbitMQ queue the worker consumes, who publishes to it, and the JSON each message must carry.
sidebar_position: 4
---

Use the [queue contract explorer](/reference/queues) for the six queues published by core: schemas, required fields and placeholder examples. The maintained source is core's [AsyncAPI spec](https://github.com/cvillarr23/fantasy-core-pipeline/blob/main/docs/asyncapi.yaml); this page describes consumers, queue ownership and worker-only messages.

:::warning[Injury alerts are not claims]
`waiver_actions` also carries `INJURY_STATUS_CHANGE` alerts from player sync. Those use Sleeper player IDs and have no tracking or trace context. API claims use ESPN player IDs.
:::

```mermaid
flowchart LR
    subgraph core["core pipeline"]
        lu["POST /v1/trigger/lineup"]
        wa["POST /v1/trigger/waiver"]
        dp["POST /v1/trigger/draft-pick"]
        ps["player sync"]
        ti["trade inbox service"]
        to["trade offer service"]
    end
    lu --> q1(["lineup_updates"])
    wa --> q2(["waiver_actions"])
    ps --> q2
    dp --> q3(["draft_targets"])
    ti --> q4(["trade_responses"])
    ti --> q5(["trade_negotiations"])
    to --> q6(["trade_submissions"])
    worker["worker"] --> q7(["llm_requests"])
```

## Which queues exist?

| Queue | Publisher | Consumer | Declared by | KEDA trigger |
|---|---|---|---|---|
| `lineup_updates` | Core `/v1/trigger/lineup` | [Lineup](bots/lineup.md) | Broker | Yes |
| `waiver_actions` | Core `/v1/trigger/waiver`, player sync | [Waiver sniper](bots/waiver-sniper.md) | Broker | Yes |
| `draft_targets` | Core `/v1/trigger/draft-pick` | [Draft clicker](bots/draft-clicker.md) | Broker | Yes |
| `trade_evaluations` | None scheduled | [Trade evaluation](bots/trade-evaluation-and-negotiation.md) | Worker | Yes |
| `trade_negotiations` | Core trade inbox service | [Trade negotiation](bots/trade-evaluation-and-negotiation.md) | Worker | Yes |
| `trade_proposals` | None | [Trade proposal](bots/trade-proposal-and-scan.md) | Worker | **No** |
| `trade_submissions` | Core trade offer service | [Trade builder](bots/trade-builder.md) | Worker | Yes |
| `trade_responses` | Core trade inbox service | [Trade response](bots/trade-response.md) | Worker | Yes |
| `llm_requests` | The worker (`requestLlmAsync`) | [Async LLM](bots/async-llm-requests.md) | Worker | Yes |

"Broker" queues are declared by the broker's definitions and policy. The worker only checks that they exist. "Worker" queues are declared durable by whoever connects first.




## How are deliveries handled?

Worker processing and result reporting are described in [How bots run](how-bots-run.md). Core trigger messages arrive through a durable outbox; trade publications use durable claims and require reconciliation when delivery is uncertain. See [Core delivery, idempotency and retries](/core/queue-publishing).

## `trade_evaluations`

| Field | Type | Required | Notes |
|---|---|---|---|
| `incoming_player_ids` | string[] | Yes | Non-empty. Core's internal ids. |
| `outgoing_player_ids` | string[] | Yes | Non-empty. No id on both sides. |
| `season`, `week` | integer | Yes | |
| `tracking_id` | string | No | |


## `trade_proposals`

| Field | Type | Required | Notes |
|---|---|---|---|
| `season` | integer | Yes | 2000 or later. |
| `week` | integer | Yes | 1 to 18. |
| `exclude_team_ids` | string[] | No | ESPN team ids. |
| `tracking_id` | string | No | |

:::warning
Nothing publishes here and no trigger wakes a worker for it. Use the trade scan CronJob.
:::



## `llm_requests`

| Field | Type | Required | Notes |
|---|---|---|---|
| `request_id` | string | Yes | UUID matching the `llm_async_requests` row. |
| `prompt` | string | Yes | |
| `opts` | object | No | Passed to `completeWithFallback`, for example `systemPrompt` and `callSite`. |

## Not queues

Two bots take no queue message.

| Job | Input |
|---|---|
| Trade inbox | CLI flags. |
| Rumor digest | Database rows. |

Draft sync and the draft clicker also talk over Redis. See [Draft sync](bots/draft-sync.md) for those keys.

## Related

- [How bots run](how-bots-run.md)
- [Bots](bots/index.md)
