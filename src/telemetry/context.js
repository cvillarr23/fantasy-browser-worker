const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

// Merges onto whatever context is already active, so nested runWithContext calls (e.g. the
// per-message queue context wrapping the per-job withInstrumentation context) accumulate fields
// instead of one replacing the other.
function runWithContext(fields, fn) {
  const parent = als.getStore() || {};
  return als.run({ ...parent, ...fields }, fn);
}

function getContext() {
  return als.getStore() || {};
}

// Lets code deep in a call stack (e.g. draft_clicker.js learning teamId/playerId partway through
// execution) add fields to the *active* context without needing a new runWithContext nesting or
// threading those values through every intermediate function call.
function updateContext(fields) {
  const store = als.getStore();
  if (store) Object.assign(store, fields);
}

module.exports = { runWithContext, getContext, updateContext };
