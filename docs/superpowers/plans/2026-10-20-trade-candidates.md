# Scored trade candidates implementation plan

> Execute inline with test-first verification.

**Goal:** Implement fantasy-browser-worker#204 using the shipped core candidate contract.

**Architecture:** Read proposable candidates before invoking the deficit-based LLM fallback. Select the best stored package per counterparty, at most three, preferring bye partners within 5% of the best remaining stored final score. Live-score those packages and reuse existing eligibility, ranking, grounded pitches and staging. Record the source in evaluation ranking.

**Tech stack:** CommonJS JavaScript, fetch, Jest, ESLint.

**Spec:** GitHub issue cvillarr23/fantasy-browser-worker#204 and core docs/decision-pipelines/trade-candidates.md plus docs/openapi.json.

## Constraints and review focus

- ESPN ids remain strings; candidate players' internal ids never cross into score requests.
- List computed_at must be valid and at most 36 hours old; unavailable, empty or stale data invokes the existing LLM path and logs why.
- Candidates do not depend on deficit targets; excluded counterparties remain excluded.
- Re-score failure or gate drift skips the selected alternative without replacement or LLM fallback.
- Bound live scores to three; page reads so repeated counterparties cannot hide alternatives.
- Preserve ranking and staging behavior; use named policy constants.

## Task 1: Candidate read and selection

- [x] Add failing HTTP tests for explicit status/sort, pagination, 404/errors and freshness boundaries.
- [x] Add a candidate reader with bounded timeouts, list validation and fallback reasons.
- [x] Add failing proposal tests for distinct counterparties, bye preference, exclusions and deficit-independent selection.
- [x] Implement candidate selection and route packages into existing live-score/ranking logic, with ranking.source.

## Task 2: Fail-closed staging and verification

- [x] Add and run tests for ownership changes, changed gates, unavailable live scores, each fallback trigger, and scan offersStaged counts.
- [x] Update trade-proposal-and-scan documentation.
- [x] Run full Jest suite, ESLint and git diff --check; review changed application literals and README restrictions.
- [x] Review the diff and report deployment/manual scan validation still required by the issue.
