// Actual installed Pi SDK + prototype-method UI shape used by a daemon host.
// Private disposable repo/agentDir, in-memory synthetic tool issuer, no provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { findSpec, writeFrontmatter } from "../../core.mjs";

const sdkRoot = process.env.SPECFLOW_PI_SDK;
if (!sdkRoot) throw new Error("Set SPECFLOW_PI_SDK to an already-installed trusted Pi 1.x package; never auto-install");
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const req = createRequire(path.join(sdkRoot, "package.json"));
const { Type } = await import(pathToFileURL(req.resolve("typebox")).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-pi-daemon-ui-"));
const cwd = path.join(root, "project"), agentDir = path.join(root, "private-agent");
let session, commandPromise, outcome;
const events = [], updates = [];

// NOT example-app's live adapter. This reproduces its relevant prototype-method shape
// through the real Pi wrapping boundary without executing target project code.
class PrototypeUI {
  notifications = [];
  confirmations = [];
  notify(text, level) { this.notifications.push({ text, level }); }
  async confirm(title, message) { this.confirmations.push({ title, message }); return false; }
  async select() { return undefined; }
  async input() { return undefined; }
  async editor() { return undefined; }
  async custom() { return undefined; }
}
const ui = new PrototypeUI();
const names = ["spec_begin", "spec_impl", "spec_audit", "spec_attest", "bash", "fixture-daemon-ui"];
const factory = pi => {
  pi.registerTool({ name: "fixture-daemon-ui", label: "Offline daemon UI fixture", description: "Mechanical SDK regression only", parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      assert.equal(ctx.hasUI, true);
      assert.equal(typeof ctx.ui.notify, "undefined", "real SDK spreads prototype methods away; hasUI is not a notify capability");
      assert.equal(typeof ctx.ui.confirm, "function", "dialog wrapper survives even when notify is lost");
      console.log("PASS actual Pi SDK reproduces hasUI=true with notify missing from a prototype-method UI");
      const call = (name, args) => ctx.executeTool(name, args, { signal, onUpdate: value => updates.push(value) });
      const started = await call("spec_begin", { id: "S1" });
      assert.equal(started.isError, false, JSON.stringify(started));
      const passed = await call("spec_impl", { id: "S1" });
      assert.equal(passed.isError, false, JSON.stringify(passed));
      assert.equal(findSpec(cwd, "S1").frontmatter.impl.pass, true);
      assert.ok(updates.some(value => value.content?.some(block => block.text?.includes("门禁 offline"))));
      fs.writeFileSync(path.join(cwd, "fail-gate"), "fail\n");
      const failed = await call("spec_impl", { id: "S1" });
      assert.equal(failed.isError, false, JSON.stringify(failed)); // Existing core semantics return a FAIL summary.
      assert.equal(findSpec(cwd, "S1").frontmatter.impl.pass, false);
      assert.ok(failed.result.content.some(block => block.text?.includes("FAIL")));
      console.log("PASS actual native spec_impl emits progress and preserves passing/failed real gate evidence without notify");
      const audit = await call("spec_audit", { id: "S1" });
      assert.equal(audit.isError, true);
      assert.ok(audit.result.content.some(block => block.text?.includes("impl is not explicitly passing")), JSON.stringify(audit));
      const specPath = path.join(cwd, "docs/specs/S1.md"), before = fs.readFileSync(specPath);
      const denied = await call("spec_attest", { id: "S1", item: "R1", note: "Fixture human decline: no attestation or real project write is permitted." });
      assert.equal(denied.isError, false, JSON.stringify(denied));
      assert.equal(denied.result.details.confirmed, false);
      assert.equal(ui.confirmations.length, 1);
      assert.deepEqual(fs.readFileSync(specPath), before);
      const blocked = await call("bash", { command: 'git commit -m "must remain blocked"' });
      assert.equal(blocked.isError, true);
      assert.ok(blocked.result.content.some(block => block.text?.includes("FIXTURE_GATE_FAILED")), JSON.stringify(blocked));
      assert.equal(fs.readFileSync(path.join(cwd, "gate-runs.log"), "utf8").trim().split("\n").length, 3);
      assert.equal(git("rev-parse", "HEAD"), base);
      console.log("PASS actual Pi tool pipeline blocks a failed commit, preserves human decline, and surfaces core audit failure without a provider");
      return { content: [{ type: "text", text: "offline daemon UI acceptance" }], details: { passed, failed, audit, denied, blocked } };
    } });
  pi.registerCommand("fixture-daemon-ui", { description: "Trusted offline native acceptance; no model", handler: () => {
    commandPromise = (async () => {
      const wrapped = session.state.tools.find(tool => tool.name === "fixture-daemon-ui");
      assert.ok(wrapped);
      outcome = await wrapped.execute("daemon-ui-fixture", {}, new AbortController().signal);
    })();
    return commandPromise;
  } });
};
function git(...args) { return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8" }).trim(); }
let base;
try {
  fs.mkdirSync(path.join(cwd, "docs/specs"), { recursive: true }); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(cwd, "docs/specs/S1.md"), writeFrontmatter("# Offline daemon UI contract\n", {
    id: "S1", status: "approved", review: { decision: "approved" }, evidence: { human: ["R1"] },
  }));
  fs.writeFileSync(path.join(cwd, ".gitignore"), "gate-runs.log\n");
  fs.writeFileSync(path.join(cwd, ".spec-flow.json"), JSON.stringify({ version: 1, gates: { mode: "replace", commands: [{ name: "offline", argv: ["node", "./gate.mjs"] }] } }));
  fs.writeFileSync(path.join(cwd, "gate.mjs"), `import fs from 'node:fs';
fs.appendFileSync('gate-runs.log', 'ran\\n');
if (fs.existsSync('fail-gate')) { console.error('FIXTURE_GATE_FAILED'); process.exit(7); }
console.log('FIXTURE_GATE_PASSED');\n`);
  git("init", "-q"); git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../../index.ts", import.meta.url))], extensionFactories: [factory] });
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd), modelRuntime: runtime, tools: names,
    model: { id: "offline", name: "offline fixture", provider: "fixture-offline", api: "openai-completions", baseUrl: "http://127.0.0.1:1",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 1 } }));
  session.subscribe(event => events.push(event));
  await session.bindExtensions({ uiContext: ui, mode: "json" });
  session.setActiveToolsByName(names);
  // Synthetic issuer only, private in-memory session. NOT independent review,
  // paid model usage, production session history, or human verification.
  session.sessionManager.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture-offline", model: "synthetic-plumbing",
    content: [{ type: "toolCall", id: "daemon-ui-fixture", name: "fixture-daemon-ui", arguments: {} }], stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  session.refreshContext();
  await session.prompt("/fixture-daemon-ui"); await commandPromise; assert.ok(outcome);
  assert.ok(events.some(event => event.type === "tool_execution_update" && event.toolName === "spec_impl" && event.parentToolCallId));
  assert.ok(!events.some(event => ["agent_start", "auto_retry_start", "auto_compaction_start"].includes(event.type)));
  assert.equal(session.messages.filter(message => message.role === "assistant").length, 1);
  assert.equal(session.messages.find(message => message.role === "assistant").model, "synthetic-plumbing");
  assert.equal(ui.notifications.length, 0); // Feedback comes from tool progress, not lost prototype notify.
} finally { session?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
