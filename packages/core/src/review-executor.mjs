// Harness-neutral review executor contract.
//
// An executor module is an ESM file exporting:
//   resolve(cwd, env) -> { bin, prefixArgs?, launcher?, model?, thinking?, timeout? }
//   buildArgs(execution, promptFile) -> string[]  (last item MUST be `@${promptFile}`)
//   envDeny?: string[]  (ambient variables removed before the child spawns)
//   envSet?: Record<string,string>  (variables set for the child after removal)
//
// SPECFLOW_REVIEW_EXECUTOR selects an absolute module path; adapters may also
// pass `options.executor` as a pre-loaded object. The bundled pi-cli module is
// only the reference implementation for the CLI/CI path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REVIEW_THINKING_LEVELS,
  regularAccessible,
  reviewTimeout,
  safeSetting,
} from "./review-execution.mjs";

export const DEFAULT_REVIEW_EXECUTOR = fileURLToPath(
  new URL("./executors/pi-cli.mjs", import.meta.url),
);

function assertExecutor(candidate, label) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.resolve !== "function" ||
    typeof candidate.buildArgs !== "function"
  )
    throw new Error(`${label} must export resolve(cwd, env) and buildArgs(execution, promptFile)`);
  const envDeny = candidate.envDeny ?? [];
  const envSet = candidate.envSet ?? {};
  if (
    !envSet ||
    typeof envSet !== "object" ||
    Array.isArray(envSet) ||
    Object.entries(envSet).some(
      ([name, value]) =>
        typeof name !== "string" ||
        !name ||
        name.length > 256 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: env names are single-line
        /[\x00-\x1f\x7f=]/.test(name) ||
        typeof value !== "string" ||
        value.length > 4096 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: env values are single-line
        /[\x00-\x1f\x7f]/.test(value),
    )
  )
    throw new Error(`${label} env must be a bounded string map`);
  if (
    !Array.isArray(envDeny) ||
    envDeny.some(
      (name) =>
        typeof name !== "string" ||
        !name ||
        name.length > 256 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: env names are single-line
        /[\x00-\x1f\x7f=]/.test(name),
    )
  )
    throw new Error(`${label} envDeny must be a bounded array of environment names`);
  return {
    name: label,
    resolve: candidate.resolve,
    buildArgs: candidate.buildArgs,
    envDeny: [...envDeny],
    envSet: { ...envSet },
  };
}

function modulePath(raw, name) {
  safeSetting(raw, name);
  if (!path.isAbsolute(raw))
    throw new Error(`${name} must be an absolute path to a review executor module`);
  try {
    if (!fs.statSync(raw).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new Error(`${name} is not a readable review executor module: ${raw}`, { cause: error });
  }
  return raw;
}

export async function loadReviewExecutor({ env = process.env, executor } = {}) {
  if (executor && typeof executor === "object")
    return assertExecutor(executor, "injected review executor");
  const selected =
    typeof executor === "string"
      ? modulePath(executor, "review executor")
      : env.SPECFLOW_REVIEW_EXECUTOR
        ? modulePath(env.SPECFLOW_REVIEW_EXECUTOR, "SPECFLOW_REVIEW_EXECUTOR")
        : DEFAULT_REVIEW_EXECUTOR;
  let loaded;
  try {
    loaded = await import(pathToFileURL(selected).href);
  } catch (error) {
    throw new Error(`Cannot load review executor module: ${selected}`, { cause: error });
  }
  return assertExecutor(loaded, selected);
}

function strings(value, label, { max = 512, length = 16384 } = {}) {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item ||
        item.length > length ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: argv entries are single-line
        /[\x00-\x1f\x7f]/.test(item),
    )
  )
    throw new Error(`${label} must be a bounded string array`);
  return [...value];
}

export function resolveReviewExecution(executor, cwd, env = process.env) {
  const resolved = executor.resolve(cwd, env);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved))
    throw new Error("Review executor resolve() must return an execution object");
  safeSetting(resolved.bin, "review executor bin");
  if (path.isAbsolute(resolved.bin) && !regularAccessible(resolved.bin, fs.constants.X_OK))
    throw new Error(`Review executor bin is not an executable regular file: ${resolved.bin}`);
  const thinking = resolved.thinking ?? "off";
  if (!REVIEW_THINKING_LEVELS.includes(thinking))
    throw new Error("Invalid review execution settings");
  const model = resolved.model ?? "";
  if (model) safeSetting(model, "review executor model");
  return {
    bin: resolved.bin,
    prefixArgs: resolved.prefixArgs === undefined ? [] : strings(resolved.prefixArgs, "prefixArgs"),
    launcher:
      typeof resolved.launcher === "string" && resolved.launcher
        ? safeSetting(resolved.launcher, "review executor launcher")
        : "external",
    model,
    thinking,
    timeout: reviewTimeout(resolved.timeout),
    executor: executor.name,
  };
}

export function buildReviewInvocation(executor, execution, promptFile) {
  const expected = `@${promptFile}`;
  const args = strings(executor.buildArgs(execution, promptFile), "review executor args");
  if (args.at(-1) !== expected)
    throw new Error(
      "Review executor buildArgs() must pass the sealed packet as the final @file argument",
    );
  return {
    bin: execution.bin,
    prefixArgs: [...execution.prefixArgs],
    args,
    envDeny: [...executor.envDeny],
    envSet: { ...executor.envSet },
  };
}
