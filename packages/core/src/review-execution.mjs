// Shared review execution settings and receipt formatting. Harness launch
// resolution lives in review-executor.mjs plus the selected executor module
// (the bundled reference is executors/pi-cli.mjs), so the engine never depends
// on a particular agent CLI.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT = 180000;
const MAX_TIMEOUT = 1800000;
export const REVIEW_THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export function reviewTimeout(value) {
  const timeout = value === undefined || value === "" ? DEFAULT_TIMEOUT : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT)
    throw new Error("Invalid review timeout: require 1..1800000 milliseconds");
  return timeout;
}
export function regularAccessible(file, mode) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, mode);
    return true;
  } catch {
    return false;
  }
}
export function safeSetting(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: settings must be single-line text; control bytes are rejected
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(`Invalid ${name}`);
  return value;
}
export function executable(cwd, bin, env) {
  safeSetting(bin, "SPECFLOW_AUDIT_BIN");
  const searchPath = env.PATH === undefined ? ["/usr/bin", "/bin"] : env.PATH.split(path.delimiter);
  const candidates =
    bin.includes("/") || bin.includes("\\")
      ? [path.resolve(cwd, bin)]
      : searchPath.map((dir) => path.resolve(cwd, dir, bin));
  const selected = candidates.find((file) => regularAccessible(file, fs.constants.X_OK));
  if (!selected)
    throw new Error(
      "Review executable not found or not executable; check the selected review executor configuration",
    );
  return selected;
}

// Transient frontend feedback is separate from the immutable execution receipt.
// Cached/running jobs do not validate/probe a new bin or respawn with new settings.
export function describeReviewExecution(job, { started = false, env = process.env } = {}) {
  const provided = env.SPECFLOW_AUDIT_TIMEOUT !== undefined && env.SPECFLOW_AUDIT_TIMEOUT !== "";
  let requestedTimeoutMs = null,
    requestValid = true;
  if (provided) {
    try {
      requestedTimeoutMs = reviewTimeout(env.SPECFLOW_AUDIT_TIMEOUT);
    } catch {
      requestValid = false;
    }
  }
  const effectiveTimeoutMs = job.execution?.timeout ?? null;
  const action = started ? "started" : job.state === "running" ? "wait-existing" : "reuse-result";
  const effective =
    effectiveTimeoutMs === null ? "unknown (portable/legacy receipt)" : `${effectiveTimeoutMs}ms`;
  const message = started
    ? `Review job started; timeout=${effective} (current first-run settings applied)`
    : `Review ${action === "wait-existing" ? "waiting for existing job" : "reusing existing result"}; timeout=${effective}; ` +
      (provided
        ? `requested timeout=${requestValid ? `${requestedTimeoutMs}ms` : "invalid"} ignored; `
        : "no execution settings refreshed; ") +
      "bin/model/thinking unchanged; a new execution requires a new job and authorized budget, never an automatic retry";
  return {
    action,
    requestedTimeoutMs,
    effectiveTimeoutMs,
    requestValid,
    timeoutApplied: started,
    timeoutIgnored: !started && provided,
    message,
  };
}
