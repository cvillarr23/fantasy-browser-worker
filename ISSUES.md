# GitHub Issues Template Backlog: fantasy-browser-worker

This index charts required browser execution automation routines.

---

## [WORKER-01] Assemble RabbitMQ Inbound Event Router Daemon
*   **Priority**: High 🔥
*   **Milestone**: Phase 1 - Queue Integration
*   **Tags**: `area/queue`, `component/amqp`, `type/feature`

### Description
Implement the core background listener loop inside `src/index.js` utilizing `amqplib`. This service acts as an active listener within the cluster, capturing structural payload patterns from RabbitMQ and routing them to localized browser worker functions.

### Technical Tasks
- [ ] Establish connection loops logging into the internal cluster RabbitMQ service endpoint.
- [ ] Connect tracking handlers targeting specific functional channels (`waiver_actions`, `lineup_updates`).
- [ ] Configure execution guards allowing only `1` sequential transaction to fire at once to insulate the 1200MiB pod memory threshold.

---

## [WORKER-02] Engineer Headless Lineup Optimization Adjuster Bot
*   **Priority**: High 🔥
*   **Milestone**: Phase 2 - Roster Execution
*   **Tags**: `area/automation`, `component/playwright`, `type/feature`

### Description
Program the core browser script that logs into the ESPN portal using cookies and executes active lineup swaps. This bot reads roster matrix targets outputted by the optimization engine and moves sub-optimal options directly to the bench.

### Technical Tasks
- [ ] Author `src/bots/lineup_bot.js` passing secure cookie states to the Chromium context wrapper.
- [ ] Extract layout selectors from the isolated `espn_selectors.json` configuration asset map.
- [ ] Implement robust error validation routines that close the browser process gracefully if ESPN emits unexpected modal popups.

---

## [WORKER-03] Code Real-Time Live Draft Room Stream Synchronization Worker
*   **Priority**: Medium ⚡
*   **Milestone**: Phase 5 - Pre-Season Processing
*   **Tags**: `area/automation`, `component/draft`, `type/feature`

### Description
Build the high-speed connection bot engineered to sit inside the live ESPN draft room window. This utility scrapes dynamic tracker logs or tracks web activity parameters, pushing real-time picked player profiles to your cluster state engines.

### Technical Tasks
- [ ] Create `src/bots/draft_sync.js`.
- [ ] Implement DOM mutation structural hooks or network intercept monitors to detect picked tokens instantly.
- [ ] Construct rapid notification interfaces passing taken identities straight into your central Redis database keyspace.

---

## [WORKER-04] Implement Instant Free-Agent Waiver Sniper Bot
*   **Priority**: High 🔥
*   **Milestone**: Phase 3 - Tactical Speed
*   **Tags**: `area/automation`, `component/sniper`, `type/feature`

### Description
Program the low-latency add/drop waiver execution micro-script. The moment a critical status-differential is parsed from data streams, this bot bursts onto ESPN to lock down specific target assets before rival human managers open their applications.

### Technical Tasks
- [ ] Create `src/bots/waiver_sniper.js`.
- [ ] Optimize loading paths by explicitly blocking heavy image and media assets during context configuration setups (`page.route`).
- [ ] Test transactional click paths running through player searches, transaction locks, and confirmation panels.
