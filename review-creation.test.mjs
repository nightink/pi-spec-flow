import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { newSpec, findSpec, begin, impl, audit, done, checkCI, writeFrontmatter, buildAuditDiff, repositorySnapshotHash } from "./core.mjs";
import { review, authorizeReviewBudget, reviewStatus, normalizeReviewResult, recognizePiProject, prepareWorkingAudit, runPreparedReview } from "./review-engine.mjs";
import { loadJob, saveJob, digest } from "./review-storage.mjs";
import { readReservations } from "./workspace.mjs";
const SPEC = writeFrontmatter("# Product\n\n- [ ] a changed implementation\n", { id: "S1", status: "approved", review: { decision: "approved" }, evidence: { e2e: [], migrations: [], human: [] } });
function fixture(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-new-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({ "docs/specs/S1.md": SPEC, "package.json": JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" }, pi: { extensions: ["./index.ts"] } }), "index.ts": "throw new Error('never execute'); // registerTool\n", "code.txt": "baseline\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value);
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "mechanical-fixture"); git("config", "user.email", "fixture@example.invalid");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture", "--allow-empty"); return git("rev-parse", "HEAD"); };
  const base = commit();
  return { root, git, commit, base, write: (file, text) => fs.writeFileSync(path.join(root, file), text) };
}
function fake(t, result = { verdict: "pass", criteria: [{ criterion: "code", status: "pass", evidence: "code.txt diff" }], scope_deviations: [] }, delay = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-fake-review-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake.mjs"), calls = path.join(dir, "calls");
  fs.writeFileSync(file, `#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'call\\n');await new Promise(r=>setTimeout(r,${delay}));console.log(${JSON.stringify(JSON.stringify(result))});\n`, { mode: 0o755 });
  const old = process.env.SPECFLOW_AUDIT_BIN; process.env.SPECFLOW_AUDIT_BIN = file;
  t.after(() => { if (old === undefined) delete process.env.SPECFLOW_AUDIT_BIN; else process.env.SPECFLOW_AUDIT_BIN = old; });
  return { calls, file };
}
function validation(overrides = {}) { return { requiredFields: ["kind"], kindField: "kind", allowedKinds: ["spec"], numericFileId: false, checkDoneCheckboxes: false, forbidAddendumFilename: false, dependencyIntegrity: false, ...overrides }; }
function lifecycle(overrides = {}) { return { preReview: ["draft"], startable: ["approved"], active: "in-progress", done: "done", ignored: ["archived"], dependenciesField: "requires", updatedField: "updated", bodyStatusLine: false, legacyActive: "error", externalActiveIds: [], approval: { reviewersField: "reviewers", reviewedAtField: "reviewed_at", minimumReviewers: 1, placeholderReviewers: [] }, ...overrides }; }
function grant(root, calls = 2) { return authorizeReviewBudget(root, { id: "fixture", calls, note: "Synthetic disposable fake-auditor grant; not a real provider authorization." }); }
async function prepare(f, extra = {}) { return review(f.root, { action: "prepare", id: "S1", base: f.base, head: f.git("rev-parse", "HEAD"), ...extra }); }

test("new: deterministic parseable draft, TODO, YAML title, no evidence/approval; preview burns no ID", async (t) => {
  const f = fixture(t), title = "A: 'quoted' $& ${never-evaluate}";
  const preview = await newSpec(f.root, { title, prefix: "S", dryRun: true });
  assert.match(preview.content, /TODO/); assert.equal(readReservations(f.root).ids.length, 0);
  const made = await newSpec(f.root, { title, prefix: "S", slug: "fixed", acceptance: ["one observable case"] });
  assert.equal(made.id, "S2"); const spec = findSpec(f.root, made.id);
  assert.equal(spec.frontmatter.title, title); assert.equal(spec.frontmatter.review.decision, "pending");
  assert.equal(spec.frontmatter.status, "draft");
  for (const field of ["impl", "audit", "attestations", "workflow_version"]) assert.equal(spec.frontmatter[field], undefined);
  assert.match(spec.content, /- \[ \] one observable case/);
  assert.match(spec.frontmatter.template.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(begin(f.root, made.id), /status=|not startable/);
});

test("new: strict creation-only numeric profile makes a CI-clean unapproved draft", async (t) => {
  const f = fixture(t, { ".spec-flow.json": JSON.stringify({ version: 1, creation: { directory: "specs", defaults: { supersedes: [] } }, validation: validation({ requiredFields: ["id", "title", "kind", "author", "created", "supersedes"], numericFileId: true }) }) });
  fs.rmSync(path.join(f.root, "docs"), { recursive: true }); f.commit();
  const made = await newSpec(f.root, { title: "Numeric" });
  assert.equal(made.path, "specs/1.spec.md"); assert.equal(findSpec(f.root, "1").frontmatter.id, 1);
  assert.equal((await checkCI(f.root, { runProjectGates: false })).pass, true);
});

test("new: custom lifecycle mappings and kind defaults are respected", async (t) => {
  const f = fixture(t, { ".spec-flow.json": JSON.stringify({ version: 1, lifecycle: lifecycle(), creation: { defaults: { type: "feature", owner: "team" } }, validation: validation({ kindField: "type", allowedKinds: ["feature"], requiredFields: ["type", "owner"] }) }) });
  const made = await newSpec(f.root, { title: "Mapped", prefix: "S" });
  const spec = findSpec(f.root, made.id); assert.equal(spec.frontmatter.type, "feature"); assert.equal(spec.frontmatter.owner, "team");
  assert.deepEqual(spec.frontmatter.requires, []); assert.deepEqual(spec.frontmatter.reviewers, []);
  assert.equal(spec.frontmatter.reviewed_at, null); assert.doesNotMatch(spec.content, /^- 状态：/m);
});

test("new: explicit no-draft lifecycle, unfillable metadata and unknown keys fail before reservation", async (t) => {
  const f = fixture(t);
  for (const input of [{ title: "x", status: "approved" }, { title: "x", slug: "../escape" }, { title: "x\n## inject" }, { title: "x", goals: ["a\n## injected"] }, { title: "x", dependencies: ["missing"] }]) await assert.rejects(newSpec(f.root, input));
  assert.equal(readReservations(f.root).ids.length, 0);
  f.write(".spec-flow.json", JSON.stringify({ version: 1, lifecycle: lifecycle({ preReview: [] }) }));
  await assert.rejects(newSpec(f.root, { title: "x" }), /preReview/);
  f.write(".spec-flow.json", JSON.stringify({ version: 1, validation: validation({ requiredFields: ["product_owner"] }) }));
  await assert.rejects(newSpec(f.root, { title: "x" }), /product_owner/);
  assert.equal(readReservations(f.root).ids.length, 0);
});

test("new: unsafe profile defaults/template paths, expressions, symlinks and ambiguous dirs fail closed", async (t) => {
  const f = fixture(t);
  for (const creation of [{ defaults: { status: "done" } }, { defaults: { __proto__: null, author: {} } }, { template: "../outside.md" }, { directory: "other" }, { defaults: { unknown: "invented" } }]) {
    f.write(".spec-flow.json", JSON.stringify({ version: 1, creation })); await assert.rejects(newSpec(f.root, { title: "x" }));
  }
  f.write(".spec-flow.json", JSON.stringify({ version: 1, creation: { template: "body.md" } }));
  f.write("body.md", "# {{title}}\n{{eval(js)}}\n"); await assert.rejects(newSpec(f.root, { title: "x" }), /slot/);
  fs.rmSync(path.join(f.root, "body.md")); fs.symlinkSync(path.join(f.root, "docs/specs/S1.md"), path.join(f.root, "body.md"));
  await assert.rejects(newSpec(f.root, { title: "x" }), /non-symlink/);
  fs.rmSync(path.join(f.root, ".spec-flow.json")); fs.mkdirSync(path.join(f.root, "specs"));
  await assert.rejects(newSpec(f.root, { title: "x" }), /Ambiguous/);
  fs.rmSync(path.join(f.root, "specs"), { recursive: true }); fs.renameSync(path.join(f.root, "docs"), path.join(f.root, "hidden"));
  fs.symlinkSync(path.join(f.root, "hidden"), path.join(f.root, "docs"));
  await assert.rejects(newSpec(f.root, { title: "x" }), /Unsafe creation/);
  assert.equal(readReservations(f.root).ids.length, 0);
});

test("new: exclusive publication never overwrites and a failed reservation stays burned", async (t) => {
  const f = fixture(t), original = fs.linkSync;
  fs.linkSync = (source, target) => { fs.writeFileSync(target, "concurrent foreign content"); original(source, target); };
  try { await assert.rejects(newSpec(f.root, { title: "x", prefix: "S" }), /EEXIST/); }
  finally { fs.linkSync = original; }
  assert.equal(fs.readFileSync(path.join(f.root, "docs/specs/S2-spec.md"), "utf8"), "concurrent foreign content");
  assert.ok(readReservations(f.root).ids.includes("S2"));
  // Explicitly remove the foreign malformed file; allocator correctly refuses to adopt it.
  fs.rmSync(path.join(f.root, "docs/specs/S2-spec.md"));
  assert.equal((await newSpec(f.root, { title: "next", prefix: "S" })).id, "S3");
});

test("review: exact head contract, static nonexecuting Pi metadata, explicit dirty exclusions", async (t) => {
  const f = fixture(t); f.write("code.txt", "implementation\n"); const head = f.commit();
  f.write("docs/specs/S1.md", SPEC + "DIRTY CONTRACT MUST NOT BE SENT\n");
  await assert.rejects(prepare(f), /Dirty checkout/);
  const prepared = await prepare(f, { allowDirty: true });
  const packet = fs.readFileSync(prepared.packetPath, "utf8");
  assert.doesNotMatch(packet, /DIRTY CONTRACT/); assert.match(packet, /registerTool/);
  assert.match(packet, /runtime_verified.*false/); assert.equal(prepared.receipt.bindings.head, head);
  assert.equal(prepared.receipt.bindings.base, f.base); assert.equal(prepared.receipt.bindings.dirty_excluded, true);
  assert.ok(prepared.receipt.bindings.dirty_exclusions.length); assert.equal(prepared.modelInvoked, false);
  assert.equal(digest(packet), prepared.receipt.packet_sha256);
});

test("review: no model on empty diff; proposal isn't an empty-diff PASS", async (t) => {
  const f = fixture(t), prepared = await prepare(f);
  assert.equal(prepared.state, "skipped"); assert.equal(prepared.result, null);
  assert.equal((await review(f.root, { action: "run", jobId: prepared.jobId })).state, "skipped");
  const proposal = await review(f.root, { mode: "proposal", id: "S1" });
  assert.equal(proposal.state, "prepared"); assert.equal(proposal.receipt.bindings.coverage, "proposal-only");
});

test("review: malformed revisions, nonancestor and oversized packets fail before model", async (t) => {
  const f = fixture(t);
  await assert.rejects(prepare(f, { base: "--help" }), /revision/);
  await assert.rejects(prepare(f, { head: "HEAD^{tree}" }));
  f.write("code.txt", "different\n"); const head = f.commit();
  await assert.rejects(prepare(f, { base: head, head: f.base }), /ancestor/);
  f.write("code.txt", "x".repeat(600000)); f.commit();
  await assert.rejects(prepare(f), /oversize|exceeds limit/);
});

test("review: high-risk scanner and packet tampering reject before charge/spawn", async (t) => {
  const f = fixture(t); f.write("code.txt", "secret: " + "AKIA" + "A".repeat(16)); f.commit();
  await assert.rejects(prepare(f), /high-risk secret/);
  f.write("code.txt", "safe implementation\n"); const safe = f.commit();
  const prepared = await prepare(f, { base: safe }); // empty safe range is skipped, so use proposal for tamper preflight.
  const proposal = await review(f.root, { mode: "proposal", id: "S1" }); grant(f.root, 1);
  fs.appendFileSync(proposal.packetPath, "tamper");
  await assert.rejects(review(f.root, { action: "run", jobId: proposal.jobId, budgetId: "fixture" }), /changed/);
  assert.equal(reviewStatus(f.root, proposal.jobId).state, "prepared"); assert.equal(prepared.state, "skipped");
});

test("review: explicit immutable grant, single charge, exact child bytes, raw response and free cache", async (t) => {
  const f = fixture(t); f.write("code.txt", "implementation\n"); f.commit(); const auditor = fake(t); grant(f.root, 1);
  assert.throws(() => grant(f.root, 3), /already exists/);
  const prepared = await prepare(f);
  const complete = await review(f.root, { action: "run", jobId: prepared.jobId, budgetId: "fixture" });
  assert.equal(complete.state, "completed"); assert.equal(complete.result.verdict, "pass");
  assert.equal(complete.receipt.child_input_sha256, complete.receipt.packet_sha256); assert.equal(complete.receipt.budget.ordinal, 1);
  const again = await review(f.root, { action: "run", jobId: prepared.jobId, budgetId: "missing" }); assert.equal(again.result.verdict, "pass");
  assert.equal(fs.readFileSync(auditor.calls, "utf8"), "call\n");
  const { dir } = loadJob(f.root, prepared.jobId); assert.equal(complete.receipt.raw_sha256, digest(fs.readFileSync(path.join(dir, "stdout.txt"))));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700); assert.equal(fs.statSync(prepared.packetPath).mode & 0o777, 0o600);
  const another = await prepare(f); await assert.rejects(review(f.root, { action: "run", jobId: another.jobId, budgetId: "fixture" }), /exhausted/);
  assert.equal(findSpec(f.root, "S1").frontmatter.audit, undefined);
});

test("review: malformed model output and contradictory criteria remain nonpassing and retained", async (t) => {
  const f = fixture(t); fake(t, { verdict: "pass", criteria: [], scope_deviations: [] }); grant(f.root, 1);
  const prepared = await review(f.root, { mode: "proposal", id: "S1" });
  const completed = await review(f.root, { action: "run", jobId: prepared.jobId, budgetId: "fixture" });
  assert.equal(completed.result.verdict, "fail"); assert.equal(completed.receipt.raw_verdict, "pass");
  assert.ok(fs.existsSync(path.join(loadJob(f.root, prepared.jobId).dir, "stdout.txt")));
});

test("review: cancellation remains charged, nonpassing and never auto-respawns", async (t) => {
  const f = fixture(t); const auditor = fake(t, undefined, 5000); grant(f.root, 1);
  const prepared = await review(f.root, { mode: "proposal", id: "S1" });
  const controller = new AbortController();
  const running = review(f.root, { action: "run", jobId: prepared.jobId, budgetId: "fixture" }, { signal: controller.signal });
  while (!fs.existsSync(auditor.calls)) await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(); await assert.rejects(running, /abort/i);
  // Wait for worker to persist its terminal state/exit before deleting disposable metadata.
  for (let i = 0; i < 100; i++) { const job = reviewStatus(f.root, prepared.jobId).receipt; try { process.kill(job.worker_pid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 20)); }
  const repeat = await review(f.root, { action: "run", jobId: prepared.jobId, budgetId: "fixture" });
  assert.equal(repeat.state, "cancelled"); assert.equal(repeat.result, null); assert.equal(fs.readFileSync(auditor.calls, "utf8"), "call\n");
});

test("incremental: unchanged baseline observations don't block, and blockers need exact delta lines/closure", async (t) => {
  const f = fixture(t); f.write("code.txt", "baseline\nchanged\n"); const firstHead = f.commit(); fake(t); grant(f.root, 2);
  const prior = await prepare(f); await review(f.root, { action: "run", jobId: prior.jobId, budgetId: "fixture" });
  f.write("code.txt", "baseline\nfixed\n"); f.commit();
  const delta = await prepare(f, { mode: "incremental", base: firstHead, previousReview: prior.jobId });
  assert.equal(delta.receipt.bindings.coverage, "delta-only"); assert.equal(delta.receipt.bindings.implementation_base, f.base);
  const raw = { verdict: "pass", criteria: [{ criterion: "delta", status: "pass", evidence: "line 2" }], scope_deviations: [], findings: [{ id: "old", classification: "out-of-scope", blocking: false, file: "code.txt", line: 1, evidence: "unchanged baseline" }] };
  assert.equal(normalizeReviewResult(raw, delta.receipt).verdict, "pass");
  const blocked = { ...raw, verdict: "fail", findings: [{ id: "F1", classification: "regression", file: "code.txt", line: 1, evidence: "not a changed line" }] };
  assert.match(normalizeReviewResult(blocked, delta.receipt).criteria.at(-1).evidence, /changed-line/);
  assert.equal(normalizeReviewResult({ ...raw, previous_closure: [] }, { ...delta.receipt, prior_findings: ["F0"] }).verdict, "fail");
  assert.equal(normalizeReviewResult({ ...raw, previous_closure: [{ id: "F0", status: "fixed", evidence: "line 2 correction" }] }, { ...delta.receipt, prior_findings: ["F0"] }).verdict, "pass");
});

test("Pi recognition: globs/exclusions/missing/unsafe/symlink and invalid manifests never execute", async () => {
  const entries = [{ file: "extensions/a.ts", mode: "100644", type: "blob" }, { file: "extensions/b.ts", mode: "100644", type: "blob" }, { file: "link.ts", mode: "120000", type: "blob" }];
  const context = await recognizePiProject(entries, async () => "throw 1; registerCommand", JSON.stringify({ pi: { extensions: ["extensions/*.ts", "!extensions/b.ts", "missing.ts", "../outside", "link.ts"] } }));
  assert.equal(context.runtime_verified, false); assert.ok(context.entries.some((entry) => entry.state === "missing"));
  assert.ok(context.entries.some((entry) => entry.state === "symlink-not-followed")); assert.ok(!context.entries.some((entry) => entry.path === "extensions/b.ts"));
  assert.match(context.diagnostics.join(" "), /unsafe/);
  assert.match((await recognizePiProject([], async () => "", "invalid{")).diagnostics.join(" "), /unparseable/);
});

test("lifecycle: shared full audit, free attach/cache, ordinary report cannot close; source mutation rejected", async (t) => {
  const f = fixture(t); fake(t); grant(f.root, 2);
  await begin(f.root, "S1"); f.write("code.txt", "implementation\n"); await impl(f.root, "S1");
  assert.match(await audit(f.root, "S1", { budgetId: "fixture" }), /✅ PASS/);
  const record = findSpec(f.root, "S1").frontmatter.audit;
  assert.equal(record.review.mode, "working-tree-audit"); assert.equal(record.review.packet_sha256, record.review.child_input_sha256);
  assert.match(await audit(f.root, "S1", { budgetId: "missing" }), /缓存复用/);
  f.write("changed-after.txt", "changed\n"); await assert.rejects(done(f.root, "S1"), /实现快照|changed|实现已/); fs.rmSync(path.join(f.root, "changed-after.txt"));
  const proposal = await review(f.root, { mode: "proposal", id: "S1" });
  await review(f.root, { action: "run", jobId: proposal.jobId, budgetId: "fixture" });
  const attempted = await audit(f.root, "S1", { reviewJobId: proposal.jobId });
  // Existing matching full PASS remains free and authoritative, not imported proposal PASS.
  assert.match(attempted, /缓存复用/); assert.equal(findSpec(f.root, "S1").frontmatter.audit.review.job_id, record.review.job_id);
  assert.match(await done(f.root, "S1"), /已完成/);
});

test("new: safe custom body template is versioned; kind cannot be guessed", async (t) => {
  const f = fixture(t);
  const body = "# {{title}}\n## Goals\n{{goals}}\n## Bounds\n{{non_goals}}\n## Design\n{{design}}\n## Plan\n{{plan}}\n## Checks\n{{acceptance}}\n";
  f.write("body.md", body);
  f.write(".spec-flow.json", JSON.stringify({ version: 1, creation: { template: "body.md" } }));
  const made = await newSpec(f.root, { title: "Literal", prefix: "S" });
  assert.equal(made.template.sha256, digest(body)); assert.match(findSpec(f.root, made.id).content, /## Bounds/);
  f.write(".spec-flow.json", JSON.stringify({ version: 1, validation: validation({ allowedKinds: ["feature"] }) }));
  await assert.rejects(newSpec(f.root, { title: "No invented kind" }), /creation.defaults.kind/);
});

test("review: profile/package from head and fsmonitor never executes during preparation", async (t) => {
  const f = fixture(t);
  f.write(".spec-flow.json", JSON.stringify({ version: 1, gates: { mode: "replace", npmScripts: ["test"] } }));
  f.write("code.txt", "changed\n"); f.commit();
  f.write("package.json", "{}"); f.write(".spec-flow.json", "malformed dirty profile");
  const hook = path.join(f.root, ".git/fsmonitor-hook"), marker = path.join(f.root, ".git/should-not-run");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 }); f.git("config", "core.fsmonitor", hook);
  const prepared = await prepare(f, { allowDirty: true });
  assert.equal(prepared.state, "prepared"); assert.equal(fs.existsSync(marker), false);
});

test("review: cached packet/raw/result tampering cannot become another cached approval", async (t) => {
  const f = fixture(t); fake(t); grant(f.root, 1);
  const prepared = await review(f.root, { mode: "proposal", id: "S1" });
  await review(f.root, { action: "run", jobId: prepared.jobId, budgetId: "fixture" });
  const { dir, job } = loadJob(f.root, prepared.jobId); job.result.criteria[0].evidence = "parent rewrite"; saveJob(dir, job);
  assert.throws(() => reviewStatus(f.root, prepared.jobId), /changed/);
});

test("review: overflowing output is captured boundedly and never passes", async (t) => {
  const f = fixture(t), child = fake(t); grant(f.root, 1);
  fs.writeFileSync(child.file, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(34*1024*1024));\n", { mode: 0o755 });
  const prepared = await review(f.root, { mode: "proposal", id: "S1" });
  const failed = await review(f.root, { action: "run", jobId: prepared.jobId, budgetId: "fixture" });
  assert.equal(failed.state, "failed"); assert.equal(failed.result, null); assert.equal(failed.receipt.output_truncated, true);
  const output = path.join(loadJob(f.root, prepared.jobId).dir, "stdout.txt");
  assert.ok(fs.statSync(output).size <= 32 * 1024 * 1024); assert.ok(fs.statSync(output).size > 0);
});

test("lifecycle: a mid-review source edit rejects even a fake PASS; ordinary approval never attaches", async (t) => {
  const f = fixture(t), child = fake(t); grant(f.root, 2);
  await begin(f.root, "S1"); f.write("code.txt", "before\n"); await impl(f.root, "S1");
  fs.writeFileSync(child.file, `#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(f.root, "code.txt"))},'during\\n');console.log(JSON.stringify({verdict:'pass',criteria:[{criterion:'c',status:'pass',evidence:'fake'}],scope_deviations:[]}));\n`, { mode: 0o755 });
  await assert.rejects(audit(f.root, "S1", { budgetId: "fixture" }), /changed during audit/);
  assert.equal(findSpec(f.root, "S1").frontmatter.audit.verdict, "fail");
  await impl(f.root, "S1");
  fs.writeFileSync(child.file, "#!/usr/bin/env node\nconsole.log(JSON.stringify({verdict:'pass',criteria:[{criterion:'c',status:'pass',evidence:'fake'}],scope_deviations:[]}));\n", { mode: 0o755 });
  const ordinary = await review(f.root, { mode: "proposal", id: "S1" });
  await review(f.root, { action: "run", jobId: ordinary.jobId, budgetId: "fixture" });
  assert.match(await audit(f.root, "S1", { reviewJobId: ordinary.jobId }), /ordinary\/delta results cannot attach/);
  await assert.rejects(done(f.root, "S1"), /audit/);
});

test("lifecycle: retained tamper rejects cached audit and done without another model call", async (t) => {
  const f = fixture(t), child = fake(t); grant(f.root, 1);
  await begin(f.root, "S1"); f.write("code.txt", "changed\n"); await impl(f.root, "S1"); await audit(f.root, "S1", { budgetId: "fixture" });
  const { dir } = loadJob(f.root, findSpec(f.root, "S1").frontmatter.audit.review.job_id);
  fs.appendFileSync(path.join(dir, "stdout.txt"), "tampered");
  assert.match(await audit(f.root, "S1", { budgetId: "fixture" }), /changed|mismatch/);
  await assert.rejects(done(f.root, "S1"), /changed|mismatch/);
  assert.equal(fs.readFileSync(child.calls, "utf8").trim().split("\n").length, 1);
});

test("lifecycle: prepared full job checks exact diff/impl and attaches after same-content commit for free", async (t) => {
  const f = fixture(t), child = fake(t); grant(f.root, 1);
  await begin(f.root, "S1"); f.write("code.txt", "changed\n"); await impl(f.root, "S1");
  const spec = findSpec(f.root, "S1"), snapshot = await repositorySnapshotHash(f.root, { excludePaths: [spec.path] });
  const diff = await buildAuditDiff(f.root, spec.frontmatter.impl.base_sha, null, { excludePaths: [spec.path] });
  const head = f.git("rev-parse", "HEAD");
  const bindings = { base_sha: spec.frontmatter.impl.base_sha, head, snapshot_hash: snapshot.hash, scope_sha256: digest(JSON.stringify(null)) };
  const forged = await prepareWorkingAudit(f.root, { spec, content: spec.content, profile: spec.profile, bindings, impl: spec.frontmatter.impl, diff: "fabricated patch" });
  assert.match(await audit(f.root, "S1", { reviewJobId: forged.jobId }), /not a full current working-tree audit/);
  // Re-impl resets the nonpassing pointer; genuinely prepare the actual bytes.
  await impl(f.root, "S1"); const current = findSpec(f.root, "S1");
  const prepared = await prepareWorkingAudit(f.root, { spec: current, content: current.content, profile: current.profile, bindings, impl: current.frontmatter.impl, diff });
  await runPreparedReview(f.root, prepared.jobId, { budgetId: "fixture", lifecycle: true }); f.commit();
  assert.match(await audit(f.root, "S1", { reviewJobId: prepared.jobId }), /PASS/);
  assert.equal(findSpec(f.root, "S1").frontmatter.audit.sha, head);
  assert.equal(fs.readFileSync(child.calls, "utf8").trim().split("\n").length, 1);
});
