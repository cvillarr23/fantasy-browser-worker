jest.mock("../../src/telemetry/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock("../../src/db/run_log", () => ({ isLauncherRun: jest.fn(), openApproval: jest.fn() }));
const { logger } = require("../../src/telemetry/logger");
const runLog = require("../../src/db/run_log");
const {
  openOfferApproval,
  approvalExpiry,
  resetOfferApprovals,
  APPROVAL_TTL_MS,
} = require("../../src/lib/offer_approvals");

const offer = { toTeamId: "3", incomingPlayerIds: ["1"], outgoingPlayerIds: ["2", "4"] };
// A Wednesday 13:00 Chicago scan.
const staged = new Date("2026-11-18T19:00:00Z");
const friday = new Date("2026-11-20T19:00:00Z");

function jobs(nextRunAt) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ jobs: [{ name: "lineup-optimizer", next_run_at: null }, { name: "trade-scan", next_run_at: nextRunAt }], chains: [] }),
  }));
}

beforeEach(() => {
  resetOfferApprovals();
  runLog.isLauncherRun.mockReturnValue(true);
  runLog.openApproval.mockResolvedValue({ id: "approval-1", opened: true });
});
afterEach(() => {
  delete global.fetch;
});

describe("approvalExpiry", () => {
  it("is the next scan when that comes within 72h", () => {
    expect(approvalExpiry(staged, friday)).toEqual(friday);
  });

  it("is 72h after staging when the next scan is later (Friday to Wednesday)", () => {
    const fridayScan = friday;
    const wednesday = new Date("2026-11-25T19:00:00Z");
    expect(approvalExpiry(fridayScan, wednesday)).toEqual(new Date(fridayScan.getTime() + APPROVAL_TTL_MS));
  });

  it("is 72h without a usable next scan", () => {
    const cap = new Date(staged.getTime() + APPROVAL_TTL_MS);
    expect(approvalExpiry(staged, null)).toEqual(cap);
    expect(approvalExpiry(staged, new Date(staged.getTime() - 1))).toEqual(cap);
  });
});

describe("openOfferApproval", () => {
  it("opens an approval that starts trade-submit for the offer", async () => {
    jobs(friday.toISOString());
    await openOfferApproval({ scanRunId: "scan-1", offerKey: "key-1", offer, now: staged });
    expect(runLog.openApproval).toHaveBeenCalledWith({
      runId: "scan-1",
      key: "key-1",
      title: "Send trade to team 3: give 2, get 1",
      link: "/trades?offer=key-1",
      then: { job: "trade-submit", params: { offer_key: "key-1" } },
      expiresAt: friday,
    });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/jobs$/), expect.anything());
  });

  it("reads the next scan once per process", async () => {
    jobs(friday.toISOString());
    await openOfferApproval({ scanRunId: "scan-1", offerKey: "key-1", offer, now: staged });
    await openOfferApproval({ scanRunId: "scan-1", offerKey: "key-2", offer, now: staged });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to 72h when core can't say when the next scan is", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    await openOfferApproval({ scanRunId: "scan-1", offerKey: "key-1", offer, now: staged });
    expect(runLog.openApproval.mock.calls[0][0].expiresAt).toEqual(new Date(staged.getTime() + APPROVAL_TTL_MS));
    expect(logger.warn).toHaveBeenCalled();
  });

  it("opens nothing outside a launcher run, logging it once", async () => {
    runLog.isLauncherRun.mockReturnValue(false);
    jobs(friday.toISOString());
    await expect(openOfferApproval({ scanRunId: "local-run", offerKey: "key-1", offer })).resolves.toBeNull();
    await openOfferApproval({ scanRunId: undefined, offerKey: "key-2", offer });
    expect(runLog.openApproval).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
