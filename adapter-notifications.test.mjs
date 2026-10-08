// Daemon/partial-UI regressions: fake Pi registration, REAL core gates and files.
// No provider, production host, or project lifecycle outside disposable fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as feedback from "./adapter-core.mjs";
import { findSpec, writeFrontmatter } from "./core.mjs";
import { loadProjectProfile } from "./project-profile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const note = "Disposable fixture: verified the gate result and exact no-write behavior.";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8" }).trim();
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-partial-ui-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.copyFileSync(path.join(here, "index.ts"), path.join(root, "index.ts"));
  for (const name of ["core.mjs", "adapter-core.mjs"]) fs.symlinkSync(path.join(here, name), path.join(root, name));
  const agent = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "package.json"), '{"type":"module","exports":"./index.js"}\n');
  // This harness is deliberately NOT evidence of the real SDK's queue behavior.
  fs.writeFileSync(path.join(agent, "index.js"), 'export async function withFileMutationQueue(_key, fn) { return fn(); }\n');
  const typebox = path.join(root, "node_modules/typebox");
  fs.mkdirSync(typebox, { recursive: true });
  fs.writeFileSync(path.join(typebox, "package.json"), '{"type":"module","exports":"./index.js"}\n');
  fs.writeFileSync(path.join(typebox, "index.js"), `export const Type = {
    Object: value => value, Optional: value => value, Array: value => ({items:value}),
    Union: value => ({anyOf:value}), Any: () => ({}), Null: () => ({type:'null'}),
    Literal: value => ({const:value}), Boolean: () => ({type:'boolean'}),
    Integer: () => ({type:'integer'}), String: (value = {}) => ({type:'string', ...value})
  };\n`);
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, "docs/specs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "docs/specs/S1.md"), `---
id: S1
status: approved
review:
  decision: approved
evidence:
  human: [R1]
---

# Partial UI fixture
`);
  fs.writeFileSync(path.join(cwd, ".gitignore"), "gate-runs.log\n");
  fs.writeFileSync(path.join(cwd, ".spec-flow.json"), JSON.stringify({ version: 1, gates: {
    mode: "replace", commands: [{ name: "offline", argv: ["node", "./gate.mjs"] }],
  } }));
  fs.writeFileSync(path.join(cwd, "gate.mjs"), `import fs from 'node:fs';
fs.appendFileSync('gate-runs.log', 'ran\\n');
if (fs.existsSync('fail-gate')) { console.error('FIXTURE_GATE_FAILED'); process.exit(7); }
console.log('FIXTURE_GATE_PASSED');\n`);
  git(cwd, "init", "-q"); git(cwd, "add", ".");
  git(cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  const tools = new Map(), commands = new Map(), events = new Map();
  const extension = await import(pathToFileURL(path.join(root, "index.ts")).href);
  extension.default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { events.set(name, handler); },
  });
  const ctx = { cwd, hasUI: true, ui: {} };
  const call = (name, params, onUpdate, context = ctx, signal) => tools.get(name).execute(name, params, signal, onUpdate, context);
  const spec = () => findSpec(cwd, "S1").frontmatter;
  const runs = () => fs.existsSync(path.join(cwd, "gate-runs.log")) ? fs.readFileSync(path.join(cwd, "gate-runs.log"), "utf8").trim().split("\n").length : 0;
  await call("spec_begin", { id: "S1" });
  return { cwd, ctx, call, spec, runs, commands, events };
}

for (const [name, context] of [
  ["missing notify", { hasUI: true, ui: {} }],
  ["non-callable notify", { hasUI: true, ui: { notify: "unsupported" } }],
  ["absent ui", { hasUI: true }],
  ["throwing notify", { hasUI: true, ui: { notify() { throw new Error("transport unavailable"); } } }],
  ["headless", { hasUI: false, ui: { notify() { throw new Error("must not call headless UI"); } } }],
]) {
  test(`native impl: ${name} does not interrupt real gates or tool progress`, async (t) => {
    const f = await fixture(t), updates = [];
    const result = await f.call("spec_impl", { id: "S1" }, value => updates.push(value), { cwd: f.cwd, ...context });
    assert.match(result.content[0].text, /PASS/);
    assert.equal(f.spec().impl.pass, true);
    assert.equal(f.runs(), 1);
    assert.ok(updates.some(value => value.content[0].text.includes("门禁 offline")), "gate progress must reach tool updates, not only UI notify");
  });
}

test("native impl: missing notify cannot hide a real failed gate", async (t) => {
  const f = await fixture(t), updates = [];
  fs.writeFileSync(path.join(f.cwd, "fail-gate"), "fail\n");
  const result = await f.call("spec_impl", { id: "S1" }, value => updates.push(value));
  assert.match(result.content[0].text, /FAIL/);
  assert.equal(f.spec().impl.pass, false);
  assert.equal(f.spec().impl.gates.offline.pass, false);
  assert.match(f.spec().impl.gates.offline.tail, /FIXTURE_GATE_FAILED/);
  assert.equal(f.runs(), 1);
  assert.ok(updates.length > 0);
});

test("native impl: cache diagnostics reach tool progress when notify is unavailable", async (t) => {
  const f = await fixture(t), updates = [];
  const before = process.env.SPECFLOW_GATE_CACHE_TTL_MS;
  process.env.SPECFLOW_GATE_CACHE_TTL_MS = "60000";
  // Redirect the real cache to a disposable root with a deliberately unsafe
  // symlink. No global cache is read, written, or removed by this regression.
  const beforeTmp = process.env.TMPDIR;
  const tmp = path.join(f.cwd, "private-cache");
  fs.mkdirSync(tmp);
  fs.symlinkSync(tmp, path.join(tmp, `specflow-${process.getuid()}`));
  process.env.TMPDIR = tmp;
  t.after(() => {
    if (before === undefined) delete process.env.SPECFLOW_GATE_CACHE_TTL_MS; else process.env.SPECFLOW_GATE_CACHE_TTL_MS = before;
    if (beforeTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = beforeTmp;
  });
  await f.call("spec_impl", { id: "S1" }, value => updates.push(value));
  assert.equal(f.spec().impl.pass, true);
  assert.ok(f.spec().impl.diagnostics.some(text => text.includes("gate cache read ignored")));
  assert.ok(updates.some(value => value.content[0].text.includes("gate cache read ignored")));
  assert.equal(f.runs(), 1);
});

test("native impl: throwing tool update transports cannot replace gate evidence", async (t) => {
  const f = await fixture(t);
  await f.call("spec_impl", { id: "S1" }, () => { throw new Error("disconnected update sink"); });
  assert.equal(f.spec().impl.pass, true);
  fs.writeFileSync(path.join(f.cwd, "fail-gate"), "fail\n");
  await f.call("spec_impl", { id: "S1" }, () => { throw new Error("disconnected update sink"); });
  assert.equal(f.spec().impl.pass, false);
  assert.equal(f.runs(), 2);
});

test("commit interception: unavailable/throwing notify still executes gates and blocks a failure", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "fail-gate"), "fail\n");
  for (const ui of [{}, { notify: "unsupported" }, undefined, { notify() { throw new Error("offline UI"); } }]) {
    const decision = await f.events.get("tool_call")({ toolName: "bash", input: { command: 'git commit -m "fixture"' } }, { cwd: f.cwd, hasUI: true, ui });
    assert.equal(decision?.block, true, "notification failure must not cause the interceptor's fail-open exception fallback");
    assert.match(decision.reason, /FIXTURE_GATE_FAILED/);
  }
  assert.equal(f.runs(), 4);
  const skipped = await f.events.get("tool_call")({ toolName: "bash", input: { command: "echo fixture" } }, f.ctx);
  assert.equal(skipped, undefined);
  assert.equal(f.runs(), 4);
  const bypassed = await f.events.get("tool_call")({ toolName: "bash", input: { command: 'SPECFLOW_BYPASS=1 git commit -m "fixture"' } }, f.ctx);
  assert.equal(bypassed, undefined);
  assert.equal(f.runs(), 5);
  const ledger = fs.readFileSync(path.join(f.cwd, ".spec-flow-ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(ledger.some(entry => entry.type === "bypass" && entry.gates.offline.pass === false));
});

test("native audit: missing notify reaches core validation, not a UI TypeError or paid spawn", async (t) => {
  const f = await fixture(t);
  // impl is not yet passing. No review budget is created or looked up.
  await assert.rejects(f.call("spec_audit", { id: "S1" }), /impl is not explicitly passing/);
});

test("native commands/startup: all notifications tolerate partial and throwing UI", async (t) => {
  const f = await fixture(t);
  for (const ui of [undefined, {}, { notify: 1 }, { notify() { throw new Error("offline UI"); } }]) {
    const ctx = { cwd: f.cwd, hasUI: true, ui };
    for (const arg of ["board", "S1", "missing", "worktrees", 'new {"title":"Preview","dryRun":true}', "new invalid-json"]) {
      await f.commands.get("spec").handler(arg, ctx);
    }
    await f.events.get("session_start")({}, ctx);
  }
});

test("native attestation: no callable confirmation stays fail-closed; missing notify alone does not deny a human", async (t) => {
  const f = await fixture(t);
  await f.call("spec_impl", { id: "S1" }, () => {});
  const specPath = path.join(f.cwd, "docs/specs/S1.md"), ledgerPath = path.join(f.cwd, ".spec-flow-ledger.jsonl");
  const parsed = findSpec(f.cwd, "S1"), fm = parsed.frontmatter;
  // Mechanical precondition ONLY in this disposable fixture. This is not a
  // model verdict, paid grant, real mother-Spec audit, or human attestation.
  fm.audit = { verdict: "pass", base_sha: fm.impl.base_sha, impl_hash: fm.impl.snapshot_hash,
    contract_hash: fm.impl.contract_hash,
    criteria: [{ criterion: "Synthetic fixture only", status: "pass", evidence: "No model; adapter confirmation regression" }], scope_deviations: [] };
  fs.writeFileSync(specPath, writeFrontmatter(parsed.content, fm));
  const before = fs.readFileSync(specPath), beforeLedger = fs.readFileSync(ledgerPath);
  for (const context of [{ hasUI: false, ui: { confirm: async () => true } }, { hasUI: true }, { hasUI: true, ui: {} }, { hasUI: true, ui: { confirm: "unsupported" } }]) {
    await assert.rejects(f.call("spec_attest", { id: "S1", item: "R1", note }, undefined, { cwd: f.cwd, ...context }), /需要交互式 UI 用户确认/);
    assert.deepEqual(fs.readFileSync(specPath), before);
    assert.deepEqual(fs.readFileSync(ledgerPath), beforeLedger);
  }
  await f.call("spec_attest", { id: "S1", item: "R1", note }, undefined, { cwd: f.cwd, hasUI: true, ui: { confirm: async () => false } });
  assert.deepEqual(fs.readFileSync(specPath), before);
  await assert.rejects(f.call("spec_attest", { id: "S1", item: "R1", note }, undefined, { cwd: f.cwd, hasUI: true, ui: { confirm: async () => { throw new Error("human dialog failed"); } } }), /human dialog failed/);
  assert.deepEqual(fs.readFileSync(specPath), before);
  const ui = { async confirm(_title, body) { assert.equal(this, ui); assert.ok(body.includes(note)); return true; } };
  await f.call("spec_attest", { id: "S1", item: "R1", note }, undefined, { cwd: f.cwd, hasUI: true, ui });
  assert.equal(f.spec().attestations.R1.note, note);
  assert.equal(f.spec().attestations.R1.impl_hash, f.spec().impl.snapshot_hash);
});

test("safe feedback helpers: capability/receiver/caps and sync/async transport failures", async () => {
  assert.equal(typeof feedback.notifySafely, "function");
  assert.equal(typeof feedback.updateToolProgress, "function");
  let called = 0;
  const ui = { notify(text, type) { assert.equal(this, ui); assert.match(text, /已截断/); assert.equal(type, "warning"); called++; } };
  assert.equal(feedback.notifySafely({ hasUI: true, ui }, "x".repeat(feedback.TOOL_TEXT_LIMIT + 1), "warning"), true);
  assert.equal(called, 1);
  for (const ctx of [undefined, { hasUI: false, ui }, { hasUI: true }, { hasUI: true, ui: { notify: 1 } }, { hasUI: true, get ui() { throw new Error("stale presentation"); } }, { hasUI: true, ui: { get notify() { throw new Error("bad getter"); } } }, { hasUI: true, ui: { notify() { throw new Error("sync"); } } }]) {
    assert.equal(feedback.notifySafely(ctx, "fixture"), false);
  }
  feedback.notifySafely({ hasUI: true, ui: { notify: async () => { throw new Error("async notify"); } } }, "fixture");
  assert.equal(feedback.updateToolProgress(undefined, "fixture"), false);
  assert.equal(feedback.updateToolProgress("not callable", "fixture"), false);
  assert.equal(feedback.updateToolProgress(() => { throw new Error("sync update"); }, "fixture"), false);
  feedback.updateToolProgress(async () => { throw new Error("async update"); }, "fixture");
  const updates = [];
  assert.equal(feedback.updateToolProgress(value => updates.push(value), "x".repeat(feedback.TOOL_TEXT_LIMIT + 1)), true);
  assert.match(updates[0].content[0].text, /已截断/);
  await new Promise((resolve) => { setImmediate(resolve); }); // Unhandled rejections fail node:test.
});

test("adapter source: no direct notify invocation bypasses the capability guard", () => {
  const source = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  const directCalls = source.match(/\.notify\s*(?:\?\.)?\s*\(/g) || [];
  assert.equal(directCalls.length, 0, "direct calls bypass the presentation capability guard");
  assert.equal(loadProjectProfile(here).gates.npmScripts[0], "check");
});
