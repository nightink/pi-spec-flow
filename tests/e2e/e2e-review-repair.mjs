// Actual trusted CLI against a disposable caller/linked checkout; one fake child, no real provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFrontmatter, findSpec, buildAuditDiff } from "../../core.mjs";
import { prepareWorkingAudit } from "../../review-engine.mjs";
import { loadJob, saveJob, reviewStore, digest } from "../../review-storage.mjs";
const core = fileURLToPath(new URL("../../core.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-repair-cli-")), root = path.join(tmp, "main checkout"), linked = path.join(tmp, "linked checkout");
fs.mkdirSync(path.join(root, "docs/specs"), { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function cli(cwd, input, extra = {}) {
  const out = spawnSync(process.execPath, [core, "review", "--json", JSON.stringify(input)], { cwd, encoding: "utf8", timeout: 30000, env: { ...process.env, ...extra } });
  assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout);
}
try {
  fs.writeFileSync(path.join(root, "docs/specs/S1.md"), writeFrontmatter("# Product\n", { id: "S1", status: "approved", review: { decision: "approved" } }));
  fs.writeFileSync(path.join(root, "code.txt"), "baseline\n");
  git("init", "-q"); git("config", "user.name", "mechanical-cli-repair"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); fs.writeFileSync(path.join(root, "code.txt"), "changed\n"); git("add", "."); git("commit", "-qm", "candidate");
  const head = git("rev-parse", "HEAD"); git("worktree", "add", "--detach", linked, "HEAD");
  const fake = path.join(tmp, "fake.mjs"), calls = path.join(tmp, "calls");
  fs.writeFileSync(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'call\\n');console.log(JSON.stringify({verdict:'pass',criteria:[{criterion:'product',status:'pass',evidence:'supplied code.txt diff'}],scope_deviations:[{file:'outside.txt',note:'preserve this observation'}]}));\n`, { mode: 0o755 });
  const grant = spawnSync(process.execPath, [core, "review-budget", "--json", JSON.stringify({ id: "fixture", calls: 1, note: "Synthetic CLI fake-auditor one-call grant; not real authorization." })], { cwd: root, encoding: "utf8" }); assert.equal(grant.status, 0, grant.stderr);
  const prepared = cli(root, { id: "S1", base, head }), { dir, job } = loadJob(root, prepared.jobId);
  delete job.result_protocol_version; delete job.prompt_version; saveJob(dir, job); // Mechanical legacy fixture.
  const original = cli(root, { action: "run", jobId: prepared.jobId, budgetId: "fixture" }, { SPECFLOW_AUDIT_BIN: fake });
  assert.equal(original.result.verdict, "fail"); assert.equal(original.outputInfo.category, "protocol-error"); assert.equal(original.outputInfo.repairable, true);
  const frozen = Object.fromEntries([path.join(reviewStore(root), "budgets/fixture.json"), path.join(root, "docs/specs/S1.md"), ...["job.json", "packet.md", "stdout.txt"].map(name => path.join(dir, name))].map(file => [file, fs.readFileSync(file)]));
  // Invalid execution environment is irrelevant: repair MUST NOT launch/probe/charge.
  const noLaunch = { SPECFLOW_AUDIT_BIN: "/no-review-process-allowed", SPECFLOW_PI_CLI: "/no-cli-allowed", SPECFLOW_AUDIT_TIMEOUT: "bad", SPECFLOW_REVIEW_BUDGET_ID: "exhausted-or-missing" };
  const fixed = cli(linked, { action: "repair", jobId: original.jobId }, noLaunch);
  assert.equal(fixed.result.verdict, "pass"); assert.equal(fixed.modelInvoked, false);
  assert.equal(fixed.receipt.recovery.source_job_id, original.jobId);
  assert.deepEqual(fixed.receipt.bindings, original.receipt.bindings);
  assert.equal(cli(root, { action: "repair", jobId: original.jobId }, noLaunch).jobId, fixed.jobId);
  assert.equal(cli(root, { action: "status", jobId: fixed.jobId }).result.verdict, "pass");
  assert.equal(cli(root, { action: "run", jobId: fixed.jobId }, noLaunch).result.verdict, "pass");
  for (const [file, bytes] of Object.entries(frozen)) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\n");
  console.log("PASS actual CLI + linked checkout repairs exhausted legacy format error with no launcher/probe/charge, preserving original bytes and all bindings; idempotent replay");
  const rejected = spawnSync(process.execPath, [core, "review", "--json", JSON.stringify({ action: "repair", jobId: original.jobId, budgetId: "fixture" })], { cwd: root, encoding: "utf8" });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /fields/);
  fs.appendFileSync(path.join(dir, "stdout.txt"), "tamper");
  const changed = spawnSync(process.execPath, [core, "review", "--json", JSON.stringify({ action: "status", jobId: fixed.jobId })], { cwd: root, encoding: "utf8" });
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /changed|mismatch/i);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\n");
  console.log("PASS actual CLI rejects repair budget/semantic parameters and changed source evidence without any additional fake-review invocation");
  const full = path.join(tmp, "full-bound checkout"); fs.mkdirSync(path.join(full, "docs/specs"), { recursive: true });
  fs.writeFileSync(path.join(full, "docs/specs/S1.md"), writeFrontmatter("# Product\n", { id: "S1", status: "approved", review: { decision: "approved" }, evidence: { e2e: [], migrations: [], human: [] } }));
  fs.writeFileSync(path.join(full, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }));
  fs.writeFileSync(path.join(full, "code.txt"), "baseline\n");
  for (const args of [["init", "-q"], ["config", "user.name", "mechanical-cli"], ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "-qm", "base"]]) execFileSync("git", args, { cwd: full, stdio: "ignore" });
  const command = (args, extra = {}) => spawnSync(process.execPath, [core, ...args], { cwd: full, encoding: "utf8", timeout: 30000, env: { ...process.env, ...extra } });
  assert.equal(command(["begin", "S1"]).status, 0); fs.writeFileSync(path.join(full, "code.txt"), "implemented\n"); assert.equal(command(["impl", "S1"]).status, 0);
  const spec = findSpec(full, "S1"), fm = spec.frontmatter, diff = await buildAuditDiff(full, fm.impl.base_sha, null, { excludePaths: [spec.path] });
  const preparedFull = await prepareWorkingAudit(full, { spec, content: spec.content, profile: spec.profile, diff, impl: fm.impl,
    bindings: { base_sha: fm.impl.base_sha, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: full, encoding: "utf8" }).trim(), snapshot_hash: fm.impl.snapshot_hash,
      scope_sha256: digest(JSON.stringify(null)), diff_sha256: digest(diff), impl_sha256: digest(JSON.stringify(fm.impl)) } });
  const legacyFull = loadJob(full, preparedFull.jobId); delete legacyFull.job.result_protocol_version; delete legacyFull.job.prompt_version; saveJob(legacyFull.dir, legacyFull.job);
  assert.equal(command(["review-budget", "--json", JSON.stringify({ id: "full-fixture", calls: 1, note: "Disposable full lifecycle fake grant, not a real review authorization." })]).status, 0);
  const originalFull = command(["audit", "S1", "--review-job", preparedFull.jobId], { SPECFLOW_AUDIT_BIN: fake, SPECFLOW_REVIEW_BUDGET_ID: "full-fixture" });
  assert.equal(originalFull.status, 0, originalFull.stderr); assert.match(originalFull.stdout, /工具\/协议错误/);
  const fixedFull = cli(full, { action: "repair", jobId: preparedFull.jobId }, noLaunch);
  const attached = command(["audit", "S1", "--review-job", fixedFull.jobId], noLaunch);
  assert.equal(attached.status, 0, attached.stderr); assert.match(attached.stdout, /PASS/);
  const beforeInvalid = fs.readFileSync(spec.path), invalid = command(["audit", "S1", "--review-job", "short-id"]);
  assert.notEqual(invalid.status, 0); assert.deepEqual(fs.readFileSync(spec.path), beforeInvalid);
  fs.writeFileSync(path.join(full, "code.txt"), "different implementation\n"); assert.equal(command(["impl", "S1"]).status, 0);
  assert.match(command(["audit", "S1", "--review-job", fixedFull.jobId], noLaunch).stdout, /binding mismatch/);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\ncall\n");
  console.log("PASS actual audit --review-job attaches only a bound free repaired full audit; stale binding/invalid CLI parameters neither inherit PASS nor spawn again");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
