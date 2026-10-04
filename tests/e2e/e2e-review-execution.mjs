// Real CLI/worker boundary; a fake installed Pi entry only, never a provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFrontmatter, findSpec } from "../../core.mjs";
import { loadJob, digest } from "../../review-storage.mjs";
const core = fileURLToPath(new URL("../../core.mjs", import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-execution-cli-"));
const root = path.join(sandbox, "trusted checkout"), bin = path.join(sandbox, "PATH without pi");
const cliFile = path.join(sandbox, "trusted fake Pi CLI.js"), calls = path.join(sandbox, "calls"), captured = path.join(sandbox, "captured");
const env = { ...process.env, PATH: bin, SPECFLOW_AUDIT_BIN: "", SPECFLOW_PI_CLI: "", SPECFLOW_AUDIT_TIMEOUT: "3000",
  SPECFLOW_AUDIT_MODEL: "", SPECFLOW_AUDIT_THINKING: "off", SPECFLOW_REVIEW_BUDGET_ID: "" };
function cli(command, args, extra = {}) {
  return spawnSync(process.execPath, [core, command, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
}
function json(command, input, extra = {}) {
  const result = cli(command, ["--json", JSON.stringify(input)], extra);
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function lifecycle(command, extra = {}) {
  const result = cli(command, ["S1"], extra); assert.equal(result.status, 0, result.stderr); return result.stdout;
}
function budget() { return JSON.parse(fs.readFileSync(path.join(root, ".git/spec-flow/review-v1/budgets/mechanical.json"), "utf8")); }
function git(...args) { return execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function commit() { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); }
try {
  fs.mkdirSync(path.join(root, "docs/specs"), { recursive: true }); fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node")); fs.symlinkSync("/usr/bin/git", path.join(bin, "git"));
  fs.writeFileSync(path.join(root, "docs/specs/S1.md"), writeFrontmatter("# Contract\n\n- [ ] implementation\n", {
    id: "S1", status: "approved", review: { decision: "approved" }, evidence: { e2e: [], migrations: [], human: [] },
  }));
  fs.writeFileSync(path.join(root, ".spec-flow.json"), JSON.stringify({ version: 1, gates: { mode: "replace", commands: [
    { name: "offline", argv: ["node", "-e", "process.exit(0)"] },
  ] } }));
  fs.writeFileSync(path.join(root, "code.txt"), "baseline\n");
  git("init", "-q"); git("config", "user.name", "CLI-fixture"); git("config", "user.email", "fixture@example.invalid"); const base = commit();
  fs.writeFileSync(path.join(root, "code.txt"), "committed implementation\n"); const head = commit();
  fs.writeFileSync(cliFile, `import fs from 'node:fs';const args=process.argv.slice(2);
if(args.includes('--version'))throw new Error('no executable probe permitted');
for(const flag of ['--no-tools','--no-extensions','--no-session','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve'])if(!args.includes(flag))process.exit(2);
fs.appendFileSync(${JSON.stringify(calls)},'call\\n');fs.copyFileSync(args.at(-1).slice(1),${JSON.stringify(captured)});
console.log(JSON.stringify({verdict:'pass',criteria:[{criterion:'mechanical CLI',status:'pass',evidence:'disposable fake only'}],scope_deviations:[]}));\n`, { mode: 0o600 });
  json("review-budget", { id: "mechanical", calls: 3, note: "Synthetic disposable CLI executor tests only; never a real reviewer authorization." });
  const prepared = json("review", { id: "S1", base, head });
  const unavailable = cli("review", ["--json", JSON.stringify({ action: "run", jobId: prepared.jobId, budgetId: "mechanical" })]);
  assert.notEqual(unavailable.status, 0); assert.match(unavailable.stderr, /SPECFLOW_AUDIT_BIN.*SPECFLOW_PI_CLI/);
  assert.equal(json("review", { action: "status", jobId: prepared.jobId }).state, "prepared"); assert.equal(budget().used, 0);
  assert.equal(fs.existsSync(calls), false);
  const complete = json("review", { action: "run", jobId: prepared.jobId, budgetId: "mechanical" }, { SPECFLOW_PI_CLI: cliFile, SPECFLOW_AUDIT_TIMEOUT: "6000" });
  assert.equal(complete.state, "completed"); assert.equal(complete.receipt.execution.timeout, 6000);
  assert.deepEqual(complete.receipt.execution.prefixArgs, [cliFile]); assert.equal(complete.executionInfo.timeoutApplied, true);
  assert.equal(digest(fs.readFileSync(captured)), complete.receipt.packet_sha256);
  const before = fs.readFileSync(path.join(loadJob(root, prepared.jobId).dir, "job.json"));
  const replay = json("review", { action: "run", jobId: prepared.jobId }, { SPECFLOW_AUDIT_TIMEOUT: "9000" });
  assert.equal(replay.executionInfo.timeoutIgnored, true); assert.equal(replay.executionInfo.effectiveTimeoutMs, 6000);
  assert.deepEqual(fs.readFileSync(path.join(loadJob(root, prepared.jobId).dir, "job.json")), before); assert.equal(budget().used, 1);
  console.log("PASS real review CLI without PATH pi: uncharged preflight, current first-run timeout, Node+trusted CLI, exact bytes and free immutable replay");

  lifecycle("begin"); fs.writeFileSync(path.join(root, "code.txt"), "lifecycle implementation\n"); lifecycle("impl");
  assert.match(lifecycle("audit", { SPECFLOW_REVIEW_BUDGET_ID: "mechanical" }), /FAIL/); assert.equal(budget().used, 1);
  const auditPrepared = findSpec(root, "S1").frontmatter.audit.review.job_id;
  assert.equal(loadJob(root, auditPrepared).job.state, "prepared");
  assert.match(lifecycle("audit", { SPECFLOW_PI_CLI: cliFile, SPECFLOW_AUDIT_TIMEOUT: "6000", SPECFLOW_REVIEW_BUDGET_ID: "mechanical" }), /PASS/);
  assert.equal(findSpec(root, "S1").frontmatter.audit.review.job_id, auditPrepared);
  assert.equal(loadJob(root, auditPrepared).job.execution.timeout, 6000); assert.equal(budget().used, 2);
  const specBefore = fs.readFileSync(findSpec(root, "S1").path);
  const cached = lifecycle("audit", { SPECFLOW_AUDIT_TIMEOUT: "9000" });
  assert.match(cached, /缓存复用/); assert.match(cached, /timeout=6000ms.*9000ms.*ignored/);
  assert.deepEqual(fs.readFileSync(findSpec(root, "S1").path), specBefore); assert.equal(budget().used, 2);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\ncall\n");
  console.log("PASS real audit CLI shares launcher, resumes uncharged prepared job with new timeout and explains cached overrides without metadata changes");

  const timeoutJob = json("review", { mode: "proposal", id: "S1" });
  const failed = json("review", { action: "run", jobId: timeoutJob.jobId, budgetId: "mechanical" }, { SPECFLOW_PI_CLI: cliFile, SPECFLOW_AUDIT_TIMEOUT: "1" });
  assert.equal(failed.state, "failed"); assert.equal(failed.receipt.timed_out, true); assert.equal(failed.result, null);
  const oldTimeout = json("review", { action: "run", jobId: timeoutJob.jobId }, { SPECFLOW_AUDIT_TIMEOUT: "9000" });
  assert.equal(oldTimeout.executionInfo.timeoutIgnored, true); assert.equal(oldTimeout.receipt.execution.timeout, 1); assert.equal(budget().used, 3);
  console.log("PASS timed-out CLI job retains original timeout, nonpassing result and charged budget; replay never respawns");
} finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
