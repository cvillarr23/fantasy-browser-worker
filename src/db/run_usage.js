// A launcher run's own CPU and memory usage, recorded as run_log.summary.resources. It mirrors
// fantasy-core-pipeline's src/run_usage.py; keep the two record shapes the same, since core's
// GET /v1/jobs/resource-suggestions reads both.
//
// The run measures itself as it finishes because most launcher pods live a few seconds, shorter
// than one cAdvisor scrape. A pod runs one job, so its container's cgroup (v2) is the run's
// usage, Chromium's child processes included: cpu.stat usage_usec/throttled_usec, memory.peak,
// and cpu.max/memory.max as limits. An inline run (RUN_EXECUTOR=inline) shares the launcher's
// cgroup, and a pod without cgroup v2 has nothing better, so both fall back to
// process.resourceUsage(), which counts this node process only (source "rusage").
const fs = require("fs");
const path = require("path");
const { logger } = require("../telemetry/logger");

const CGROUP_ROOT = "/sys/fs/cgroup";

/** summary.resources for this run, or null when nothing could be read. */
function measureRunUsage(
  attempt,
  wallSeconds,
  { cgroupRoot = CGROUP_ROOT, env = process.env } = {},
) {
  try {
    const usage =
      (env.RUN_EXECUTOR !== "inline" && cgroupUsage(cgroupRoot)) ||
      processUsage();
    return {
      ...usage,
      attempt,
      wall_seconds: Math.round(wallSeconds * 1000) / 1000,
    };
  } catch (err) {
    logger.warn("Could not measure this run's resource usage", { err });
    return null;
  }
}

function cgroupUsage(root) {
  const cpuStat = path.join(root, "cpu.stat");
  const memoryPeak = path.join(root, "memory.peak");
  if (!fs.existsSync(cpuStat) || !fs.existsSync(memoryPeak)) return null;
  const stats = parseCpuStat(fs.readFileSync(cpuStat, "utf8"));
  const peak = Number.parseInt(fs.readFileSync(memoryPeak, "utf8").trim(), 10);
  if (!Number.isFinite(peak))
    throw new Error(`Unreadable memory.peak in ${root}`);
  return {
    source: "cgroup",
    cpu_seconds: (stats.usage_usec || 0) / 1e6,
    cpu_throttled_seconds: (stats.throttled_usec || 0) / 1e6,
    peak_memory_bytes: peak,
    limits: {
      cpu_cores: cpuLimit(path.join(root, "cpu.max")),
      memory_bytes: memoryLimit(path.join(root, "memory.max")),
    },
  };
}

function parseCpuStat(text) {
  const stats = {};
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined) stats[key] = Number(value);
  }
  return stats;
}

/** cpu.max ("<quota> <period>" or "max <period>") as cores, null when unlimited. */
function cpuLimit(file) {
  if (!fs.existsSync(file)) return null;
  const [quota, period] = fs.readFileSync(file, "utf8").trim().split(/\s+/);
  return quota === "max" ? null : Number(quota) / Number(period);
}

function memoryLimit(file) {
  if (!fs.existsSync(file)) return null;
  const value = fs.readFileSync(file, "utf8").trim();
  return value === "max" ? null : Number(value);
}

/** This node process only: resourceUsage() times are microseconds and maxRSS is KiB. */
function processUsage() {
  const usage = process.resourceUsage();
  return {
    source: "rusage",
    cpu_seconds: (usage.userCPUTime + usage.systemCPUTime) / 1e6,
    peak_memory_bytes: usage.maxRSS * 1024,
  };
}

module.exports = { measureRunUsage };
