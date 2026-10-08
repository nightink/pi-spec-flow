// Disposable executor plumbing only: no real Pi/provider or delivery grant.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { begin, impl, audit, findSpec, writeFrontmatter } from "./core.mjs";
import { review, reviewStatus, authorizeReviewBudget } from "./review-engine.mjs";
import { loadJob, saveJob, readPrivate, reviewStore, digest } from "./review-storage.mjs";

function environment(t, changes = {}) {
  const values = { SPECFLOW_AUDIT_BIN: undefined, SPECFLOW_PI_CLI: undefined, SPECFLOW_AUDIT_TIMEOUT: undefined,
    SPECFLOW_AUDIT_MODEL: undefined, SPECFLOW_AUDIT_THINKING: undefined, ...changes };
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (items) => { for (const [key, value] of Object.entries(items)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  apply(values); t.after(() => apply(old));
}
function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-execution-")), root = path.join(sandbox, "trusted checkout");
  fs.mkdirSync(path.join(root, "docs/specs"), { recursive: true });
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "docs/specs/S1.md"), writeFrontmatter("# Contract\n\n- [ ] implementation\n", {
    id: "S1", status: "approved", review: { decision: "approved" }, evidence: { e2e: [], migrations: [], human: [] },
  }));
  fs.writeFileSync(path.join(root, ".spec-flow.json"), JSON.stringify({ version: 1, gates: { mode: "replace", commands: [
    { name: "offline", argv: ["node", "-e", "process.exit(0)"] },
  ] } }));
  fs.writeFileSync(path.join(root, "code.txt"), "baseline\n");
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "execution-fixture"); git("config", "user.email", "fixture@example.invalid");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  const base = commit(); fs.writeFileSync(path.join(root, "code.txt"), "implemented\n"); const head = commit();
  const bin = path.join(sandbox, "bin without pi"); fs.mkdirSync(bin);
  fs.symlinkSync("/usr/bin/git", path.join(bin, "git")); fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const budget = () => JSON.parse(readPrivate(path.join(reviewStore(root), "budgets/fixture.json")));
  const grant = (calls = 1) => authorizeReviewBudget(root, { id: "fixture", calls, note: "Synthetic disposable fake-executor grant only; no real provider authorization." });
  const prepare = () => review(root, { id: "S1", base, head });
  return { sandbox, root, bin, budget, grant, prepare };
}
function fakeCli(f, delay = 0) {
  const file = path.join(f.sandbox, "fake installed Pi CLI.js"), calls = path.join(f.sandbox, "calls"), captured = path.join(f.sandbox, "captured packet");
  fs.writeFileSync(file, `import fs from 'node:fs';const args=process.argv.slice(2);
if(args.includes('--version'))throw new Error('must not probe/execute launcher during preflight');
for(const flag of ['--no-tools','--no-extensions','--no-session','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve'])if(!args.includes(flag))process.exit(2);
fs.appendFileSync(${JSON.stringify(calls)},'call\\n');fs.copyFileSync(args.at(-1).slice(1),${JSON.stringify(captured)});
await new Promise(r=>setTimeout(r,${delay}));console.log(JSON.stringify({verdict:'pass',criteria:[{criterion:'mechanical exact bytes',status:'pass',evidence:'fake fixture only'}],scope_deviations:[]}));\n`, { mode: 0o600 });
  return { file, calls, captured };
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function shim(f, cli) {
  const file = path.join(f.sandbox, "trusted shim with spaces");
  fs.writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli.file)} "$@"\n`, { mode: 0o700 });
  return file;
}
const run = (f, job, options = {}) => review(f.root, { action: "run", jobId: job.jobId, budgetId: "fixture" }, options);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test("execution: prepared job refreshes stale unstarted settings from current timeout", async (t) => {
  const f = fixture(t), cli = fakeCli(f, 50), bin = shim(f, cli);
  environment(t, { SPECFLOW_AUDIT_BIN: bin, SPECFLOW_AUDIT_TIMEOUT: "1" }); f.grant();
  const prepared = await f.prepare(), { dir, job } = loadJob(f.root, prepared.jobId);
  job.execution = { bin, model: "", thinking: "off", timeout: 1 }; saveJob(dir, job);
  process.env.SPECFLOW_AUDIT_TIMEOUT = "3000";
  const complete = await run(f, prepared);
  assert.equal(complete.state, "completed"); assert.equal(complete.receipt.execution.timeout, 3000);
  assert.equal(complete.executionInfo.action, "started"); assert.equal(complete.executionInfo.timeoutApplied, true);
  assert.equal(complete.executionInfo.effectiveTimeoutMs, 3000); assert.equal(f.budget().used, 1);
});

test("execution: running/cache reuse exposes ignored timeout without changing provenance or spending", async (t) => {
  const f = fixture(t), cli = fakeCli(f, 700);
  environment(t, { SPECFLOW_AUDIT_BIN: shim(f, cli), SPECFLOW_AUDIT_TIMEOUT: "3000" }); f.grant();
  const prepared = await f.prepare(), notices = [], first = run(f, prepared, { onProgress: (text) => notices.push(text) });
  for (let i = 0; i < 200 && !fs.existsSync(cli.calls); i++) await sleep(10);
  assert.ok(fs.existsSync(cli.calls)); const original = reviewStatus(f.root, prepared.jobId).receipt.execution;
  process.env.SPECFLOW_AUDIT_TIMEOUT = "6000"; process.env.SPECFLOW_AUDIT_BIN = path.join(f.sandbox, "missing override");
  const repeated = await run(f, prepared, { onProgress: (text) => notices.push(text) }), complete = await first;
  assert.equal(repeated.executionInfo.action, "wait-existing"); assert.equal(repeated.executionInfo.timeoutIgnored, true);
  assert.equal(repeated.executionInfo.requestedTimeoutMs, 6000); assert.equal(repeated.executionInfo.effectiveTimeoutMs, 3000);
  assert.deepEqual(complete.receipt.execution, original);
  const cached = await run(f, prepared);
  assert.equal(cached.executionInfo.action, "reuse-result"); assert.match(cached.executionInfo.message, /ignored.*new job|new job.*ignored/i);
  assert.deepEqual(cached.receipt.execution, original); assert.equal(f.budget().used, 1);
  assert.equal(fs.readFileSync(cli.calls, "utf8"), "call\n"); assert.ok(notices.some((text) => /timeout.*3000/i.test(text)));
  process.env.SPECFLOW_AUDIT_TIMEOUT = "invalid";
  const invalidRequest = await run(f, prepared);
  assert.equal(invalidRequest.executionInfo.requestValid, false); assert.equal(invalidRequest.result.verdict, "pass");
});

test("execution: missing bin, permission errors and invalid timeout fail before charge/spawn", async (t) => {
  const f = fixture(t), cli = fakeCli(f);
  environment(t, { SPECFLOW_AUDIT_BIN: path.join(f.sandbox, "missing"), SPECFLOW_AUDIT_TIMEOUT: "3000" }); f.grant();
  const prepared = await f.prepare();
  for (const bin of [path.join(f.sandbox, "missing"), cli.file, f.sandbox]) {
    process.env.SPECFLOW_AUDIT_BIN = bin;
    await assert.rejects(run(f, prepared), /executable|SPECFLOW_AUDIT_BIN/);
    assert.equal(reviewStatus(f.root, prepared.jobId).state, "prepared"); assert.equal(f.budget().used, 0);
  }
  process.env.SPECFLOW_AUDIT_BIN = shim(f, cli);
  for (const timeout of ["0", "-1", "1.5", "1800001", "NaN"]) {
    process.env.SPECFLOW_AUDIT_TIMEOUT = timeout;
    await assert.rejects(run(f, prepared), /timeout|execution settings/i); assert.equal(f.budget().used, 0);
  }
  assert.equal(fs.existsSync(cli.calls), false);
});

test("execution: no PATH pi and invalid explicit CLI are resumable preflight failures", async (t) => {
  const f = fixture(t); environment(t, { PATH: f.bin }); f.grant(); const prepared = await f.prepare();
  await assert.rejects(run(f, prepared), /SPECFLOW_AUDIT_BIN.*SPECFLOW_PI_CLI|SPECFLOW_PI_CLI.*SPECFLOW_AUDIT_BIN/);
  for (const entry of ["relative.js", path.join(f.sandbox, "missing.js"), f.sandbox]) {
    process.env.SPECFLOW_PI_CLI = entry; await assert.rejects(run(f, prepared), /SPECFLOW_PI_CLI/);
  }
  assert.equal(reviewStatus(f.root, prepared.jobId).state, "prepared"); assert.equal(f.budget().used, 0);
  const cli = fakeCli(f); process.env.SPECFLOW_PI_CLI = cli.file;
  const complete = await run(f, prepared); assert.equal(complete.state, "completed"); assert.equal(f.budget().used, 1);
});

test("execution: explicit Node + trusted CLI needs no PATH pi/shim and preserves exact bytes", async (t) => {
  const f = fixture(t), cli = fakeCli(f);
  environment(t, { PATH: f.bin, SPECFLOW_PI_CLI: cli.file, SPECFLOW_AUDIT_TIMEOUT: "3000" }); f.grant();
  const prepared = await f.prepare(), complete = await run(f, prepared);
  assert.equal(complete.state, "completed"); assert.equal(complete.receipt.execution.bin, process.execPath);
  assert.deepEqual(complete.receipt.execution.prefixArgs, [cli.file]);
  assert.equal(complete.receipt.execution.launcher, "node-cli");
  assert.equal(digest(fs.readFileSync(cli.captured)), complete.receipt.packet_sha256);
  assert.equal(complete.receipt.child_input_sha256, complete.receipt.packet_sha256);
  delete process.env.SPECFLOW_PI_CLI; process.env.SPECFLOW_AUDIT_TIMEOUT = "6000";
  const again = await run(f, prepared);
  assert.equal(again.state, "completed"); assert.equal(again.executionInfo.timeoutIgnored, true);
  assert.equal(fs.readFileSync(cli.calls, "utf8"), "call\n"); assert.equal(f.budget().used, 1);
});

test("execution: explicit BIN shim wins over CLI and timeout failure/replay remains charged", async (t) => {
  const f = fixture(t), cli = fakeCli(f, 500);
  environment(t, { PATH: f.bin, SPECFLOW_PI_CLI: path.join(f.sandbox, "not-selected.js"), SPECFLOW_AUDIT_BIN: shim(f, cli), SPECFLOW_AUDIT_TIMEOUT: "200" }); f.grant();
  const prepared = await f.prepare(), failed = await run(f, prepared);
  assert.equal(failed.state, "failed"); assert.equal(failed.receipt.execution.launcher, "explicit-bin");
  assert.equal(failed.receipt.timed_out, true); assert.match(failed.receipt.error, /timed out.*200/);
  process.env.SPECFLOW_AUDIT_TIMEOUT = "3000";
  const replay = await run(f, prepared);
  assert.equal(replay.state, "failed"); assert.equal(replay.executionInfo.timeoutIgnored, true);
  assert.equal(replay.receipt.execution.timeout, 200); assert.equal(f.budget().used, 1);
  assert.ok(!fs.existsSync(cli.calls) || fs.readFileSync(cli.calls, "utf8") === "call\n");
});

test("execution: PATH pi and relative explicit BIN resolve to stable absolute executables", async (t) => {
  const f = fixture(t), cli = fakeCli(f), bin = shim(f, cli);
  fs.symlinkSync(bin, path.join(f.bin, "pi")); environment(t, { PATH: f.bin }); f.grant(2);
  const byPath = await run(f, await f.prepare());
  assert.equal(byPath.state, "completed"); assert.equal(byPath.receipt.execution.launcher, "path");
  assert.equal(byPath.receipt.execution.bin, path.join(f.bin, "pi"));
  fs.unlinkSync(path.join(f.bin, "pi")); process.env.SPECFLOW_AUDIT_BIN = path.relative(f.root, bin);
  const relative = await run(f, await f.prepare());
  assert.equal(relative.state, "completed");
  assert.equal(relative.receipt.execution.bin, path.resolve(fs.realpathSync(f.root), path.relative(f.root, bin)));
  assert.equal(relative.receipt.execution.launcher, "explicit-bin"); assert.equal(f.budget().used, 2);
});

test("execution: lifecycle audit shares Node CLI launcher and explains cached timeout without mutation", async (t) => {
  const f = fixture(t), cli = fakeCli(f);
  environment(t, { PATH: process.env.PATH }); f.grant(); await begin(f.root, "S1");
  fs.writeFileSync(path.join(f.root, "code.txt"), "lifecycle implementation\n"); await impl(f.root, "S1");
  process.env.PATH = f.bin;
  process.env.SPECFLOW_PI_CLI = cli.file; process.env.SPECFLOW_AUDIT_TIMEOUT = "3000";
  assert.match(await audit(f.root, "S1", { budgetId: "fixture" }), /PASS/);
  const spec = findSpec(f.root, "S1"), { job } = loadJob(f.root, spec.frontmatter.audit.review.job_id);
  assert.deepEqual(job.execution.prefixArgs, [cli.file]); assert.equal(job.execution.timeout, 3000);
  const before = fs.readFileSync(spec.path, "utf8"); process.env.SPECFLOW_AUDIT_TIMEOUT = "6000";
  const cached = await audit(f.root, "S1", { budgetId: "missing" });
  assert.match(cached, /缓存复用/); assert.match(cached, /timeout.*3000.*6000.*ignored|6000.*ignored.*3000/);
  assert.equal(fs.readFileSync(spec.path, "utf8"), before); assert.equal(f.budget().used, 1);
  assert.equal(fs.readFileSync(cli.calls, "utf8"), "call\n");
});
