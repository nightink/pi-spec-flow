// S2.2 A6–A8: free audit prepare, machine outcomes, CLI/board diagnostics.
// Synthetic fixtures only: the fake auditor is a plumbing oracle, not a model.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  audit,
  auditOutcome,
  begin,
  buildAuditDiff,
  findSpec,
  impl,
  implOutcome,
  inspectBoard,
  prepareAudit,
  writeFrontmatter,
} from "../src/core.mjs";
import { authorizeReviewBudget } from "../src/review-engine.mjs";
import { loadJob, reviewStore } from "../src/review-storage.mjs";

const SPEC = writeFrontmatter("# Product\n\n- [ ] implementation\n", {
  id: "S1",
  status: "approved",
  review: { decision: "approved" },
  evidence: { e2e: [], migrations: [], human: [] },
});

const PASS_RESULT = {
  verdict: "pass",
  criteria: [{ criterion: "code", status: "pass", evidence: "code.txt diff" }],
  scope_deviations: [],
};

function fixture(t, { spec = SPEC, scripts = { test: "node -e 'process.exit(0)'" } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-agent-workflow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({
    "docs/specs/S1.md": spec,
    "package.json": JSON.stringify({ scripts }),
    "code.txt": "baseline\n",
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  }
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "mechanical-fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-qm", "fixture", "--allow-empty");
  return {
    root,
    git,
    write: (file, text) => fs.writeFileSync(path.join(root, file), text),
    specPath: path.join(root, "docs/specs/S1.md"),
    ledgerPath: path.join(root, ".spec-flow-ledger.jsonl"),
  };
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function ledgerLines(file) {
  return readIfExists(file).split("\n").filter(Boolean).length;
}

function fake(t, result = PASS_RESULT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-agent-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake.mjs");
  const calls = path.join(dir, "calls");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nimport fs from 'node:fs';import {mechanicalCoverage} from ${JSON.stringify(new URL("../../../tests/helpers/review-fixture.mjs", import.meta.url).href)};fs.appendFileSync(${JSON.stringify(calls)},'call\\n');console.log(JSON.stringify(mechanicalCoverage(${JSON.stringify(result)},fs.readFileSync(process.argv.at(-1).slice(1),'utf8'))));\n`,
    { mode: 0o755 },
  );
  const previous = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = file;
  t.after(() => {
    if (previous === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = previous;
  });
  return { calls, file };
}

function fakeCoverageGap(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-agent-gap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake.mjs");
  const fixtureModule = JSON.stringify(
    new URL("../../../tests/helpers/review-fixture.mjs", import.meta.url).href,
  );
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nimport fs from 'node:fs';import {mechanicalCoverage,packetData} from ${fixtureModule};const packet=fs.readFileSync(process.argv.at(-1).slice(1),'utf8');const data=packetData(packet);const raw=mechanicalCoverage({verdict:'pass',criteria:[{id:'CE',kind:'evidence',criterion:'prescribed evidence gap',status:'fail',evidence:'synthetic gap only'}],scope_deviations:[],findings:[],previous_closure:[],out_of_scope:[]},data);const unit=data.review_index.units.find((item)=>item.kind==='acceptance');const row=raw.coverage.find((item)=>item.id===unit.id);row.disposition='gap';row.acceptance_ids=[];row.criterion_ids=['CE'];row.evidence='prescribed synthetic gap';console.log(JSON.stringify(raw));\n`,
    { mode: 0o755 },
  );
  const previous = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = file;
  t.after(() => {
    if (previous === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = previous;
  });
}

function grant(root, calls = 1) {
  return authorizeReviewBudget(root, {
    id: "fixture",
    calls,
    note: "Synthetic free/paid audit boundary tests only; never a real review authorization.",
  });
}

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function jobIds(root) {
  const dir = path.join(reviewStore(root), "jobs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

async function passingLifecycle(t, options) {
  const f = fixture(t, options);
  await begin(f.root, "S1");
  f.write("code.txt", "implemented\n");
  await impl(f.root, "S1");
  return f;
}

// ─── board ──────────────────────────────────────────────────────────────────
test("inspectBoard: default is explicit record-only and never writes lifecycle", async (t) => {
  const f = fixture(t);
  await begin(f.root, "S1");
  const specBefore = fs.readFileSync(f.specPath);
  const ledgerBefore = ledgerLines(f.ledgerPath);

  const board = await inspectBoard(f.root);
  assert.equal(board.version, 1);
  assert.equal(board.freshness, "record-only");
  assert.match(board.note, /record-only/);
  assert.equal(board.specs.length, 1);
  const [entry] = board.specs;
  assert.equal(entry.id, "S1");
  assert.equal(entry.status, "in-progress");
  assert.equal(entry.statusLabel, "进行中");
  assert.equal(entry.stage, "impl");
  assert.equal(entry.fresh, null);
  assert.equal(entry.nextActions.length, 1);
  assert.equal(entry.nextActions[0].tool, "spec_impl");
  assert.deepEqual(entry.nextActions[0].args, { id: "S1" });
  assert.equal(entry.nextActions[0].requiresAuthorization, false);
  assert.equal(entry.nextActions[0].requiresHuman, false);
  assert.deepEqual(fs.readFileSync(f.specPath), specBefore);
  assert.equal(ledgerLines(f.ledgerPath), ledgerBefore);

  f.write("code.txt", "implemented\n");
  await impl(f.root, "S1");
  const afterImplSpec = fs.readFileSync(f.specPath);
  const afterImplLedger = ledgerLines(f.ledgerPath);
  const auditReady = await inspectBoard(f.root, { id: "S1" });
  assert.equal(auditReady.specs[0].stage, "audit");
  assert.equal(auditReady.specs[0].nextActions[0].tool, "spec_audit");
  assert.deepEqual(auditReady.specs[0].nextActions[0].args, {
    action: "prepare",
    id: "S1",
  });
  assert.deepEqual(fs.readFileSync(f.specPath), afterImplSpec);
  assert.equal(ledgerLines(f.ledgerPath), afterImplLedger);
});

test("inspectBoard: live freshness routes stale implementation/contract to impl, never done", async (t) => {
  const f = await passingLifecycle(t);
  const calls = fake(t);
  grant(f.root, 1);
  assert.match(await audit(f.root, "S1", { budgetId: "fixture" }), /✅ PASS/);
  assert.equal(fs.readFileSync(calls.calls, "utf8"), "call\n");

  const fresh = await inspectBoard(f.root, { live: true });
  assert.equal(fresh.freshness, "live");
  assert.equal(fresh.specs[0].stage, "done-ready");
  assert.equal(fresh.specs[0].fresh, true);
  assert.equal(fresh.specs[0].nextActions[0].tool, "spec_done");
  assert.equal(fresh.summary.stale, 0);

  f.write("code.txt", "changed after audit\n");
  const stale = await inspectBoard(f.root, { live: true });
  assert.equal(stale.specs[0].stage, "impl");
  assert.equal(stale.specs[0].fresh, false);
  assert.equal(stale.specs[0].nextActions[0].tool, "spec_impl");
  assert.ok(stale.specs[0].blockers.some((blocker) => /live/.test(blocker)));
  assert.ok(!stale.specs[0].nextActions.some((action) => action.tool === "spec_done"));
  assert.equal(stale.summary.stale, 1);

  // record-only still reports the recorded bindings as green; it never claims live freshness.
  const recordOnly = await inspectBoard(f.root);
  assert.equal(recordOnly.freshness, "record-only");
  assert.equal(recordOnly.specs[0].fresh, null);

  // Contract drift is a record-level binding and must route to impl even without live.
  fs.appendFileSync(f.specPath, "\nAdditional contract obligation.\n");
  const drift = await inspectBoard(f.root);
  assert.equal(drift.specs[0].stage, "impl");
  assert.equal(drift.specs[0].nextActions[0].tool, "spec_impl");
  assert.ok(drift.specs[0].blockers.some((blocker) => /合同/.test(blocker)));
  assert.equal(fs.readFileSync(calls.calls, "utf8"), "call\n", "board never calls a model");
});

test("inspectBoard: draft and failing impl get stable free/recovery stages", async (t) => {
  const draft = fixture(t, {
    spec: writeFrontmatter("# Draft\n\n- 状态：草案\n", {
      id: "S1",
      status: "draft",
      evidence: { e2e: [], migrations: [], human: [] },
    }),
  });
  const draftBoard = await inspectBoard(draft.root);
  assert.equal(draftBoard.specs[0].stage, "proposal");
  assert.equal(draftBoard.specs[0].nextActions.length, 1);
  assert.equal(draftBoard.specs[0].nextActions[0].tool, "spec_review");
  assert.equal(draftBoard.specs[0].nextActions[0].args.mode, "proposal");
  assert.equal(draftBoard.specs[0].nextActions[0].requiresAuthorization, false);
  assert.ok(draftBoard.specs[0].blockers.some((blocker) => /approval/.test(blocker)));

  const failing = fixture(t, { scripts: { test: "node -e 'process.exit(1)'" } });
  await begin(failing.root, "S1");
  failing.write("code.txt", "implemented\n");
  await impl(failing.root, "S1");
  const failingBoard = await inspectBoard(failing.root);
  assert.equal(failingBoard.specs[0].stage, "impl-fail");
  assert.ok(failingBoard.specs[0].blockers.some((blocker) => /门禁未通过/.test(blocker)));
  assert.equal(failingBoard.specs[0].nextActions[0].tool, "spec_impl");
});

test("inspectBoard: approval and human blockers never fabricate authorization", async (t) => {
  const approvalFixture = fixture(t, {
    spec: writeFrontmatter("# Product\n\n- [ ] implementation\n", {
      id: "S1",
      status: "approved",
      review: { decision: "pending" },
      evidence: { e2e: [], migrations: [], human: [] },
    }),
  });
  const approvalBoard = await inspectBoard(approvalFixture.root);
  assert.equal(approvalBoard.specs[0].stage, "approval");
  assert.equal(approvalBoard.specs[0].nextActions.length, 0);
  assert.ok(approvalBoard.specs[0].blockers.some((blocker) => /approval/.test(blocker)));

  const f = fixture(t, {
    spec: writeFrontmatter("# Product\n\n- [ ] implementation\n", {
      id: "S1",
      status: "approved",
      review: { decision: "approved" },
      evidence: { e2e: [], migrations: [], human: ["R1"] },
    }),
  });
  await begin(f.root, "S1");
  f.write("code.txt", "implemented\n");
  await impl(f.root, "S1");
  fake(t);
  grant(f.root, 1);
  assert.match(await audit(f.root, "S1", { budgetId: "fixture" }), /✅ PASS/);

  const human = await inspectBoard(f.root);
  assert.equal(human.specs[0].stage, "attest");
  assert.equal(human.specs[0].nextActions.length, 1);
  assert.equal(human.specs[0].nextActions[0].tool, "spec_attest");
  assert.equal(human.specs[0].nextActions[0].requiresHuman, true);
  assert.deepEqual(human.specs[0].nextActions[0].args, { id: "S1", item: "R1" });
  assert.ok(
    human.specs[0].blockers.every((blocker) => !/成功|通过/.test(blocker)),
    "human blocker is reported, not promoted to done",
  );
});

// ─── free prepare ───────────────────────────────────────────────────────────
test("prepareAudit: free prepared packet, unchanged Spec/ledger, then one authorized attach", async (t) => {
  const f = await passingLifecycle(t);
  setEnv(t, "SPECFLOW_AUDIT_MAX_BYTES", undefined);
  const specBefore = fs.readFileSync(f.specPath);
  const ledgerBefore = ledgerLines(f.ledgerPath);

  const prepared = await prepareAudit(f.root, "S1");
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.modelInvoked, false);
  assert.equal(prepared.state, "prepared");
  assert.match(prepared.jobId, /^[a-f0-9]{32}$/);
  assert.ok(fs.existsSync(prepared.packetPath));
  assert.ok(prepared.bytes > 0);
  assert.equal(prepared.receipt.state, "prepared");
  assert.equal(prepared.receipt.review_limit.source, "default");
  assert.equal(prepared.receipt.review_limit.maxBytes, 524288);
  assert.deepEqual(fs.readFileSync(f.specPath), specBefore);
  assert.equal(ledgerLines(f.ledgerPath), ledgerBefore);
  assert.equal(jobIds(f.root).length, 1);
  assert.equal(
    prepared.nextActions.some((action) => action.requiresAuthorization === true),
    true,
  );

  process.env.SPECFLOW_AUDIT_MAX_BYTES = "4194304";
  const environment = await prepareAudit(f.root, "S1");
  assert.equal(loadJob(f.root, environment.jobId).job.review_limit.source, "environment");
  process.env.SPECFLOW_AUDIT_MAX_BYTES = "";
  const explicit = await prepareAudit(f.root, "S1", { maxBytes: 1048576 });
  assert.equal(loadJob(f.root, explicit.jobId).job.review_limit.source, "argument");
  assert.equal(loadJob(f.root, explicit.jobId).job.review_limit.maxBytes, 1048576);

  const child = fake(t);
  grant(f.root, 2);
  // Current environment limits must not reinterpret the sealed job.
  setEnv(t, "SPECFLOW_AUDIT_MAX_BYTES", "abc");
  const outcome = await auditOutcome(f.root, "S1", {
    reviewJobId: prepared.jobId,
    budgetId: "fixture",
  });
  assert.equal(outcome.pass, true);
  assert.equal(outcome.category, "pass");
  assert.equal(outcome.jobId, prepared.jobId);
  assert.equal(outcome.packetPath, prepared.packetPath);
  assert.equal(fs.readFileSync(child.calls, "utf8"), "call\n");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(reviewStore(f.root), "budgets/fixture.json"))).used,
    1,
  );

  process.env.SPECFLOW_AUDIT_MAX_BYTES = "1";
  const cached = await auditOutcome(f.root, "S1", { reviewJobId: prepared.jobId });
  assert.equal(cached.pass, true);
  assert.equal(fs.readFileSync(child.calls, "utf8"), "call\n", "no second child");
});

test("prepareAudit: run-only parameters and invalid limits are rejected before writing", async (t) => {
  const f = await passingLifecycle(t);
  const beforeJobs = jobIds(f.root).length;
  const specBefore = fs.readFileSync(f.specPath);

  for (const options of [
    { reviewJobId: "a".repeat(32) },
    { budgetId: "fixture" },
    { maxBytes: 0 },
    { maxBytes: 1.5 },
    { maxBytes: "1024" },
    { maxBytes: 16777217 },
  ]) {
    await assert.rejects(prepareAudit(f.root, "S1", options), (error) => {
      assert.ok(error.diagnostic, `expected diagnostic for ${JSON.stringify(options)}`);
      return true;
    });
  }
  const runOnly = await auditOutcome(f.root, "S1", { maxBytes: 1024 });
  assert.equal(runOnly.pass, false);
  assert.equal(runOnly.diagnostic.category, "precondition-error");
  assert.equal(runOnly.diagnostic.code, "WF_PARAMETER");
  await assert.rejects(audit(f.root, "S1", { maxBytes: 1024 }), /maxBytes/);
  const badJob = await auditOutcome(f.root, "S1", { reviewJobId: "short-id" });
  assert.equal(badJob.pass, false);
  assert.equal(badJob.diagnostic.code, "WF_PARAMETER");
  assert.equal(jobIds(f.root).length, beforeJobs);
  assert.deepEqual(fs.readFileSync(f.specPath), specBefore);
});

// ─── machine outcomes ───────────────────────────────────────────────────────
test("implOutcome: gate failure is impl-fail and actionable; pass is machine-pass", async (t) => {
  const failing = fixture(t, { scripts: { test: "node -e 'process.exit(1)'" } });
  await begin(failing.root, "S1");
  failing.write("code.txt", "implemented\n");
  const failed = await implOutcome(failing.root, "S1");
  assert.equal(failed.version, 1);
  assert.equal(failed.operation, "impl");
  assert.equal(failed.pass, false);
  assert.equal(failed.category, "impl-fail");
  assert.equal(failed.diagnostic.code, "IMPL_EVIDENCE_FAILED");
  assert.equal(failed.nextActions[0].tool, "spec_impl");

  const passing = await passingLifecycle(t);
  const passed = await implOutcome(passing.root, "S1");
  assert.equal(passed.pass, true);
  assert.equal(passed.category, "pass");
  assert.equal(passed.nextActions[0].tool, "spec_audit");
  assert.deepEqual(passed.nextActions[0].args, { action: "prepare", id: "S1" });
});

test("auditOutcome: product FAIL, protocol error, execution error stay classified and non-passing", async (t) => {
  const product = await passingLifecycle(t);
  fake(t, {
    verdict: "fail",
    criteria: [{ criterion: "code", status: "fail", evidence: "real bug" }],
    scope_deviations: [],
  });
  grant(product.root, 1);
  const productOutcome = await auditOutcome(product.root, "S1", { budgetId: "fixture" });
  assert.equal(productOutcome.pass, false);
  assert.equal(productOutcome.category, "product-fail");
  assert.equal(productOutcome.nextActions[0].tool, "spec_audit");
  assert.equal(productOutcome.nextActions[0].args.action, "prepare");

  const protocol = await passingLifecycle(t);
  fake(t, {
    verdict: "pass",
    criteria: [{ criterion: "code", status: "pass", evidence: "scope malformed" }],
    scope_deviations: [42],
  });
  grant(protocol.root, 1);
  const protocolOutcome = await auditOutcome(protocol.root, "S1", { budgetId: "fixture" });
  assert.equal(protocolOutcome.pass, false);
  assert.equal(protocolOutcome.category, "protocol-error");
  assert.ok(protocolOutcome.jobId);
  assert.equal(protocolOutcome.nextActions[0].tool, "spec_review");
  assert.equal(protocolOutcome.nextActions[0].args.action, "status");

  const execution = await passingLifecycle(t);
  fake(t);
  const executionOutcome = await auditOutcome(execution.root, "S1");
  assert.equal(executionOutcome.pass, false);
  assert.equal(executionOutcome.category, "execution-error");
  assert.match(executionOutcome.diagnostic.code, /REVIEW_EXECUTION/);
  const executionBoard = await inspectBoard(execution.root);
  // The child never started: the sealed job is still prepared and can only be
  // resumed through an explicitly authorized attach, never auto-respawned.
  assert.equal(executionBoard.specs[0].stage, "audit");
  assert.deepEqual(
    executionBoard.specs[0].nextActions.map((action) => action.args.action),
    ["status", undefined],
  );
  assert.equal(executionBoard.specs[0].nextActions[0].requiresAuthorization, false);
  assert.equal(executionBoard.specs[0].nextActions[1].requiresAuthorization, true);
  assert.equal(executionBoard.specs[0].nextActions[1].args.reviewJobId, executionOutcome.jobId);

  const coverage = await passingLifecycle(t);
  fakeCoverageGap(t);
  grant(coverage.root, 1);
  const coverageOutcome = await auditOutcome(coverage.root, "S1", { budgetId: "fixture" });
  assert.equal(coverageOutcome.pass, false);
  assert.equal(coverageOutcome.category, "coverage-gap");
  assert.equal(coverageOutcome.nextActions[0].tool, "spec_review");
  assert.equal(coverageOutcome.nextActions[0].args.action, "status");
  const coverageBoard = await inspectBoard(coverage.root);
  assert.equal(coverageBoard.specs[0].stage, "audit-coverage");
});

test("auditOutcome: unverifiable cached evidence never reuses the old PASS", async (t) => {
  const f = await passingLifecycle(t);
  const child = fake(t);
  grant(f.root, 1);
  assert.match(await audit(f.root, "S1", { budgetId: "fixture" }), /✅ PASS/);
  const jobId = findSpec(f.root, "S1").frontmatter.audit.review.job_id;
  fs.appendFileSync(path.join(reviewStore(f.root), "jobs", jobId, "stdout.txt"), "tampered");

  const outcome = await auditOutcome(f.root, "S1", { budgetId: "fixture" });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.category, "execution-error");
  assert.equal(outcome.diagnostic.code, "AUDIT_RETAINED_EVIDENCE");
  assert.match(outcome.summary, /^❌ S1/);
  assert.equal(fs.readFileSync(child.calls, "utf8"), "call\n", "cache failure never respawns");
});

test("auditOutcome: over-limit material is a machine limit diagnostic, not product FAIL", async (t) => {
  const f = fixture(t);
  await begin(f.root, "S1");
  setEnv(t, "SPECFLOW_AUDIT_MAX_BYTES", "1024");
  f.write("code.txt", "x".repeat(4096));
  await impl(f.root, "S1");
  const child = fake(t);
  const invocationCount = jobIds(f.root).length;

  const outcome = await auditOutcome(f.root, "S1", { budgetId: "fixture" });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.category, "limit-exceeded");
  assert.equal(outcome.diagnostic.stage, "audit-diff");
  assert.equal(outcome.diagnostic.limitBytes, 1024);
  assert.equal(outcome.diagnostic.limitSource, "environment");
  assert.equal(outcome.diagnostic.actualBytes, undefined);
  assert.ok(outcome.diagnostic.lowerBoundBytes > 1024);
  assert.equal(outcome.diagnostic.totalBytesKnown, false);
  assert.equal(outcome.nextActions[0].tool, "spec_audit");
  assert.equal(outcome.nextActions[0].args.action, "prepare");
  assert.equal(outcome.nextActions[0].requiresHuman, true);
  assert.equal(fs.existsSync(child.calls), false);
  assert.equal(jobIds(f.root).length, invocationCount, "no review job was prepared");
});

test("buildAuditDiff: strict argument/env limits and machine overflow diagnostics", async (t) => {
  const f = await passingLifecycle(t);
  assert.match(fs.readFileSync(path.join(f.root, "code.txt"), "utf8"), /implemented/);
  const spec = findSpec(f.root, "S1");
  const overflow = await buildAuditDiff(f.root, spec.frontmatter.impl.base_sha, null, {
    maxBytes: 32,
    specId: "S1",
  }).catch((error) => error);
  assert.ok(overflow instanceof Error);
  assert.match(overflow.message, /exceeds 32 bytes/);
  assert.equal(overflow.diagnostic.category, "limit-exceeded");
  assert.equal(overflow.diagnostic.limitBytes, 32);
  assert.equal(overflow.diagnostic.limitSource, "argument");
  assert.equal(overflow.diagnostic.totalBytesKnown, false);
  assert.ok(overflow.diagnostic.lowerBoundBytes > 32);
  assert.equal(overflow.diagnostic.nextActions[0].tool, "spec_audit");

  setEnv(t, "SPECFLOW_AUDIT_MAX_BYTES", "4kb");
  const invalid = await buildAuditDiff(f.root, spec.frontmatter.impl.base_sha, null, {}).catch(
    (error) => error,
  );
  assert.equal(invalid.diagnostic.code, "REVIEW_LIMIT_INVALID");
  assert.equal(invalid.diagnostic.category, "review-config");
  assert.equal(invalid.diagnostic.stage, "resolve");
  assert.ok(invalid.diagnostic.nextActions.length > 0);
});

test("prepareAudit: packet over-limit exposes actual bytes, reconciling breakdown and lifecycle actions", async (t) => {
  const f = await passingLifecycle(t);
  const spec = findSpec(f.root, "S1");
  const diff = await buildAuditDiff(f.root, spec.frontmatter.impl.base_sha, null, {
    maxBytes: 16 * 1024 * 1024,
    excludePaths: [spec.path],
  });
  const maxBytes = Buffer.byteLength(diff) + 8;
  const beforeJobs = jobIds(f.root).length;
  const specBefore = fs.readFileSync(f.specPath);

  const error = await prepareAudit(f.root, "S1", { maxBytes }).catch((value) => value);
  assert.ok(error instanceof Error);
  assert.equal(error.diagnostic.code, "REVIEW_PACKET_LIMIT");
  assert.equal(error.diagnostic.category, "review-limit");
  assert.equal(error.diagnostic.stage, "seal");
  assert.ok(error.diagnostic.actualBytes > maxBytes);
  assert.equal(error.diagnostic.sizeKnown, true);
  const breakdown = error.diagnostic.breakdown;
  assert.ok(Array.isArray(breakdown) && breakdown.length > 0);
  assert.equal(
    breakdown.reduce((sum, item) => sum + item.bytes, 0),
    error.diagnostic.actualBytes,
    "breakdown bytes must reconcile with the complete packet size",
  );
  assert.equal(error.diagnostic.nextActions[0].tool, "spec_audit");
  assert.equal(error.diagnostic.nextActions[0].args.action, "prepare");
  assert.equal(error.diagnostic.nextActions[0].requiresHuman, true);
  assert.deepEqual(fs.readFileSync(f.specPath), specBefore);
  assert.equal(jobIds(f.root).length, beforeJobs, "no partial job is published");
});
