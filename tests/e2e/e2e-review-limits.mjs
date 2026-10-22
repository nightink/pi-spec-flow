// Real CLI + detached worker boundary with a disposable fake installed CLI only.
// No provider, network, real grant or review is used; large packets are synthetic.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSpec, writeFrontmatter } from "../../packages/core/src/core.mjs";
import { loadProjectProfile } from "../../packages/core/src/project-profile.mjs";
import {
  DEFAULT_REVIEW_MAX_BYTES,
  isReviewLimitError,
  prepareWorkingAudit,
  runPreparedReview,
} from "../../packages/core/src/review-engine.mjs";
import { digest, loadJob, reviewStore } from "../../packages/core/src/review-storage.mjs";

const core = fileURLToPath(new URL("../../packages/core/src/core.mjs", import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-review-limits-e2e-"));
const root = path.join(sandbox, "trusted checkout");
const proposalRoot = path.join(sandbox, "large proposal checkout");
const auditRoot = path.join(sandbox, "working tree audit checkout");
const bin = path.join(sandbox, "PATH without pi"),
  cliFile = path.join(sandbox, "trusted fake Pi CLI.js"),
  calls = path.join(sandbox, "calls");
const captures = path.join(sandbox, "captured");
fs.mkdirSync(captures, { recursive: true });
const baseEnv = {
  ...process.env,
  PATH: bin,
  SPECFLOW_AUDIT_BIN: "",
  SPECFLOW_REVIEW_CLI: "",
  SPECFLOW_PI_CLI: cliFile,
  SPECFLOW_REVIEW_EXECUTOR: "",
  SPECFLOW_AUDIT_MODEL: "",
  SPECFLOW_AUDIT_THINKING: "off",
  SPECFLOW_AUDIT_TIMEOUT: "8000",
  SPECFLOW_REVIEW_BUDGET_ID: "",
  SPECFLOW_AUDIT_MAX_BYTES: "4194304",
  LIMITS_E2E_CALLS: calls,
};
function cli(cwd, command, args, extra = {}) {
  return spawnSync(process.execPath, [core, command, ...args], {
    cwd,
    env: { ...baseEnv, ...extra },
    encoding: "utf8",
    timeout: 180000,
  });
}
function jsonCli(cwd, command, input, extra = {}) {
  const result = cli(cwd, command, ["--json", JSON.stringify(input)], extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function failCli(cwd, command, input, extra = {}) {
  const result = cli(cwd, command, ["--json", JSON.stringify(input)], extra);
  assert.notEqual(result.status, 0, "expected a non-zero exit");
  return result;
}
function gitAt(cwd, ...args) {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function repository(directory, files) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [file, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), value);
  }
  gitAt(directory, "init", "-q");
  gitAt(directory, "config", "user.name", "limits-e2e");
  gitAt(directory, "config", "user.email", "fixture@example.invalid");
  gitAt(directory, "add", ".");
  gitAt(directory, "commit", "-qm", "fixture");
  return gitAt(directory, "rev-parse", "HEAD");
}
function commitAll(directory) {
  gitAt(directory, "add", ".");
  gitAt(directory, "commit", "-qm", "fixture", "--allow-empty");
  return gitAt(directory, "rev-parse", "HEAD");
}
function write(directory, file, text) {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), text);
}
const budgetFile = (directory) => path.join(reviewStore(directory), "budgets/mechanical.json");
function budgetUsed(directory) {
  const file = budgetFile(directory);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).used : 0;
}
function grant(directory, callsAllowed = 6) {
  jsonCli(directory, "review-budget", {
    id: "mechanical",
    calls: callsAllowed,
    note: "Disposable synthetic fake-executor E2E grant only; never a real reviewer authorization.",
  });
}
function jobCount(directory) {
  const jobs = path.join(reviewStore(directory), "jobs");
  return fs.existsSync(jobs)
    ? fs.readdirSync(jobs).filter((name) => !name.endsWith(".tmp")).length
    : 0;
}
function callsMade() {
  return fs.existsSync(calls)
    ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length
    : 0;
}
function capture(name) {
  return path.join(captures, name);
}
function assertCompleted(result, capturedFile) {
  assert.equal(result.state, "completed", result.receipt?.error || result.receipt?.state);
  assert.equal(result.receipt.model_invoked, true);
  assert.equal(result.receipt.child_input_sha256, result.receipt.packet_sha256);
  assert.equal(digest(fs.readFileSync(capturedFile)), result.receipt.packet_sha256);
}
function bigBody(marker, bytes = 600000) {
  return `${marker.repeat(bytes)}\n`;
}
function assertLargePacket(file) {
  const size = fs.statSync(file).size;
  assert.ok(size > DEFAULT_REVIEW_MAX_BYTES, `expected >512KiB packet, got ${size}`);
  assert.ok(size < 4194304, `expected <4MiB packet, got ${size}`);
  return size;
}
try {
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.symlinkSync("/usr/bin/git", path.join(bin, "git"));
  fs.writeFileSync(
    cliFile,
    `import fs from 'node:fs';import {mechanicalCoverage} from ${JSON.stringify(new URL("../helpers/review-fixture.mjs", import.meta.url).href)};const args=process.argv.slice(2);
if(args.includes('--version'))process.exit(9);
for(const flag of ['-p','--no-session','--no-tools','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-themes','--no-approve','--mode','json'])if(!args.includes(flag))process.exit(2);
const packetFile=args.at(-1);if(!packetFile.startsWith('@'))process.exit(3);
if(process.env.LIMITS_E2E_CALLS)fs.appendFileSync(process.env.LIMITS_E2E_CALLS,'call\\n');
if(process.env.LIMITS_E2E_CAPTURE)fs.copyFileSync(packetFile.slice(1),process.env.LIMITS_E2E_CAPTURE);
const packet=fs.readFileSync(packetFile.slice(1),'utf8');
console.log(JSON.stringify(mechanicalCoverage({verdict:'pass',criteria:[{criterion:'synthetic limits E2E',status:'pass',evidence:'disposable fake only'}],scope_deviations:[],findings:[],previous_closure:[],out_of_scope:[]},packet)));
`,
    { mode: 0o600 },
  );

  // ── >512KiB proposal packet: exact UTF-8 boundary, sealed env, worker, replay ──
  const proposalSpec = writeFrontmatter(
    `# Contract\n\n${"中".repeat(80000)}\n\n${'\\"quoted\\" and \\\\slash\\\\ escapes '.repeat(280)}\n`,
    {
      id: "S1",
      status: "approved",
      review: { decision: "approved" },
      evidence: { e2e: [], migrations: [], human: [] },
      review_inputs: { context_files: ["ctx1.txt", "ctx2.txt"], proposal_reviews: [] },
    },
  );
  repository(proposalRoot, {
    "docs/specs/S1.md": proposalSpec,
    "ctx1.txt": "c".repeat(64000),
    "ctx2.txt": "d".repeat(64000),
    "code.txt": "baseline\n",
    "package.json": JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }),
  });
  grant(proposalRoot);
  const rejectedProposal = failCli(
    proposalRoot,
    "review",
    { mode: "proposal", id: "S1" },
    { SPECFLOW_AUDIT_MAX_BYTES: "" },
  );
  assert.match(rejectedProposal.stderr, /exceeds limit at seal/);
  assert.match(rejectedProposal.stderr, /524288/);
  assert.equal(budgetUsed(proposalRoot), 0);
  assert.equal(jobCount(proposalRoot), 0);
  const proposal = jsonCli(proposalRoot, "review", { mode: "proposal", id: "S1" });
  assert.equal(proposal.reviewLimit.source, "environment");
  assertLargePacket(proposal.packetPath);
  assert.ok(fs.readFileSync(proposal.packetPath, "utf8").includes("中"));

  let exact = proposal.receipt.packet_bytes;
  let stableJob = proposal.jobId;
  for (let i = 0; i < 4; i++) {
    const next = jsonCli(proposalRoot, "review", { mode: "proposal", id: "S1", maxBytes: exact });
    const bytes = next.receipt.packet_bytes;
    stableJob = next.jobId;
    if (bytes === exact) break;
    exact = bytes;
  }
  assert.ok(exact < 1000000, `boundary fixture should stay six-digit, got ${exact}`);
  assert.equal(String(exact).length, String(exact - 1).length);
  const stable = loadJob(proposalRoot, stableJob).job;
  assert.equal(stable.packet_bytes, exact);
  assert.equal(stable.review_limit.maxBytes, exact);
  const jobsBeforeBoundaryFailure = jobCount(proposalRoot);
  const tooSmall = failCli(proposalRoot, "review", {
    mode: "proposal",
    id: "S1",
    maxBytes: exact - 1,
  });
  assert.match(tooSmall.stderr, /exceeds limit at seal/);
  assert.match(tooSmall.stderr, new RegExp(`${exact} bytes > ${exact - 1} bytes`));
  assert.match(tooSmall.stderr, /next: spec_review .*"maxBytes"/);
  assert.equal(jobCount(proposalRoot), jobsBeforeBoundaryFailure);
  assert.equal(budgetUsed(proposalRoot), 0);
  assert.equal(callsMade(), 0);

  const proposalCapture = capture("proposal.packet");
  const proposalRun = jsonCli(
    proposalRoot,
    "review",
    { action: "run", jobId: stableJob, budgetId: "mechanical" },
    { SPECFLOW_AUDIT_MAX_BYTES: "1.5", LIMITS_E2E_CAPTURE: proposalCapture },
  );
  assertCompleted(proposalRun, proposalCapture);
  assert.equal(proposalRun.reviewLimit.maxBytes, exact);
  assert.equal(budgetUsed(proposalRoot), 1);
  const proposalStatus = jsonCli(
    proposalRoot,
    "review",
    { action: "status", jobId: stableJob },
    { SPECFLOW_AUDIT_MAX_BYTES: "1024" },
  );
  assert.equal(proposalStatus.reviewLimit.maxBytes, exact);
  assert.equal(proposalStatus.state, "completed");
  const proposalReplay = jsonCli(
    proposalRoot,
    "review",
    { action: "run", jobId: stableJob },
    { SPECFLOW_AUDIT_MAX_BYTES: "" },
  );
  assert.equal(proposalReplay.state, "completed");
  assert.equal(proposalReplay.reviewLimit.maxBytes, exact);
  assert.equal(budgetUsed(proposalRoot), 1);
  assert.equal(callsMade(), 1);
  console.log(
    "PASS large proposal CLI: default rejection, exact UTF-8 boundary, invalid/lowered env sealed, detached fake worker, free replay",
  );

  // ── >512KiB committed and incremental packets through the same real CLI ──
  const spec = writeFrontmatter("# Contract\n\n- [ ] implementation\n", {
    id: "S1",
    status: "approved",
    review: { decision: "approved" },
    evidence: { e2e: [], migrations: [], human: [] },
  });
  const base = repository(root, {
    "docs/specs/S1.md": spec,
    "code.txt": "baseline\n",
    "package.json": JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }),
  });
  write(root, "code.txt", bigBody("a"));
  const committedHead = commitAll(root);
  grant(root);
  const rejectedCommitted = failCli(
    root,
    "review",
    { id: "S1", base, head: committedHead },
    { SPECFLOW_AUDIT_MAX_BYTES: "" },
  );
  assert.match(rejectedCommitted.stderr, /exceeds limit at git-diff/);
  assert.match(rejectedCommitted.stderr, /total size unknown/);
  assert.match(rejectedCommitted.stderr, /next: spec_review .*"maxBytes"/);
  assert.equal(budgetUsed(root), 0);
  assert.equal(jobCount(root), 0);
  const committed = jsonCli(root, "review", { id: "S1", base, head: committedHead });
  assertLargePacket(committed.packetPath);
  const committedCapture = capture("committed.packet");
  const committedRun = jsonCli(
    root,
    "review",
    { action: "run", jobId: committed.jobId, budgetId: "mechanical" },
    { LIMITS_E2E_CAPTURE: committedCapture },
  );
  assertCompleted(committedRun, committedCapture);
  assert.equal(budgetUsed(root), 1);

  write(root, "code.txt", bigBody("b"));
  const incrementalHead = commitAll(root);
  const rejectedIncremental = failCli(
    root,
    "review",
    {
      id: "S1",
      mode: "incremental",
      base: committedHead,
      head: incrementalHead,
      previousReview: committed.jobId,
    },
    { SPECFLOW_AUDIT_MAX_BYTES: "" },
  );
  assert.match(rejectedIncremental.stderr, /exceeds limit/);
  const incremental = jsonCli(root, "review", {
    id: "S1",
    mode: "incremental",
    base: committedHead,
    head: incrementalHead,
    previousReview: committed.jobId,
    maxBytes: 4194304,
  });
  assert.equal(incremental.reviewLimit.source, "argument");
  assertLargePacket(incremental.packetPath);
  const incrementalCapture = capture("incremental.packet");
  const incrementalRun = jsonCli(
    root,
    "review",
    { action: "run", jobId: incremental.jobId, budgetId: "mechanical" },
    { SPECFLOW_AUDIT_MAX_BYTES: "1", LIMITS_E2E_CAPTURE: incrementalCapture },
  );
  assertCompleted(incrementalRun, incrementalCapture);
  assert.equal(budgetUsed(root), 2);
  const incrementalReplay = jsonCli(
    root,
    "review",
    { action: "run", jobId: incremental.jobId },
    { SPECFLOW_AUDIT_MAX_BYTES: "" },
  );
  assert.equal(incrementalReplay.state, "completed");
  assert.equal(budgetUsed(root), 2);
  assert.equal(callsMade(), 3);
  console.log(
    "PASS large committed/incremental CLI: default git lower-bound rejection, sealed 4 MiB packet, detached worker and free replay",
  );

  // ── working-tree audit: engine interface + real detached worker (CLI status) ──
  repository(auditRoot, {
    "docs/specs/S1.md": spec,
    "code.txt": "baseline\n",
    "package.json": JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }),
  });
  grant(auditRoot);
  const auditSpec = findSpec(auditRoot, "S1");
  const auditOptions = {
    spec: auditSpec,
    content: auditSpec.content,
    profile: loadProjectProfile(auditRoot),
    bindings: {},
    diff: `diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1 +1 @@\n-baseline\n+${"w".repeat(600000)}\n`,
    impl: {},
  };
  let defaultAuditFailure = null;
  try {
    await prepareWorkingAudit(auditRoot, auditOptions);
  } catch (error) {
    defaultAuditFailure = error;
  }
  assert.ok(isReviewLimitError(defaultAuditFailure), String(defaultAuditFailure));
  assert.equal(defaultAuditFailure.stage, "seal");
  assert.equal(defaultAuditFailure.diagnostic.sizeKnown, true);
  assert.ok(defaultAuditFailure.diagnostic.actualBytes > DEFAULT_REVIEW_MAX_BYTES);
  const auditPrepared = await prepareWorkingAudit(auditRoot, {
    ...auditOptions,
    maxBytes: 4194304,
  });
  assertLargePacket(auditPrepared.packetPath);
  const auditCapture = capture("audit.packet");
  const directKeys = [
    "PATH",
    "SPECFLOW_PI_CLI",
    "SPECFLOW_REVIEW_CLI",
    "SPECFLOW_AUDIT_BIN",
    "SPECFLOW_REVIEW_EXECUTOR",
    "SPECFLOW_AUDIT_TIMEOUT",
    "SPECFLOW_AUDIT_MODEL",
    "SPECFLOW_AUDIT_THINKING",
    "LIMITS_E2E_CAPTURE",
  ];
  const saved = Object.fromEntries(directKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, baseEnv, { LIMITS_E2E_CAPTURE: auditCapture });
  try {
    const auditRun = await runPreparedReview(auditRoot, auditPrepared.jobId, {
      budgetId: "mechanical",
    });
    assert.equal(auditRun.state, "completed");
    assert.equal(auditRun.receipt.child_input_sha256, auditRun.receipt.packet_sha256);
    assert.equal(digest(fs.readFileSync(auditCapture)), auditRun.receipt.packet_sha256);
    assert.equal(auditRun.receipt.review_limit.maxBytes, 4194304);
  } finally {
    for (const key of directKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  assert.equal(budgetUsed(auditRoot), 1);
  const auditStatus = jsonCli(
    auditRoot,
    "review",
    { action: "status", jobId: auditPrepared.jobId },
    { SPECFLOW_AUDIT_MAX_BYTES: "" },
  );
  assert.equal(auditStatus.state, "completed");
  assert.equal(auditStatus.reviewLimit.maxBytes, 4194304);
  assert.equal(callsMade(), 4);
  console.log(
    "PASS working-tree audit: exact >512KiB packet, detached fake worker, sealed CLI status",
  );
  // ── full audit CLI: free prepare, sealed >512KiB execution, default rejection ──
  const lifecycleRoot = path.join(sandbox, "full audit lifecycle checkout");
  repository(lifecycleRoot, {
    "docs/specs/S1.md": spec,
    ".spec-flow.json": JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [{ name: "offline", argv: ["node", "-e", "process.exit(0)"] }],
      },
    }),
    "code.txt": "baseline\n",
    "package.json": JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }),
  });
  grant(lifecycleRoot);
  assert.equal(cli(lifecycleRoot, "begin", ["S1"]).status, 0);
  write(lifecycleRoot, "code.txt", bigBody("v"));
  const implResult = cli(lifecycleRoot, "impl", ["S1"]);
  assert.equal(implResult.status, 0, implResult.stderr);
  const specAfterImpl = fs.readFileSync(findSpec(lifecycleRoot, "S1").path);
  const rejectedAuditPrepare = cli(lifecycleRoot, "audit", ["S1", "--prepare"], {
    SPECFLOW_AUDIT_MAX_BYTES: "",
  });
  assert.notEqual(rejectedAuditPrepare.status, 0);
  assert.match(rejectedAuditPrepare.stderr, /exceeds|limit/i);
  assert.deepEqual(fs.readFileSync(findSpec(lifecycleRoot, "S1").path), specAfterImpl);
  assert.equal(budgetUsed(lifecycleRoot), 0);
  const auditPreparedCli = cli(lifecycleRoot, "audit", [
    "S1",
    "--prepare",
    "--max-bytes",
    "4194304",
  ]);
  assert.equal(auditPreparedCli.status, 0, auditPreparedCli.stderr);
  const preparedAudit = JSON.parse(auditPreparedCli.stdout);
  assert.equal(preparedAudit.prepared, true);
  assert.equal(preparedAudit.modelInvoked, false);
  assert.ok(preparedAudit.bytes > DEFAULT_REVIEW_MAX_BYTES);
  assert.equal(preparedAudit.maxBytes, 4194304);
  assert.deepEqual(fs.readFileSync(findSpec(lifecycleRoot, "S1").path), specAfterImpl);
  assert.equal(budgetUsed(lifecycleRoot), 0);
  assert.equal(callsMade(), 4);
  const lifecycleCapture = capture("lifecycle-audit.packet");
  const auditCliRun = cli(lifecycleRoot, "audit", ["S1", "--review-job", preparedAudit.jobId], {
    SPECFLOW_REVIEW_BUDGET_ID: "mechanical",
    SPECFLOW_AUDIT_MAX_BYTES: "1",
    LIMITS_E2E_CAPTURE: lifecycleCapture,
  });
  assert.equal(auditCliRun.status, 0, auditCliRun.stderr);
  assert.match(auditCliRun.stdout, /PASS/);
  assert.equal(budgetUsed(lifecycleRoot), 1);
  assert.equal(callsMade(), 5);
  const auditJob = loadJob(lifecycleRoot, preparedAudit.jobId).job;
  assert.equal(auditJob.state, "completed");
  assert.equal(auditJob.child_input_sha256, auditJob.packet_sha256);
  assert.equal(digest(fs.readFileSync(lifecycleCapture)), auditJob.packet_sha256);
  console.log(
    "PASS full audit CLI: free >512KiB prepare with default rejection, sealed execution and attached PASS",
  );
} finally {
  delete process.env.LIMITS_E2E_CAPTURE;
  fs.rmSync(sandbox, { recursive: true, force: true });
}
