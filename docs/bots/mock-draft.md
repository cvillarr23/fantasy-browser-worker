---
title: Mock draft helper
description: What mock_draft.js does for draft sync and why headless practice drafts need a pre-opened room URL.
sidebar_position: 6
---

`mock_draft.js` is a helper, not a bot. Draft sync calls it when `DRAFT_MODE=mock` to open ESPN's mock draft lobby and start a practice draft.

:::warning[Headless auto-join does not work]
ESPN's lobby embeds an invisible reCAPTCHA Enterprise check. A headless browser is scored as automated, so the "Practice Draft" click never navigates. Join a practice draft in a real browser and pass its URL in `DRAFT_ROOM_URL`.
:::

## What does it do?

| Function | Purpose |
|---|---|
| `startFreshPracticeDraft` | Opens the mock draft lobby, clicks "Practice Draft" and returns the draft room's `url` and `page`. |
| `parseDraftRoomUrl` | Pulls `leagueId`, `seasonId`, `teamId` and `memberId` out of a draft room URL. |

The click is retried 3 times across selector strategies (button, link, text), 2 s apart, with 5 s per attempt. A headless run that exhausts its attempts throws `HeadlessLobbyJoinError` instead of waiting for a person.

## Related

- [Draft sync](draft-sync.md)
- [ESPN reverse-engineering notes](../espn-reverse-engineering.md)
