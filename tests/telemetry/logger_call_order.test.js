const fs = require("fs");
const path = require("path");

// src/telemetry/logger.js wraps pino as logger.<level>(message, extra). A call written in pino's
// own order, logger.info({ ... }, "message"), makes pino print the string and drop the object, so
// the fields that explain a decision silently vanish from the logs.
const SRC_DIR = path.join(__dirname, "..", "..", "src");
const OBJECT_FIRST_CALL = /logger\.(?:trace|debug|info|warn|error|fatal)\(\s*\{/g;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

describe("logger call order", () => {
  it("passes the message first and the structured fields second", () => {
    const offenders = sourceFiles(SRC_DIR).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return [...text.matchAll(OBJECT_FIRST_CALL)].map((match) => {
        const line = text.slice(0, match.index).split("\n").length;
        return `${path.relative(SRC_DIR, file)}:${line}`;
      });
    });
    expect(offenders).toEqual([]);
  });
});
