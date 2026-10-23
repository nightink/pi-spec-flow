import fs from "node:fs";
import path from "node:path";
import {
  engineIdentity,
  findSpec,
  repositorySnapshotHash,
  runArgv,
  runSpawn,
  specContractHash,
} from "./core.mjs";
import { scanReviewPacket } from "./review-engine.mjs";
import { digest } from "./review-storage.mjs";

export function parseCaptureArgs(args) {
  const [id, ...rest] = args,
    input = {};
  if (!id || id.startsWith("-")) throw new Error("capture requires <id>");
  const options = {
    "--label": "label",
    "--expect": "expect",
    "--output": "output",
    "--kind": "kind",
    "--timeout-ms": "timeoutMs",
    "--max-output-bytes": "maxOutputBytes",
  };
  let split = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--") {
      split = i;
      break;
    }
    const key = options[rest[i]];
    if (
      !key ||
      Object.hasOwn(input, key) ||
      rest[i + 1] === undefined ||
      rest[i + 1].startsWith("--")
    )
      throw new Error("capture accepts unique named options followed by -- <command> [args]");
    const value = rest[++i];
    if (["timeoutMs", "maxOutputBytes"].includes(key) && !/^\d+$/.test(value))
      throw new Error(`${key} requires a positive decimal integer`);
    input[key] = ["timeoutMs", "maxOutputBytes"].includes(key) ? Number(value) : value;
  }
  if (split < 0) throw new Error("capture requires -- <command> [args]; no implicit shell");
  return { id, ...input, argv: rest.slice(split + 1) };
}
function outputPath(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative.endsWith(".json") ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    [...relative].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127) ||
    relative
      .split("/")
      .some((part) => !part || [".", "..", ".git", "node_modules"].includes(part.toLowerCase()))
  )
    throw new Error(
      "capture output must be a safe repository-relative .json path outside .git/node_modules",
    );
  const target = path.join(root, relative);
  let directory = root;
  for (const part of relative.split("/").slice(0, -1)) {
    directory = path.join(directory, part);
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("capture output ancestor must be a regular directory, never a symlink");
  }
  return target;
}
function capturedOutput(chunks) {
  const bytes = Buffer.concat(chunks),
    text = bytes.toString("utf8");
  const utf8 = Buffer.from(text).equals(bytes);
  return {
    encoding: utf8 ? "utf8" : "base64",
    data: utf8 ? text : bytes.toString("base64"),
    bytes: bytes.length,
    sha256: digest(bytes),
  };
}
export async function captureEvidence(cwd, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "label",
          "expect",
          "output",
          "kind",
          "timeoutMs",
          "maxOutputBytes",
          "argv",
        ].includes(key),
    )
  )
    throw new Error("Invalid capture fields");
  const {
    id,
    label,
    expect,
    output,
    kind = "observation",
    timeoutMs = 60000,
    maxOutputBytes = 262144,
    argv,
  } = input;
  if (
    typeof label !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(label) ||
    !["pass", "fail"].includes(expect) ||
    !["observation", "historical-replay", "mutation"].includes(kind)
  )
    throw new Error(
      "capture requires a safe label, --expect pass|fail and --kind observation|historical-replay|mutation",
    );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 1800000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1048576
  )
    throw new Error("capture limits: timeoutMs 1..1800000; maxOutputBytes 1..1048576");
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.length > 200 ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !argv[0]
  )
    throw new Error("capture requires an explicit argv command, never an implicit shell");
  const spec = findSpec(cwd, id);
  if (!spec?.hasFrontmatter) throw new Error(`Spec ${id} not found or unmanaged`);
  const rootResult = await runArgv("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (rootResult.code !== 0) throw new Error("capture requires a Git repository");
  const root = fs.realpathSync(rootResult.stdout.trim()),
    target = outputPath(root, output);
  // Reserve before execution, prevent overwrite, and bind the exact opened inode.
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  const opened = fs.fstatSync(fd);
  const sameFile = () => {
    try {
      const stat = fs.lstatSync(target);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.dev === opened.dev &&
        stat.ino === opened.ino &&
        fs.realpathSync(path.dirname(target)) === path.dirname(target)
      );
    } catch {
      return false;
    }
  };
  let written = false;
  try {
    const before = await repositorySnapshotHash(root, { excludePaths: [target] });
    const headBefore = await runArgv("git", ["rev-parse", "HEAD"], { cwd: root });
    if (headBefore.code !== 0) throw new Error("capture requires an existing HEAD");
    const stdout = [],
      stderr = [],
      startedAt = new Date().toISOString();
    let result,
      executionError = null;
    try {
      result = await runSpawn(argv[0], argv.slice(1), {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        onOutput: (stream, bytes) =>
          (stream === "stdout" ? stdout : stderr).push(Buffer.from(bytes)),
      });
    } catch (error) {
      executionError = error.code || error.name;
      result = { code: null, tooBig: false, timedOut: false };
    }
    const completedAt = new Date().toISOString();
    const after = await repositorySnapshotHash(root, { excludePaths: [target] });
    const headAfter = await runArgv("git", ["rev-parse", "HEAD"], { cwd: root });
    const contractBefore = specContractHash(spec.content, spec.profile);
    let contractAfter = null;
    try {
      const currentSpec = findSpec(cwd, id);
      if (currentSpec?.hasFrontmatter)
        contractAfter = specContractHash(currentSpec.content, currentSpec.profile);
    } catch {
      /* Invalid/deleted current contract is recorded as drift, not silently accepted. */
    }
    const stable =
      before.hash === after.hash &&
      headBefore.stdout === headAfter.stdout &&
      headAfter.code === 0 &&
      contractBefore === contractAfter;
    const complete = !executionError && !result.tooBig && !result.timedOut && !result.exitSignal;
    const expectedMatched =
      complete &&
      stable &&
      (expect === "pass" ? result.code === 0 : Number.isInteger(result.code) && result.code > 0);
    const record = {
      version: 1,
      type: "test-observation",
      specId: String(id),
      label,
      declaredKind: kind,
      provenanceBoundary:
        "Recorded now. A nonzero exit is not automatically a regression, and historical-replay/mutation is a caller declaration, not proof of historical red-first order.",
      engine: engineIdentity(),
      startedAt,
      completedAt,
      contract_sha256: contractBefore,
      contract_sha256_after: contractAfter,
      head_before: headBefore.stdout.trim(),
      head_after: headAfter.stdout.trim(),
      snapshot_before: before.hash,
      snapshot_after: after.hash,
      argv,
      expect,
      timeoutMs,
      maxOutputBytes,
      exitCode: result.exitSignal ? null : result.code,
      exitSignal: result.exitSignal || null,
      executionError,
      timedOut: result.timedOut,
      truncated: result.tooBig,
      stable,
      complete,
      expectedMatched,
      stdout: capturedOutput(stdout),
      stderr: capturedOutput(stderr),
    };
    const text = `${JSON.stringify(record, null, 2)}\n`;
    // Scan decoded bytes as well as the record, so base64 storage cannot hide a key.
    if (
      scanReviewPacket(
        text + Buffer.concat(stdout).toString("utf8") + Buffer.concat(stderr).toString("utf8"),
      ).findings.length
    )
      throw new Error(
        "capture detected a high-risk sensitive pattern; output not written. Scanner is not a complete secret/PII audit; inspect before sharing.",
      );
    if (!sameFile())
      throw new Error("capture output path changed during execution; refusing evidence write");
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    written = true;
    return {
      version: 1,
      path: output,
      sha256: digest(text),
      expectedMatched,
      complete,
      stable,
      captureWritesLifecycle: false,
      captureInvokesReviewer: false,
      note: "Test observation only, not an audit PASS or historical red-first certification. Review and track scrubbed evidence before declaring it as context.",
    };
  } finally {
    fs.closeSync(fd);
    if (!written && sameFile()) fs.unlinkSync(target);
  }
}
