// Disposable synthetic repositories and fake executors only: no provider, budget
// grant, or real review is created here. These tests bind the limit policy to the
// real prepare/seal/read/detached-worker paths, not just the resolver.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { packetData, seedLegacyReviewFixture } from "../../../tests/helpers/review-fixture.mjs";
import { findSpec, writeFrontmatter } from "../src/core.mjs";
import { loadProjectProfile } from "../src/project-profile.mjs";
import {
  authorizeReviewBudget,
  DEFAULT_REVIEW_MAX_BYTES,
  isReviewLimitError,
  MAX_REVIEW_MAX_BYTES,
  prepareWorkingAudit,
  resolveReviewLimit,
  retainedReviewLimit,
  review,
  reviewStatus,
  runPreparedReview,
} from "../src/review-engine.mjs";
import { digest, loadJob, readPrivate, reviewStore, saveJob } from "../src/review-storage.mjs";

const helper = new URL("../../../tests/helpers/review-fixture.mjs", import.meta.url).href;
const rawPass = {
  verdict: "pass",
  criteria: [{ criterion: "synthetic limit fixture", status: "pass", evidence: "fake only" }],
  scope_deviations: [
    { file: "outside.txt", note: "legacy scope object fixture; never a real review" },
  ],
};
const smallSpec = writeFrontmatter("# Contract\n\n- [ ] implementation\n", {
  id: "S1",
  status: "approved",
  review: { decision: "approved" },
  evidence: { e2e: [], migrations: [], human: [] },
});
function gitAt(root, ...args) {
  return execFileSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture(t, { spec = smallSpec, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-limits-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({
    "docs/specs/S1.md": spec,
    "package.json": JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }),
    "code.txt": "baseline\n",
    ...files,
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  }
  gitAt(root, "init", "-q");
  gitAt(root, "config", "user.name", "limits-fixture");
  gitAt(root, "config", "user.email", "fixture@example.invalid");
  const commit = () => {
    gitAt(root, "add", ".");
    gitAt(root, "commit", "-qm", "fixture", "--allow-empty");
    return gitAt(root, "rev-parse", "HEAD");
  };
  const base = commit();
  return {
    root,
    base,
    git: (...args) => gitAt(root, ...args),
    commit,
    write: (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    },
  };
}
const ENV_KEYS = [
  "SPECFLOW_AUDIT_MAX_BYTES",
  "SPECFLOW_AUDIT_BIN",
  "SPECFLOW_AUDIT_TIMEOUT",
  "SPECFLOW_AUDIT_MODEL",
  "SPECFLOW_AUDIT_THINKING",
  "SPECFLOW_REVIEW_BUDGET_ID",
  "SPECFLOW_PI_CLI",
  "SPECFLOW_REVIEW_CLI",
  "SPECFLOW_REVIEW_EXECUTOR",
];
function applyEnv(values) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function environment(t, values = {}) {
  const old = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])),
    clean = Object.fromEntries(ENV_KEYS.map((key) => [key, undefined]));
  applyEnv({ ...clean, ...values });
  t.after(() => applyEnv(old));
}
function fake(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-limits-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake reviewer.mjs"),
    calls = path.join(dir, "calls"),
    captured = path.join(dir, "captured packet");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nimport fs from 'node:fs';import {mechanicalCoverage} from ${JSON.stringify(helper)};const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},'call\\n');fs.copyFileSync(args.at(-1).slice(1),${JSON.stringify(captured)});console.log(JSON.stringify(mechanicalCoverage(${JSON.stringify(rawPass)},fs.readFileSync(args.at(-1).slice(1),'utf8'))));\n`,
    { mode: 0o755 },
  );
  return { file, calls, captured };
}
function grant(root, calls = 3) {
  authorizeReviewBudget(root, {
    id: "fixture",
    calls,
    note: "Disposable synthetic fake-executor grant only; never a real review authorization.",
  });
}
const budgetFile = (root) => path.join(reviewStore(root), "budgets/fixture.json");
function usedBudget(root) {
  const file = budgetFile(root);
  return fs.existsSync(file) ? JSON.parse(readPrivate(file)).used : 0;
}
function callsMade(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}
function jobCount(root) {
  const jobs = path.join(reviewStore(root), "jobs");
  return fs.existsSync(jobs)
    ? fs.readdirSync(jobs).filter((name) => !name.endsWith(".tmp")).length
    : 0;
}
async function limitFailure(run) {
  try {
    await run();
  } catch (error) {
    assert.ok(isReviewLimitError(error), `expected ReviewLimitError, got: ${error?.stack}`);
    return error;
  }
  assert.fail("expected ReviewLimitError");
}
function assertReconciles(error, actualBytes) {
  assert.equal(error.diagnostic.actualBytes, actualBytes);
  assert.equal(error.diagnostic.sizeKnown, true);
  assert.equal(error.diagnostic.lowerBoundBytes, null);
  const sum = error.diagnostic.breakdown.reduce((total, item) => total + item.bytes, 0);
  assert.equal(sum, actualBytes);
  const sections = error.diagnostic.breakdown.map((item) => item.section);
  for (const section of ["prompt-wrapper", "json-envelope", "contract", "review_index"])
    assert.ok(sections.includes(section), `missing breakdown section ${section}`);
}
function bigDiff(marker, bytes = 600000) {
  return `diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1 +1 @@\n-baseline\n+${marker.repeat(bytes)}\n`;
}

test("limits: resolver precedence, integer boundaries and invalid config reject free", async (t) => {
  assert.deepEqual(resolveReviewLimit(undefined, {}), {
    version: 1,
    maxBytes: DEFAULT_REVIEW_MAX_BYTES,
    source: "default",
  });
  assert.deepEqual(resolveReviewLimit(undefined, { SPECFLOW_AUDIT_MAX_BYTES: "" }), {
    version: 1,
    maxBytes: DEFAULT_REVIEW_MAX_BYTES,
    source: "default",
  });
  assert.deepEqual(resolveReviewLimit(undefined, { SPECFLOW_AUDIT_MAX_BYTES: "4194304" }), {
    version: 1,
    maxBytes: 4194304,
    source: "environment",
  });
  assert.deepEqual(resolveReviewLimit(1024, { SPECFLOW_AUDIT_MAX_BYTES: "4194304" }), {
    version: 1,
    maxBytes: 1024,
    source: "argument",
  });
  assert.deepEqual(retainedReviewLimit({ id: "legacy" }), {
    version: 1,
    maxBytes: DEFAULT_REVIEW_MAX_BYTES,
    source: "default",
    legacy: true,
  });
  assert.deepEqual(
    retainedReviewLimit({
      id: "sealed",
      review_limit: { version: 1, maxBytes: 4194304, source: "environment" },
    }),
    { version: 1, maxBytes: 4194304, source: "environment", legacy: false },
  );
  await assert.rejects(
    async () => retainedReviewLimit({ review_limit: { version: 2, maxBytes: 1024 } }),
    (error) => error.code === "REVIEW_LIMIT_BINDING",
  );
  for (const boundary of [1, 524288, 4194304, MAX_REVIEW_MAX_BYTES])
    assert.equal(resolveReviewLimit(boundary, {}).maxBytes, boundary);
  for (const invalid of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_REVIEW_MAX_BYTES + 1,
  ]) {
    const error = await limitFailure(() => resolveReviewLimit(invalid, {}));
    assert.equal(error.code, "REVIEW_LIMIT_INVALID");
    assert.equal(error.category, "review-config");
    assert.equal(error.stage, "resolve");
    assert.equal(error.diagnostic.source, "argument");
  }
  for (const invalid of ["0", "-1", "1.5", "1e6", "1024abc", "1024 ", " 1024", "+1", "16777217"]) {
    const error = await limitFailure(() =>
      resolveReviewLimit(undefined, { SPECFLOW_AUDIT_MAX_BYTES: invalid }),
    );
    assert.equal(error.code, "REVIEW_LIMIT_INVALID");
    assert.equal(error.diagnostic.source, "environment");
  }
  const f = fixture(t);
  environment(t, { SPECFLOW_AUDIT_MAX_BYTES: "0" });
  const configError = await limitFailure(() => review(f.root, { mode: "proposal", id: "S1" }));
  assert.equal(configError.diagnostic.stage, "resolve");
  const explicitError = await limitFailure(() =>
    review(f.root, { mode: "proposal", id: "S1", maxBytes: 0 }),
  );
  assert.equal(explicitError.diagnostic.source, "argument");
  assert.equal(jobCount(f.root), 0);
  assert.equal(fs.existsSync(budgetFile(f.root)), false);
});

test("limits: exact UTF-8 packet boundary, reconciling breakdown and no over-limit job", async (t) => {
  const body = `${"中".repeat(80000)}\n\n${'"quotes" and \\backslash\\ escapes '.repeat(280)}`;
  const spec = writeFrontmatter(`# Contract\n\n${body}\n`, {
    id: "S1",
    status: "approved",
    review: { decision: "approved" },
    evidence: { e2e: [], migrations: [], human: [] },
    review_inputs: { context_files: ["ctx1.txt", "ctx2.txt"], proposal_reviews: [] },
  });
  const f = fixture(t, {
    spec,
    files: { "ctx1.txt": "c".repeat(64000), "ctx2.txt": "d".repeat(64000) },
  });
  environment(t, {});
  let prepared = await review(f.root, { mode: "proposal", id: "S1", maxBytes: 2000000 });
  let actual = fs.statSync(prepared.packetPath).size;
  // The sealed limit itself is serialized into the packet, so converge on the
  // fixed point where the packet bytes no longer change with the limit.
  for (let i = 0; i < 4; i++) {
    prepared = await review(f.root, { mode: "proposal", id: "S1", maxBytes: actual });
    const next = fs.statSync(prepared.packetPath).size;
    if (next === actual) break;
    actual = next;
  }
  assert.ok(actual > DEFAULT_REVIEW_MAX_BYTES, `expected >512KiB packet, got ${actual}`);
  assert.equal(
    String(actual).length,
    String(actual - 1).length,
    "boundary fixture must keep digits",
  );
  assert.equal(prepared.receipt.packet_bytes, actual);
  assert.equal(prepared.reviewLimit.source, "argument");
  const packet = fs.readFileSync(prepared.packetPath, "utf8");
  assert.ok(packet.includes("中"), "UTF-8 contract bytes must be retained");
  assert.ok(packet.includes(" escapes"));

  const jobs = jobCount(f.root);
  const error = await limitFailure(() =>
    review(f.root, { mode: "proposal", id: "S1", maxBytes: actual - 1 }),
  );
  assert.equal(error.code, "REVIEW_PACKET_LIMIT");
  assert.equal(error.category, "review-limit");
  assert.equal(error.stage, "seal");
  assert.equal(error.diagnostic.limitBytes, actual - 1);
  assert.equal(error.diagnostic.source, "argument");
  assert.match(error.message, /exceeds limit/);
  assertReconciles(error, actual);
  assert.equal(jobCount(f.root), jobs);
  assert.equal(usedBudget(f.root), 0);
  assert.equal(fs.existsSync(budgetFile(f.root)), false);
});

test("limits: sealed environment policy survives lower/invalid env and replay stays free", async (t) => {
  const f = fixture(t);
  f.write("code.txt", `${"x".repeat(600000)}\n`);
  const head = f.commit();
  const fakeReviewer = fake(t);
  environment(t, {
    SPECFLOW_AUDIT_MAX_BYTES: "4194304",
    SPECFLOW_AUDIT_BIN: fakeReviewer.file,
  });
  grant(f.root, 2);
  const prepared = await review(f.root, { id: "S1", base: f.base, head });
  assert.equal(prepared.reviewLimit.source, "environment");
  assert.equal(prepared.reviewLimit.maxBytes, 4194304);
  assert.ok(fs.statSync(prepared.packetPath).size > DEFAULT_REVIEW_MAX_BYTES);

  process.env.SPECFLOW_AUDIT_MAX_BYTES = "1.5";
  const status = reviewStatus(f.root, prepared.jobId);
  assert.equal(status.state, "prepared");
  assert.equal(status.reviewLimit.maxBytes, 4194304);
  const complete = await review(f.root, {
    action: "run",
    jobId: prepared.jobId,
    budgetId: "fixture",
  });
  assert.equal(complete.state, "completed");
  assert.equal(complete.receipt.child_input_sha256, complete.receipt.packet_sha256);
  assert.equal(digest(fs.readFileSync(fakeReviewer.captured)), complete.receipt.packet_sha256);
  assert.equal(usedBudget(f.root), 1);
  assert.equal(callsMade(fakeReviewer.calls), 1);

  process.env.SPECFLOW_AUDIT_MAX_BYTES = "1";
  const replay = await review(f.root, { action: "run", jobId: prepared.jobId });
  assert.equal(replay.state, "completed");
  assert.equal(replay.reviewLimit.maxBytes, 4194304);
  assert.equal(usedBudget(f.root), 1);
  assert.equal(callsMade(fakeReviewer.calls), 1);

  for (const input of [
    { action: "status", jobId: prepared.jobId, maxBytes: 4194304 },
    { action: "run", jobId: prepared.jobId, maxBytes: 4194304, budgetId: "fixture" },
    { action: "repair", jobId: prepared.jobId, maxBytes: 4194304 },
  ])
    await assert.rejects(review(f.root, input), /fields/);
  assert.equal(usedBudget(f.root), 1);

  process.env.SPECFLOW_AUDIT_MAX_BYTES = "1024";
  const explicit = await review(f.root, {
    id: "S1",
    base: f.base,
    head,
    maxBytes: 4194304,
  });
  assert.equal(explicit.reviewLimit.source, "argument");
  assert.equal(explicit.reviewLimit.maxBytes, 4194304);

  delete process.env.SPECFLOW_AUDIT_MAX_BYTES;
  const before = jobCount(f.root);
  const error = await limitFailure(() => review(f.root, { id: "S1", base: f.base, head }));
  assert.equal(error.stage, "git-diff");
  assert.equal(jobCount(f.root), before);

  const { dir, job } = loadJob(f.root, prepared.jobId);
  const packetBytes = fs.readFileSync(path.join(dir, "packet.md"));
  delete job.review_limit;
  saveJob(dir, job);
  const deleted = await limitFailure(() => reviewStatus(f.root, prepared.jobId));
  assert.equal(deleted.code, "REVIEW_PACKET_LIMIT");
  assert.equal(deleted.stage, "read");
  assert.equal(deleted.diagnostic.actualBytes, packetBytes.length);
  assert.equal(deleted.diagnostic.limitBytes, DEFAULT_REVIEW_MAX_BYTES);
  assert.equal(usedBudget(f.root), 1);
  assert.equal(callsMade(fakeReviewer.calls), 1);
});

test("limits: legacy bytes and free repair remain, removed/tampered metadata never bypasses", async (t) => {
  const f = fixture(t),
    fakeReviewer = fake(t);
  environment(t, { SPECFLOW_AUDIT_BIN: fakeReviewer.file });
  grant(f.root, 2);
  const prepared = await review(f.root, { mode: "proposal", id: "S1" });
  const { dir, job } = loadJob(f.root, prepared.jobId);
  seedLegacyReviewFixture(dir, job);
  saveJob(dir, job);
  const packet = fs.readFileSync(path.join(dir, "packet.md"));
  process.env.SPECFLOW_AUDIT_MAX_BYTES = "4194304";
  const status = reviewStatus(f.root, prepared.jobId);
  assert.equal(status.reviewLimit.legacy, true);
  assert.equal(status.reviewLimit.maxBytes, DEFAULT_REVIEW_MAX_BYTES);
  assert.equal(status.reviewLimit.source, "default");
  assert.equal(status.receipt.review_limit, undefined);
  assert.equal(status.receipt.packet_bytes, packet.length);
  assert.equal(digest(packet), status.receipt.packet_sha256);
  const legacyRun = await review(f.root, {
    action: "run",
    jobId: prepared.jobId,
    budgetId: "fixture",
  });
  assert.equal(legacyRun.state, "completed");
  assert.equal(legacyRun.outputInfo.category, "protocol-error");
  assert.equal(legacyRun.outputInfo.repairable, true);
  assert.equal(callsMade(fakeReviewer.calls), 1);
  assert.equal(usedBudget(f.root), 1);
  const beforeBudget = fs.readFileSync(budgetFile(f.root));
  const repaired = await review(f.root, { action: "repair", jobId: prepared.jobId });
  assert.equal(repaired.receipt.model_invoked, false);
  assert.equal(repaired.receipt.review_limit, undefined);
  assert.equal(callsMade(fakeReviewer.calls), 1);
  assert.deepEqual(fs.readFileSync(budgetFile(f.root)), beforeBudget);

  const sealed = await review(f.root, { mode: "proposal", id: "S1" });
  const sealedJob = loadJob(f.root, sealed.jobId);
  const originalJob = structuredClone(sealedJob.job);
  delete sealedJob.job.review_limit;
  saveJob(sealedJob.dir, sealedJob.job);
  const missing = await limitFailure(() => reviewStatus(f.root, sealed.jobId));
  assert.equal(missing.code, "REVIEW_LIMIT_BINDING");
  assert.equal(missing.diagnostic.nextActions.at(-1)?.requiresHuman, true);
  saveJob(sealedJob.dir, originalJob);

  sealedJob.job.review_limit = {
    ...originalJob.review_limit,
    maxBytes: MAX_REVIEW_MAX_BYTES,
  };
  saveJob(sealedJob.dir, sealedJob.job);
  const widened = await limitFailure(() => reviewStatus(f.root, sealed.jobId));
  assert.equal(widened.code, "REVIEW_LIMIT_BINDING");
  sealedJob.job.review_limit = { ...originalJob.review_limit, maxBytes: MAX_REVIEW_MAX_BYTES + 1 };
  saveJob(sealedJob.dir, sealedJob.job);
  const invalid = await limitFailure(() => reviewStatus(f.root, sealed.jobId));
  assert.equal(invalid.code, "REVIEW_LIMIT_BINDING");
  saveJob(sealedJob.dir, originalJob);

  const packetPath = path.join(sealedJob.dir, "packet.md");
  const packetText = fs.readFileSync(packetPath, "utf8"),
    start = packetText.indexOf("\n\n{") + 2,
    end = packetText.indexOf("\n\nReturn only strict JSON:", start),
    packetObject = packetData(packetText);
  packetObject.bindings.review_limit = {
    ...packetObject.bindings.review_limit,
    maxBytes: MAX_REVIEW_MAX_BYTES,
  };
  const rebound = `${packetText.slice(0, start)}${JSON.stringify(packetObject, null, 2)}${packetText.slice(end)}`;
  fs.writeFileSync(packetPath, rebound);
  sealedJob.job.packet_sha256 = digest(rebound);
  sealedJob.job.packet_bytes = Buffer.byteLength(rebound);
  sealedJob.job.scan = { ...sealedJob.job.scan, packet_sha256: sealedJob.job.packet_sha256 };
  saveJob(sealedJob.dir, sealedJob.job);
  const reboundError = await limitFailure(() => reviewStatus(f.root, sealed.jobId));
  assert.equal(reboundError.code, "REVIEW_LIMIT_BINDING");
  fs.writeFileSync(packetPath, packetText);
  saveJob(sealedJob.dir, originalJob);

  fs.appendFileSync(packetPath, "tamper");
  assert.throws(() => reviewStatus(f.root, sealed.jobId), /changed/);
  assert.equal(callsMade(fakeReviewer.calls), 1);
  assert.equal(usedBudget(f.root), 1);
});

test("limits: Git early stop reports a provable lower bound, never a fake total", async (t) => {
  const f = fixture(t);
  f.write("code.txt", `${"y".repeat(600000)}\n`);
  const head = f.commit();
  environment(t, {});
  const jobs = jobCount(f.root);
  const error = await limitFailure(() => review(f.root, { id: "S1", base: f.base, head }));
  assert.equal(error.code, "REVIEW_PACKET_LIMIT");
  assert.equal(error.stage, "git-diff");
  assert.equal(error.diagnostic.actualBytes, null);
  assert.equal(error.diagnostic.sizeKnown, false);
  assert.ok(error.diagnostic.lowerBoundBytes > DEFAULT_REVIEW_MAX_BYTES);
  assert.equal(error.diagnostic.limitBytes, DEFAULT_REVIEW_MAX_BYTES);
  assert.equal(error.diagnostic.source, "default");
  assert.equal(error.diagnostic.breakdown, null);
  assert.match(error.message, /total size unknown/);
  assert.equal(jobCount(f.root), jobs);
});

test("limits: blob/context/index limits stay independent of the packet limit", async (t) => {
  const contextSpec = writeFrontmatter("# Contract\n\n- [ ] implementation\n", {
    id: "S1",
    status: "approved",
    review: { decision: "approved" },
    evidence: { e2e: [], migrations: [], human: [] },
    review_inputs: { context_files: ["ctx.txt"], proposal_reviews: [] },
  });
  const contextFixture = fixture(t, { spec: contextSpec, files: { "ctx.txt": "a".repeat(70000) } });
  environment(t, {});
  await assert.rejects(
    review(contextFixture.root, { mode: "proposal", id: "S1", maxBytes: 4194304 }),
    (error) =>
      error.diagnostic.code === "REVIEW_CONTEXT_FILE_LIMIT" &&
      error.diagnostic.actual === 70000 &&
      error.diagnostic.limit === 65536,
  );

  const oversizedSpec = writeFrontmatter(`# Contract\n\n${"z".repeat(300000)}\n`, {
    id: "S1",
    status: "approved",
    review: { decision: "approved" },
    evidence: { e2e: [], migrations: [], human: [] },
  });
  const blobFixture = fixture(t, { spec: oversizedSpec });
  await assert.rejects(
    review(blobFixture.root, {
      id: "S1",
      base: blobFixture.base,
      head: blobFixture.base,
      maxBytes: 4194304,
      allowDirty: true,
    }),
    /oversize/,
  );

  const units = writeFrontmatter(
    `# Contract\n\n${Array.from({ length: 500 }, (_, i) => `- [ ] item ${i}`).join("\n")}\n`,
    {
      id: "S1",
      status: "approved",
      review: { decision: "approved" },
      evidence: { e2e: [], migrations: [], human: [] },
    },
  );
  const indexFixture = fixture(t, { spec: units });
  await assert.rejects(
    review(indexFixture.root, { mode: "proposal", id: "S1", maxBytes: 4194304 }),
    /unit limit/,
  );
});

test("limits: full working-tree audit seals and runs a >512KiB packet via a detached fake worker", async (t) => {
  const f = fixture(t),
    fakeReviewer = fake(t);
  environment(t, { SPECFLOW_AUDIT_BIN: fakeReviewer.file });
  grant(f.root, 1);
  const spec = findSpec(f.root, "S1");
  const profile = loadProjectProfile(f.root);
  const diff = bigDiff("w", 600000);
  const options = {
    spec,
    content: spec.content,
    profile,
    bindings: {},
    diff,
    impl: {},
  };
  const error = await limitFailure(() => prepareWorkingAudit(f.root, options));
  assert.equal(error.stage, "seal");
  assert.equal(error.diagnostic.sizeKnown, true);
  assertReconciles(error, error.diagnostic.actualBytes);

  const prepared = await prepareWorkingAudit(f.root, { ...options, maxBytes: 4194304 });
  assert.equal(prepared.mode, "working-tree-audit");
  assert.equal(prepared.reviewLimit.source, "argument");
  assert.ok(fs.statSync(prepared.packetPath).size > DEFAULT_REVIEW_MAX_BYTES);
  const complete = await runPreparedReview(f.root, prepared.jobId, { budgetId: "fixture" });
  assert.equal(complete.state, "completed");
  assert.equal(complete.receipt.child_input_sha256, complete.receipt.packet_sha256);
  assert.equal(digest(fs.readFileSync(fakeReviewer.captured)), complete.receipt.packet_sha256);
  assert.equal(usedBudget(f.root), 1);
  assert.equal(callsMade(fakeReviewer.calls), 1);
});
