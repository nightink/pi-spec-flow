// Trusted disposable CLI/worktree/daemon-loss boundary. Fake children only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { writeFrontmatter } from "../../core.mjs";
const core = fileURLToPath(new URL("../../core.mjs", import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-review-cli-"));
const root = path.join(sandbox, "main checkout"), trees = [root], children = [];
fs.mkdirSync(root);
function write(file, value, options) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, options); }
function git(...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function cli(cwd, command, input, extra = {}) {
  const result = spawnSync(process.execPath, [core, command, "--json", JSON.stringify(input)], { cwd, env: { ...process.env, ...extra }, encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error(`CLI ${command} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
function launch(cwd, command, input, extra = {}) {
  const child = spawn(process.execPath, [core, command, "--json", JSON.stringify(input)], { cwd, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let output = "", error = "";
  child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => error += data);
  const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve({ code, output, error })); });
  return { child, closed };
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
try {
  write(path.join(root, "docs/specs/S1.md"), writeFrontmatter("# Contract\n\n- [ ] changed file is correct\n", { id: "S1", status: "approved", review: { decision: "approved" } }));
  write(path.join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
  write(path.join(root, "index.ts"), "throw new Error('recognition must never load this'); // registerTool\n");
  write(path.join(root, "code.txt"), "baseline\n");
  git("init", "-q"); git("config", "user.name", "CLI-fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-qm", "base");
  for (let i = 1; i < 3; i++) { const tree = path.join(sandbox, `linked ${i}`); git("worktree", "add", "--detach", tree, "HEAD"); trees.push(tree); }
  const preview = cli(root, "spec-new", { title: "Offline template", dryRun: true }); assert.equal(preview.status, "draft");
  const creators = Array.from({ length: 6 }, (_, i) => launch(trees[i % 3], "spec-new", { title: `Competing ${i}`, prefix: "S", acceptance: ["observable acceptance"] }));
  const created = await Promise.all(creators.map((call) => call.closed));
  for (const item of created) assert.equal(item.code, 0, item.error);
  const ids = created.map((item) => JSON.parse(item.output).id); assert.equal(new Set(ids).size, 6);
  assert.deepEqual(ids.map((id) => Number(id.slice(1))).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
  console.log("PASS six real processes create exclusive drafts across linked worktrees (space paths)");
  git("add", "."); git("commit", "-qm", "drafts"); const base = git("rev-parse", "HEAD");
  write(path.join(root, "code.txt"), "implemented\n"); git("add", "."); git("commit", "-qm", "candidate"); const head = git("rev-parse", "HEAD");
  const legacy = path.join(root, ".git/spec-flow/jobs/foreign-job/sentinel"); write(legacy, "legacy recovery untouched");
  const fake = path.join(sandbox, "fake.mjs"), count = path.join(sandbox, "calls"), captured = path.join(sandbox, "child-input");
  write(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(count)},'call\\n');fs.copyFileSync(args.at(-1).slice(1),${JSON.stringify(captured)});for(const flag of ['--no-tools','--no-extensions','--no-session','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve'])if(!args.includes(flag))process.exit(1);await new Promise(r=>setTimeout(r,500));console.log(JSON.stringify({verdict:'pass',criteria:[{criterion:'exact CLI diff',status:'pass',evidence:'code.txt'}],scope_deviations:[]}));\n`, { mode: 0o755 });
  const env = { SPECFLOW_AUDIT_BIN: fake };
  cli(root, "review-budget", { id: "fixture-cycle", calls: 3, used: 1, note: "Synthetic fixture seeds one external proposal call; no real provider request." });
  const packet = cli(root, "review", { id: "S1", base, head }); assert.equal(packet.modelInvoked, false);
  const completed = cli(root, "review", { action: "run", jobId: packet.jobId, budgetId: "fixture-cycle" }, env);
  assert.equal(completed.result.verdict, "pass"); assert.equal(completed.receipt.budget.ordinal, 2);
  assert.equal(fs.readFileSync(captured, "utf8"), fs.readFileSync(completed.packetPath, "utf8"));
  assert.equal(cli(root, "review", { action: "run", jobId: packet.jobId }).result.verdict, "pass");
  assert.equal(fs.readFileSync(count, "utf8"), "call\n"); console.log("PASS exact scanned/child bytes, shared isolation flags, finite seeded grant and free idempotent cache");
  const second = cli(root, "review", { id: "S1", base, head });
  const waiter = launch(root, "review", { action: "run", jobId: second.jobId, budgetId: "fixture-cycle" }, env);
  for (let i = 0; i < 100 && fs.readFileSync(count, "utf8").split("\n").length < 3; i++) await sleep(30);
  assert.equal(fs.readFileSync(count, "utf8"), "call\ncall\n"); waiter.child.kill("SIGKILL"); await waiter.closed;
  let status;
  for (let i = 0; i < 50; i++) { status = cli(root, "review", { action: "status", jobId: second.jobId }); if (status.state === "completed") break; await sleep(50); }
  assert.equal(status.state, "completed"); assert.equal(status.result.verdict, "pass");
  assert.equal(cli(root, "review", { action: "run", jobId: second.jobId }).receipt.budget.ordinal, 3);
  const third = cli(root, "review", { id: "S1", base, head });
  assert.throws(() => cli(root, "review", { action: "run", jobId: third.jobId, budgetId: "fixture-cycle" }, env), /exhausted/);
  assert.equal(fs.readFileSync(count, "utf8"), "call\ncall\n"); assert.equal(fs.readFileSync(legacy, "utf8"), "legacy recovery untouched");
  console.log("PASS killed frontend does not kill durable review, reset grant or double-spend; legacy jobs unchanged");
} finally {
  for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
  fs.rmSync(sandbox, { recursive: true, force: true });
}
