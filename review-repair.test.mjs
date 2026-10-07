// Disposable fake reviewer only: protocol recovery is not a new model verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { review, reviewStatus, normalizeReviewResult, prepareWorkingAudit, runPreparedReview, authorizeReviewBudget } from "./review-engine.mjs";
import { loadJob, saveJob, reviewStore, digest } from "./review-storage.mjs";
import { writeFrontmatter, findSpec, begin, impl, audit, attest, done, nextStep, buildAuditDiff, specContractHash, recordConsistencyGaps } from "./core.mjs";
const rawPass = { verdict: "pass", criteria: [{ criterion: "product", status: "pass", evidence: "code.txt supplied diff" }],
  scope_deviations: [{ file: "outside.txt", note: "Unchanged observation; preserve quotes \" and newline\nwithout loss" }], findings: [], previous_closure: [], out_of_scope: [] };
function fixture(t, raw = rawPass) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-repair-")), root = path.join(tmp, "repo");
  fs.mkdirSync(path.join(root, "docs/specs"), { recursive: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "docs/specs/S1.md"), writeFrontmatter("# Product\n", { id: "S1", status: "approved", review: { decision: "approved" }, evidence: { e2e: [], migrations: [], human: ["R1"] } }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }));
  fs.writeFileSync(path.join(root, "code.txt"), "baseline\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "mechanical-repair"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"), calls = path.join(tmp, "calls"), fake = path.join(tmp, "fake.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'call\\n');console.log(${JSON.stringify(JSON.stringify(raw))});\n`, { mode: 0o755 });
  const old = process.env.SPECFLOW_AUDIT_BIN; process.env.SPECFLOW_AUDIT_BIN = fake;
  t.after(() => { if (old === undefined) delete process.env.SPECFLOW_AUDIT_BIN; else process.env.SPECFLOW_AUDIT_BIN = old; });
  authorizeReviewBudget(root, { id: "fixture", calls: 1, note: "Disposable synthetic one-call reviewer; no real provider authorization." });
  const budget = path.join(reviewStore(root), "budgets/fixture.json");
  return { root, git, base, calls, budget, write: text => fs.writeFileSync(path.join(root, "code.txt"), text) };
}
function legacy(f, prepared) {
  const { dir, job } = loadJob(f.root, prepared.jobId);
  delete job.result_protocol_version; delete job.prompt_version;
  saveJob(dir, job); // Synthetic legacy precondition, never alter a real receipt.
  return prepared;
}
async function completedLegacy(f) {
  const prepared = legacy(f, await review(f.root, { mode: "proposal", id: "S1" }));
  return runPreparedReview(f.root, prepared.jobId, { budgetId: "fixture" });
}
function freeze(f, id) {
  const { dir } = loadJob(f.root, id);
  return Object.fromEntries([f.budget, path.join(f.root, "docs/specs/S1.md"), ...["job.json", "packet.md", "stdout.txt"].map(name => path.join(dir, name))].map(file => [file, fs.readFileSync(file)]));
}
function unchanged(files) { for (const [file, bytes] of Object.entries(files)) assert.deepEqual(fs.readFileSync(file), bytes, file); }
async function fullLegacy(f) {
  await begin(f.root, "S1"); f.write("implemented\n"); await impl(f.root, "S1");
  const spec = findSpec(f.root, "S1"), fm = spec.frontmatter;
  const diff = await buildAuditDiff(f.root, fm.impl.base_sha, null, { excludePaths: [spec.path] });
  const prepared = legacy(f, await prepareWorkingAudit(f.root, { spec, content: spec.content, profile: spec.profile, diff, impl: fm.impl,
    bindings: { base_sha: fm.impl.base_sha, head: f.git("rev-parse", "HEAD"), snapshot_hash: fm.impl.snapshot_hash,
      scope_sha256: digest(JSON.stringify(null)), diff_sha256: digest(diff), impl_sha256: digest(JSON.stringify(fm.impl)), contract_hash: specContractHash(spec.content) } }));
  return runPreparedReview(f.root, prepared.jobId, { budgetId: "fixture" });
}

test("repair: versioned lossless known scope observations; legacy normalization stays byte-equivalent", () => {
  const raw = structuredClone(rawPass), before = JSON.stringify(raw);
  const old = normalizeReviewResult(raw, { mode: "proposal" });
  assert.equal(old.verdict, "fail"); assert.equal(old.criteria.length, 3);
  const current = normalizeReviewResult(raw, { mode: "proposal", result_protocol_version: 2 });
  assert.equal(current.verdict, "pass"); assert.equal(current.criteria.length, 1);
  assert.deepEqual(JSON.parse(current.scope_deviations[0]), raw.scope_deviations[0]);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(normalizeReviewResult(raw, { mode: "proposal" }), old);
  const legacyBound = normalizeReviewResult({ ...raw, scope_deviations: ["x".repeat(5001)] }, { mode: "proposal" });
  assert.equal(legacyBound.verdict, "pass"); assert.equal(legacyBound.scope_deviations[0].length, 5000);
  for (const scope of [[{ file: "p", note: "n", blocking: true }], [3], [{ file: "p", note: "" }], Array(101).fill({ file: "p", note: "n" }), [{ file: "p", note: "x".repeat(5001) }], ["x".repeat(5001)], ["x".repeat(5001), { file: "p", note: "n" }]]) {
    assert.equal(normalizeReviewResult({ ...raw, scope_deviations: scope }, { mode: "proposal", result_protocol_version: 2 }).verdict, "fail");
  }
});

test("repair: new packet explicitly types scope items and pins prompt/result versions", async t => {
  const f = fixture(t), prepared = await review(f.root, { mode: "proposal", id: "S1" });
  assert.equal(prepared.receipt.result_protocol_version, 2); assert.equal(prepared.receipt.prompt_version, 4);
  assert.match(fs.readFileSync(prepared.packetPath, "utf8"), /scope_deviations.*string\[\]/);
  assert.match(fs.readFileSync(prepared.packetPath, "utf8"), /file.*note.*lossless/i);
});

test("repair: exhausted grant permits explicit derived repair/free replay, not original rewriting or respawn", async t => {
  const f = fixture(t), original = await completedLegacy(f), frozen = freeze(f, original.jobId);
  assert.equal(original.result.verdict, "fail");
  const status = reviewStatus(f.root, original.jobId);
  assert.equal(status.outputInfo.category, "protocol-error"); assert.equal(status.outputInfo.repairable, true);
  assert.deepEqual(status.outputInfo.repairInput, { action: "repair", jobId: original.jobId });
  const fixed = await review(f.root, { action: "repair", jobId: original.jobId });
  assert.notEqual(fixed.jobId, original.jobId); assert.equal(fixed.modelInvoked, false);
  assert.equal(fixed.result.verdict, "pass"); assert.equal(fixed.receipt.result_protocol_version, 2);
  assert.equal(fixed.receipt.recovery.source_job_id, original.jobId);
  assert.deepEqual(fixed.receipt.bindings, original.receipt.bindings); assert.deepEqual(fixed.receipt.budget, original.receipt.budget);
  assert.equal(fixed.receipt.raw_sha256, original.receipt.raw_sha256); assert.equal(fixed.receipt.packet_sha256, original.receipt.packet_sha256);
  assert.equal((await review(f.root, { action: "repair", jobId: original.jobId })).jobId, fixed.jobId);
  assert.equal((await review(f.root, { action: "repair", jobId: fixed.jobId })).jobId, fixed.jobId);
  assert.equal((await review(f.root, { action: "run", jobId: fixed.jobId })).result.verdict, "pass");
  assert.equal(reviewStatus(f.root, original.jobId).result.verdict, "fail");
  assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n"); unchanged(frozen);
});

test("repair: unknown fields, semantic fabrication parameters and incomplete/cancelled sources reject free", async t => {
  const f = fixture(t, { ...rawPass, scope_deviations: [{ file: "p", note: "n", blocking: true }] });
  const original = await completedLegacy(f), frozen = freeze(f, original.jobId);
  assert.equal(reviewStatus(f.root, original.jobId).outputInfo.repairable, false);
  await assert.rejects(review(f.root, { action: "repair", jobId: original.jobId }), /repair|protocol|scope/i);
  for (const extra of [{ budgetId: "fixture" }, { verdict: "pass" }, { criteria: [] }, { mode: "proposal" }]) {
    await assert.rejects(review(f.root, { action: "repair", jobId: original.jobId, ...extra }), /fields/);
  }
  unchanged(frozen); assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n");
  const prepared = await review(f.root, { mode: "proposal", id: "S1" });
  await assert.rejects(review(f.root, { action: "repair", jobId: prepared.jobId }), /completed/);
  const { dir, job } = loadJob(f.root, original.jobId); job.state = "cancelled"; saveJob(dir, job);
  await assert.rejects(review(f.root, { action: "repair", jobId: original.jobId }), /completed/);
});

test("repair: genuine product FAIL remains FAIL after protocol correction", async t => {
  const f = fixture(t, { ...rawPass, verdict: "fail", criteria: [{ criterion: "product", status: "fail", evidence: "actual missing behavior" }] });
  const original = await completedLegacy(f), fixed = await review(f.root, { action: "repair", jobId: original.jobId });
  assert.equal(fixed.result.verdict, "fail"); assert.equal(fixed.outputInfo.category, "product-fail");
  assert.deepEqual(fixed.result.criteria, [{ criterion: "product", status: "fail", evidence: "actual missing behavior" }]);
  assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n");
});

test("repair: derived proof rejects tampered source metadata/raw/packet/result and derived bindings", async t => {
  const f = fixture(t), original = await completedLegacy(f), fixed = await review(f.root, { action: "repair", jobId: original.jobId });
  const { dir: sourceDir } = loadJob(f.root, original.jobId);
  for (const name of ["packet.md", "stdout.txt", "job.json"]) {
    const file = path.join(sourceDir, name), before = fs.readFileSync(file);
    fs.appendFileSync(file, name === "job.json" ? " " : "tamper");
    assert.throws(() => reviewStatus(f.root, fixed.jobId), /changed|mismatch|source/i);
    fs.writeFileSync(file, before);
  }
  const { dir, job } = loadJob(f.root, fixed.jobId); job.bindings.contract_hash = "changed"; saveJob(dir, job);
  assert.throws(() => reviewStatus(f.root, fixed.jobId), /binding|source|mismatch/i);
  assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n");
});

test("repair: full lifecycle protocol error gives actionable free fix, repaired bound proof can attach/attest/done", async t => {
  const f = fixture(t), original = await fullLegacy(f);
  assert.match(await audit(f.root, "S1", { reviewJobId: original.jobId }), /协议|PROTOCOL|工具/);
  assert.match(await nextStep(f.root, findSpec(f.root, "S1")), /repair/);
  await assert.rejects(async () => attest(f.root, "S1", "R1", "Synthetic mechanical fixture only, never real human evidence."), /repair/);
  const frozen = freeze(f, original.jobId), fixed = await review(f.root, { action: "repair", jobId: original.jobId }); unchanged(frozen);
  assert.match(await audit(f.root, "S1", { reviewJobId: fixed.jobId }), /PASS/);
  const attached = findSpec(f.root, "S1");
  assert.equal(attached.frontmatter.audit.review.recovery.source_job_id, original.jobId);
  const malformed = { ...attached, frontmatter: structuredClone(attached.frontmatter) };
  malformed.frontmatter.audit.review.recovery.source_job_sha256 = "not-a-hash";
  assert.ok(recordConsistencyGaps(malformed).some(gap => gap.includes("repair 来源")));
  assert.match(await attest(f.root, "S1", "R1", "Synthetic mechanical fixture only, never real human evidence."), /已登记/);
  assert.match(await done(f.root, "S1"), /已完成/);
  assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n");
});

test("repair: ordinary proof cannot attach and PASS cannot swallow a genuine blocking finding", async t => {
  const f = fixture(t), ordinary = await completedLegacy(f), fixed = await review(f.root, { action: "repair", jobId: ordinary.jobId });
  await begin(f.root, "S1"); f.write("implemented\n"); await impl(f.root, "S1");
  assert.match(await audit(f.root, "S1", { reviewJobId: fixed.jobId }), /ordinary\/delta results cannot attach/);
  const blocked = { ...rawPass, findings: [{ id: "F1", classification: "introduced-by-diff", blocking: true, file: "code.txt", line: 1, evidence: "real changed-hunk blocker" }] };
  assert.equal(normalizeReviewResult(blocked, { mode: "committed", result_protocol_version: 2 }).verdict, "fail");
  assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n");
});

test("repair: interrupted derived publication leaves original intact and retry needs no new review", async t => {
  const f = fixture(t), original = await completedLegacy(f), frozen = freeze(f, original.jobId);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (/review-v1\/jobs\/[a-f0-9]{32}$/.test(to)) throw new Error("fixture publication error"); return rename(from, to); };
  try { await assert.rejects(review(f.root, { action: "repair", jobId: original.jobId }), /publication error/); }
  finally { fs.renameSync = rename; }
  unchanged(frozen);
  assert.equal(fs.readdirSync(path.join(reviewStore(f.root), "jobs")).some(name => name.endsWith(".tmp")), false);
  assert.equal((await review(f.root, { action: "repair", jobId: original.jobId })).result.verdict, "pass");
  assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n");
});

test("repair: changed contract/implementation never inherits historical PASS", async t => {
  const f = fixture(t), original = await fullLegacy(f), fixed = await review(f.root, { action: "repair", jobId: original.jobId });
  f.write("changed after original review\n");
  await assert.rejects(audit(f.root, "S1", { reviewJobId: fixed.jobId }), /implementation changed/);
  await impl(f.root, "S1");
  assert.match(await audit(f.root, "S1", { reviewJobId: fixed.jobId }), /binding mismatch/);
  assert.notEqual(findSpec(f.root, "S1").frontmatter.audit.verdict, "pass");
  assert.equal(fs.readFileSync(f.calls, "utf8"), "call\n");
});
