/**
 * An in-memory execution_log behind a pg-shaped Pool, with Postgres advisory transaction locks,
 * so concurrency tests can run the real trade-inbox and trade-response SQL against interleaved
 * transactions. It understands only the statements those modules issue and throws on anything
 * else, so a changed query fails loudly here instead of silently matching nothing.
 *
 * Each query yields to the event loop first, so two callers really interleave. Writes keep an undo
 * log that ROLLBACK replays, and COMMIT or ROLLBACK releases the transaction's advisory locks.
 */

function createFakeExecutionLog() {
  const rows = new Map();
  const locks = new Map();
  let wakers = [];
  let nextId = 1;
  let failures = [];

  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function reset() {
    rows.clear();
    locks.clear();
    wakers = [];
    nextId = 1;
    failures = [];
  }

  function insert(row) {
    const id = nextId++;
    rows.set(id, {
      id,
      status: null,
      league_id: null,
      season: null,
      offering_team_id: null,
      counter_offer: null,
      outcome_details: null,
      error_message: null,
      dry_run: null,
      ...row,
    });
    return id;
  }

  /** The next statement matching `pattern` throws `error`, once. */
  function failOnce(pattern, error) {
    failures.push({ pattern, error });
  }

  async function acquire(name, client) {
    for (;;) {
      const owner = locks.get(name);
      if (owner === undefined || owner === client) {
        locks.set(name, client);
        client.held.add(name);
        return;
      }
      await new Promise((resolve) => wakers.push(resolve));
    }
  }

  function releaseLocks(client) {
    for (const name of client.held) locks.delete(name);
    client.held.clear();
    const waiting = wakers;
    wakers = [];
    for (const wake of waiting) wake();
  }

  function write(client, id, changes) {
    const before = rows.get(id);
    client.undo.push(() => rows.set(id, before));
    rows.set(id, { ...before, ...changes });
  }

  const json = (value) => (typeof value === "string" ? JSON.parse(value) : value);
  const inboxRows = (league, tx) =>
    [...rows.values()].filter(
      (r) =>
        r.transaction_type === "trade_inbox" &&
        r.league_id === league &&
        (tx === undefined || r.counter_offer?.espn_transaction_id === tx),
    );
  const pick = (r) => ({ id: r.id, status: r.status, counter_offer: r.counter_offer });

  function run(client, sql, params) {
    const failure = failures.find((f) => f.pattern.test(sql));
    if (failure) {
      failures = failures.filter((f) => f !== failure);
      throw failure.error;
    }

    if (/^BEGIN$/.test(sql)) {
      client.undo = [];
      return { rows: [] };
    }
    if (/^COMMIT$/.test(sql)) {
      client.undo = [];
      releaseLocks(client);
      return { rows: [] };
    }
    if (/^ROLLBACK$/.test(sql)) {
      for (const undo of client.undo.reverse()) undo();
      client.undo = [];
      releaseLocks(client);
      return { rows: [] };
    }
    if (/^SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)$/.test(sql)) return { acquire: params[0] };

    if (/FROM execution_log\s+WHERE transaction_type = 'trade_inbox' AND league_id = \$1\s+ORDER BY id$/.test(sql)) {
      return { rows: inboxRows(params[0]).sort((a, b) => a.id - b.id).map(pick) };
    }
    if (/FROM execution_log\s+WHERE transaction_type = 'trade_inbox' AND league_id = \$1\s+AND counter_offer->>'espn_transaction_id' = \$2\s+ORDER BY id DESC( LIMIT 1)? FOR UPDATE$/.test(sql)) {
      const found = inboxRows(params[0], params[1]).sort((a, b) => b.id - a.id).map(pick);
      return { rows: /LIMIT 1/.test(sql) ? found.slice(0, 1) : found };
    }
    if (/^INSERT INTO execution_log \(transaction_type, bot_name, status, league_id, season, offering_team_id, counter_offer, dry_run\)\s+VALUES \('trade_inbox'/.test(sql)) {
      const id = insert({
        transaction_type: "trade_inbox",
        status: params[0],
        league_id: params[1],
        season: params[2],
        offering_team_id: params[3],
        counter_offer: json(params[4]),
        dry_run: true,
      });
      client.undo.push(() => rows.delete(id));
      return { rows: [{ id }] };
    }
    if (/^UPDATE execution_log SET status = \$2, counter_offer = \$3::jsonb, offering_team_id = \$4\s+WHERE id = \$1$/.test(sql)) {
      write(client, params[0], { status: params[1], counter_offer: json(params[2]), offering_team_id: params[3] });
      return { rows: [], rowCount: 1 };
    }

    if (/FROM execution_log\s+WHERE transaction_type = 'trade_response' AND league_id = \$1\s+AND counter_offer->>'espn_transaction_id' = \$2\s+AND status = ANY\(\$3\)/.test(sql)) {
      return {
        rows: [...rows.values()]
          .filter(
            (r) =>
              r.transaction_type === "trade_response" &&
              r.league_id === params[0] &&
              r.counter_offer?.espn_transaction_id === params[1] &&
              params[2].includes(r.status),
          )
          .sort((a, b) => b.id - a.id)
          .map((r) => ({ id: r.id, status: r.status, decision_key: r.counter_offer.decision_key })),
      };
    }
    if (/FROM execution_log\s+WHERE transaction_type = 'trade_response'\s+AND counter_offer->>'decision_key' = \$1\s+AND status = ANY\(\$2\)/.test(sql)) {
      const order = params[1];
      const found = [...rows.values()]
        .filter((r) => r.transaction_type === "trade_response" && r.counter_offer?.decision_key === params[0] && order.includes(r.status))
        .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.id - a.id)
        .map((r) => ({
          id: r.id,
          status: r.status,
          espn_transaction_id: r.counter_offer.espn_transaction_id,
          action: r.counter_offer.action,
        }));
      return { rows: found.slice(0, 1) };
    }
    if (/^INSERT INTO execution_log \(transaction_type, bot_name, status, league_id, season, offering_team_id, counter_offer, dry_run\)\s+VALUES \(\$1, \$2, 'responding'/.test(sql)) {
      const id = insert({
        transaction_type: params[0],
        bot_name: params[1],
        status: "responding",
        league_id: params[2],
        season: params[3],
        offering_team_id: params[4],
        counter_offer: json(params[5]),
        dry_run: false,
      });
      client.undo.push(() => rows.delete(id));
      return { rows: [{ id }] };
    }
    if (/^UPDATE execution_log SET status = 'superseded', counter_offer = counter_offer \|\| \$3::jsonb\s+WHERE id = \$1 AND transaction_type = 'trade_response' AND status = \$2\s+RETURNING id$/.test(sql)) {
      const row = rows.get(Number(params[0]));
      if (!row || row.transaction_type !== "trade_response" || row.status !== params[1]) return { rows: [] };
      write(client, row.id, { status: "superseded", counter_offer: { ...row.counter_offer, ...json(params[2]) } });
      return { rows: [{ id: row.id }] };
    }
    if (/^UPDATE execution_log SET status = \$2, error_message = \$3\s+WHERE id = \$1 AND transaction_type = 'trade_response' AND status = ANY\(\$4\)\s+RETURNING id$/.test(sql)) {
      const row = rows.get(Number(params[0]));
      if (!row || row.transaction_type !== "trade_response" || !params[3].includes(row.status)) return { rows: [] };
      write(client, row.id, { status: params[1], error_message: params[2] });
      return { rows: [{ id: row.id }] };
    }
    if (/^INSERT INTO execution_log \(transaction_type, bot_name, status, league_id, season, offering_team_id, counter_offer, dry_run\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, true\)$/.test(sql)) {
      insert({
        transaction_type: params[0],
        bot_name: params[1],
        status: params[2],
        league_id: params[3],
        season: params[4],
        offering_team_id: params[5],
        counter_offer: json(params[6]),
        dry_run: true,
      });
      return { rows: [] };
    }
    throw new Error(`fake execution_log: unsupported SQL: ${sql}`);
  }

  function newClient() {
    const client = { held: new Set(), undo: [] };
    client.query = async (sql, params = []) => {
      await tick();
      const result = run(client, sql.trim(), params);
      if (result.acquire !== undefined) {
        await acquire(result.acquire, client);
        return { rows: [{}] };
      }
      return result;
    };
    client.release = () => {};
    return client;
  }

  function pool() {
    return {
      connect: async () => newClient(),
      // Autocommit: a single statement in its own transaction.
      query: async (sql, params) => {
        const client = newClient();
        try {
          return await client.query(sql, params);
        } finally {
          releaseLocks(client);
        }
      },
      on: () => {},
    };
  }

  const all = () => [...rows.values()];
  const ofType = (type) => all().filter((r) => r.transaction_type === type);

  return { reset, insert, failOnce, pool, rows: all, ofType, locksHeld: () => locks.size };
}

const fakeExecutionLog = createFakeExecutionLog();

module.exports = { fakeExecutionLog, createFakeExecutionLog };
