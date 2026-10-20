// index.js boots the daemon at require time, so every dependency is mocked and the message
// handler is captured from the initializeQueueConsumer call.
jest.mock("../src/db/activity", () => ({
  claim: jest.fn().mockResolvedValue(true),
  release: jest.fn().mockResolvedValue(undefined),
  event: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/queue/connection", () => ({
  initializeQueueConsumer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/bots/lineup_bot", () => ({
  executeLineupAdjustments: jest.fn(),
}));
jest.mock("../src/bots/waiver_sniper", () => ({
  executeInstantWaiverClaim: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/bots/draft_clicker", () => ({
  executeAutomatedDraftSelection: jest.fn(),
}));
jest.mock("../src/bots/trade_bot", () => ({
  executeTradeEvaluation: jest.fn(),
  negotiateTradeProposal: jest.fn(),
}));
jest.mock("../src/bots/trade_proposal", () => ({
  generateTradeProposal: jest.fn(),
}));
jest.mock("../src/bots/trade_builder", () => ({
  executeTradeSubmission: jest.fn(),
}));
jest.mock("../src/bots/trade_response", () => ({
  executeTradeResponse: jest.fn(),
}));
jest.mock("../src/lib/llm_async_queue", () => ({
  processAsyncLlmRequest: jest.fn(),
}));
jest.mock("../src/telemetry/instrument", () => ({
  withInstrumentation: jest.fn((_name, _ctx, handler) => handler()),
}));
jest.mock("../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../src/telemetry/init", () => ({
  shutdownTelemetry: jest.fn().mockResolvedValue(undefined),
}));

const activity = require("../src/db/activity");
const { initializeQueueConsumer } = require("../src/queue/connection");
const { executeInstantWaiverClaim } = require("../src/bots/waiver_sniper");

require("../src/index");
const handleIncomingMessage = initializeQueueConsumer.mock.calls[0][0];

beforeEach(() => {
  activity.claim.mockClear();
  executeInstantWaiverClaim.mockClear();
});

test("acks an ingestor injury alert on waiver_actions without claiming or running the sniper", async () => {
  const alert = {
    event_type: "INJURY_STATUS_CHANGE",
    player_id: "13294",
    name: "Makai Lemon",
    team: "PHI",
    new_injury_status: "Questionable",
  };

  await expect(handleIncomingMessage("waiver_actions", alert)).resolves.toBe(
    true,
  );

  expect(activity.claim).not.toHaveBeenCalled();
  expect(executeInstantWaiverClaim).not.toHaveBeenCalled();
});

test("still routes a real waiver claim to the sniper", async () => {
  const claim = {
    player_id: "4832800",
    drop_player_id: "4432773",
    team_id: "8",
  };

  await expect(handleIncomingMessage("waiver_actions", claim)).resolves.toBe(
    true,
  );

  expect(activity.claim).toHaveBeenCalledWith("waiver_actions", claim);
  expect(executeInstantWaiverClaim).toHaveBeenCalledWith(claim);
});
