jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const { readRowSignals, isNotToggled } = require("../../src/lib/espn_selection_rejection");

const OPTIONS = { maxSignalChars: 300, maxHtmlChars: 2000, maxVisibleChars: 500 };

test("recognises Playwright's not-toggled wording only", () => {
  expect(isNotToggled(new Error("locator.check: Clicking the checkbox did not change its state"))).toBe(true);
  expect(isNotToggled(new Error("Timeout 30000ms exceeded"))).toBe(false);
});

// A hand-built stand-in for the few DOM members the in-page reader touches (no jsdom here).
const node = ({ attrs = {}, text = "", html = "", visible = true, children = [] } = {}) => ({
  getAttribute: (name) => attrs[name] ?? null,
  hasAttribute: (name) => name in attrs,
  textContent: text,
  outerHTML: html,
  getBoundingClientRect: () => ({ width: visible ? 10 : 0, height: visible ? 10 : 0 }),
  querySelector: () => children.find((child) => child.isBox) ?? null,
  querySelectorAll: () => children.filter((child) => child.hasAttribute("title") || child.getAttribute("aria-disabled") === "true"),
});

describe("readRowSignals", () => {
  const rowWith = ({ row = {}, box, pageNodes = [] }) => {
    const el = node({ html: "<tr>" + "x".repeat(5000) + "</tr>", ...row, children: box ? [{ ...box, isBox: true }] : [] });
    el.ownerDocument = { querySelectorAll: () => pageNodes };
    return el;
  };

  test("reads titles, disabled state and page messages, and trims the row html", () => {
    const el = rowWith({
      row: { attrs: { title: "Locked until Sunday" } },
      box: node({ attrs: { "aria-disabled": "true" } }),
      pageNodes: [node({ text: "  Trade   not allowed " }), node({ text: "hidden toast", visible: false })],
    });
    const result = readRowSignals(el, OPTIONS);
    expect(result.signals).toEqual([
      "title: Locked until Sunday",
      "disabled: checkbox is disabled",
      "page message: Trade not allowed",
    ]);
    expect(result.visibleText).toBe("Trade not allowed");
    expect(result.rowHtml).toHaveLength(2000);
  });

  test("reports no signals when the row carries none", () => {
    expect(readRowSignals(rowWith({ box: node() }), OPTIONS).signals).toEqual([]);
  });
});
