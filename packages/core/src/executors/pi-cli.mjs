// Reference executor for the Pi CLI argv protocol.
//
// This is deliberately just one implementation of the review-executor contract
// consumed by review-engine.mjs. A different agent harness ships its own module
// exporting resolve(cwd, env) and buildArgs(execution, promptFile); nothing in
// the engine, worker or receipts knows about Pi flags.
import fs from "node:fs";
import path from "node:path";
import {
  executable,
  REVIEW_THINKING_LEVELS,
  regularAccessible,
  reviewTimeout,
  safeSetting,
} from "../review-execution.mjs";

// Harness-specific ambient state that must not leak into the isolated child.
export const envDeny = Object.freeze([
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_SKIP_VERSION_CHECK",
]);
// Keep the isolated CLI offline-friendly and non-interactive, as before.
export const envSet = Object.freeze({ PI_SKIP_VERSION_CHECK: "1" });
const PI_CLI_FLAGS = Object.freeze([
  "-p",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-themes",
  "--no-approve",
  "--mode",
  "json",
]);

export function resolve(cwd, env = process.env) {
  const thinking = env.SPECFLOW_AUDIT_THINKING || "off";
  const timeout = reviewTimeout(env.SPECFLOW_AUDIT_TIMEOUT);
  if (!REVIEW_THINKING_LEVELS.includes(thinking))
    throw new Error("Invalid review execution settings");
  const model = env.SPECFLOW_AUDIT_MODEL || "";
  if (model) safeSetting(model, "SPECFLOW_AUDIT_MODEL");
  if (env.SPECFLOW_AUDIT_BIN) {
    return {
      bin: executable(cwd, env.SPECFLOW_AUDIT_BIN, env),
      prefixArgs: [],
      launcher: "explicit-bin",
      model,
      thinking,
      timeout,
    };
  }
  const cli = env.SPECFLOW_REVIEW_CLI || env.SPECFLOW_PI_CLI;
  if (cli) {
    safeSetting(cli, env.SPECFLOW_REVIEW_CLI ? "SPECFLOW_REVIEW_CLI" : "SPECFLOW_PI_CLI");
    if (!path.isAbsolute(cli) || !regularAccessible(cli, fs.constants.R_OK))
      throw new Error(
        "SPECFLOW_REVIEW_CLI/SPECFLOW_PI_CLI must be an absolute readable regular file for a caller-trusted installed agent CLI",
      );
    return {
      bin: executable(cwd, process.execPath, env),
      prefixArgs: [cli],
      launcher: "node-cli",
      model,
      thinking,
      timeout,
    };
  }
  return {
    bin: executable(cwd, "pi", env),
    prefixArgs: [],
    launcher: "path",
    model,
    thinking,
    timeout,
  };
}

// The sealed packet is passed as a single @file argument: it survives argv
// limits for large diffs and keeps worker child-input verification exact.
export function buildArgs(execution, promptFile) {
  const args = [...PI_CLI_FLAGS];
  if (execution.model) args.push("--model", execution.model);
  args.push("--thinking", execution.thinking || "off");
  args.push(`@${promptFile}`);
  return args;
}

// Compatibility helper for the historical buildAuditorArgs() API. It owns the
// temporary prompt file; new engine code uses buildArgs() with the sealed packet.
export function buildPromptArgs(promptFile, model = "", thinking = "off") {
  return buildArgs({ model, thinking: thinking || "off" }, promptFile);
}
