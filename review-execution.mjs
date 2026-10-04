// Shared review/audit launch configuration. Filesystem preflight never executes a target.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT = 180000;
const MAX_TIMEOUT = 1800000;
export function reviewTimeout(value) {
  const timeout = value === undefined || value === "" ? DEFAULT_TIMEOUT : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) throw new Error("Invalid review timeout: require 1..1800000 milliseconds");
  return timeout;
}
function regularAccessible(file, mode) {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, mode), true); } catch { return false; }
}
function safeSetting(value, name) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function executable(cwd, bin, env) {
  safeSetting(bin, "SPECFLOW_AUDIT_BIN");
  const searchPath = env.PATH === undefined ? ["/usr/bin", "/bin"] : env.PATH.split(path.delimiter);
  const candidates = bin.includes("/") || bin.includes("\\") ? [path.resolve(cwd, bin)]
    : searchPath.map((dir) => path.resolve(cwd, dir, bin));
  const selected = candidates.find((file) => regularAccessible(file, fs.constants.X_OK));
  if (!selected) throw new Error("Review executable not found or not executable; set SPECFLOW_AUDIT_BIN to a trusted executable or SPECFLOW_PI_CLI to a trusted absolute installed Pi CLI");
  return selected;
}
export function resolveReviewExecution(cwd, env = process.env) {
  const thinking = env.SPECFLOW_AUDIT_THINKING || "off", timeout = reviewTimeout(env.SPECFLOW_AUDIT_TIMEOUT);
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error("Invalid review execution settings");
  const model = env.SPECFLOW_AUDIT_MODEL || "";
  if (model) safeSetting(model, "SPECFLOW_AUDIT_MODEL");
  if (env.SPECFLOW_AUDIT_BIN) {
    return { bin: executable(cwd, env.SPECFLOW_AUDIT_BIN, env), prefixArgs: [], launcher: "explicit-bin", model, thinking, timeout };
  }
  if (env.SPECFLOW_PI_CLI) {
    const cli = safeSetting(env.SPECFLOW_PI_CLI, "SPECFLOW_PI_CLI");
    if (!path.isAbsolute(cli) || !regularAccessible(cli, fs.constants.R_OK)) throw new Error("SPECFLOW_PI_CLI must be an absolute readable regular file for a caller-trusted installed Pi CLI");
    return { bin: executable(cwd, process.execPath, env), prefixArgs: [cli], launcher: "node-cli", model, thinking, timeout };
  }
  return { bin: executable(cwd, "pi", env), prefixArgs: [], launcher: "path", model, thinking, timeout };
}

// Transient frontend feedback is separate from the immutable execution receipt.
// Cached/running jobs do not validate/probe a new bin or respawn with new settings.
export function describeReviewExecution(job, { started = false, env = process.env } = {}) {
  const provided = env.SPECFLOW_AUDIT_TIMEOUT !== undefined && env.SPECFLOW_AUDIT_TIMEOUT !== "";
  let requestedTimeoutMs = null, requestValid = true;
  if (provided) { try { requestedTimeoutMs = reviewTimeout(env.SPECFLOW_AUDIT_TIMEOUT); } catch { requestValid = false; } }
  const effectiveTimeoutMs = job.execution?.timeout ?? null;
  const action = started ? "started" : job.state === "running" ? "wait-existing" : "reuse-result";
  const effective = effectiveTimeoutMs === null ? "unknown (portable/legacy receipt)" : `${effectiveTimeoutMs}ms`;
  const message = started ? `Review job started; timeout=${effective} (current first-run settings applied)`
    : `Review ${action === "wait-existing" ? "waiting for existing job" : "reusing existing result"}; timeout=${effective}; ` +
      (provided ? `requested timeout=${requestValid ? `${requestedTimeoutMs}ms` : "invalid"} ignored; ` : "no execution settings refreshed; ") +
      "bin/model/thinking unchanged; a new execution requires a new job and authorized budget, never an automatic retry";
  return { action, requestedTimeoutMs, effectiveTimeoutMs, requestValid, timeoutApplied: started, timeoutIgnored: !started && provided, message };
}
