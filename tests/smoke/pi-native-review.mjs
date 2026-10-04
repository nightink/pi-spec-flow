// Actual Pi 1.x loader and tool pipeline, with private state and no provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { writeFrontmatter } from "../../core.mjs";
const sdkRoot = process.env.SPECFLOW_PI_SDK;
if (!sdkRoot) throw new Error("Set SPECFLOW_PI_SDK to an already-installed trusted Pi 1.x package; never auto-install");
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const { Type } = await import(pathToFileURL(path.join(sdkRoot, "node_modules/typebox/build/index.mjs")).href).catch(async () => {
  // Resolve through the selected SDK's dependency tree (not the target project).
  const { createRequire } = await import("node:module"); const req = createRequire(path.join(sdkRoot, "package.json"));
  return import(pathToFileURL(req.resolve("typebox")).href);
});
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-pi-native-"));
const cwd = path.join(sandbox, "trusted project"), agentDir = path.join(sandbox, "private-agent");
fs.mkdirSync(path.join(cwd, "docs/specs"), { recursive: true }); fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(cwd, "docs/specs/S1.md"), writeFrontmatter("# Offline contract\n\n- [ ] real native tool boundary\n", { id: "S1", status: "approved", review: { decision: "approved" } }));
fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ pi: { extensions: ["./unsafe.ts"] } }));
fs.writeFileSync(path.join(cwd, "unsafe.ts"), "throw new Error('unknown target must not load');\n");
execFileSync("git", ["init", "-q"], { cwd }); execFileSync("git", ["add", "."], { cwd });
execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"], { cwd });
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
let currentSession, seen = [], outcome, commandPromise;
const factory = (pi) => {
  pi.registerTool({ name: "fixture_probe", label: "Offline fixture", description: "Trusted mechanical native acceptance", parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      const creation = await ctx.executeTool("spec_new", { title: "Native typed draft", dryRun: true }, { signal });
      const prepared = await ctx.executeTool("spec_review", { action: "prepare", id: "S1", base: sha, head: sha }, { signal });
      assert.equal(creation.isError, false, JSON.stringify(creation)); assert.equal(prepared.isError, false, JSON.stringify(prepared));
      assert.equal(creation.result.structuredContent.status, "draft"); assert.equal(creation.result.structuredContent.dryRun, true);
      assert.equal(prepared.result.structuredContent.state, "skipped"); assert.equal(prepared.result.structuredContent.modelInvoked, false);
      const replay = await ctx.executeTool("spec_review", { action: "run", jobId: prepared.result.structuredContent.jobId }, { signal });
      assert.equal(replay.isError, false, JSON.stringify(replay));
      assert.equal(replay.result.structuredContent.executionInfo.action, "reuse-result");
      assert.equal(replay.result.structuredContent.executionInfo.timeoutApplied, false);
      assert.equal(replay.result.structuredContent.modelInvoked, false);
      return { content: [{ type: "text", text: "offline native acceptance" }], details: { creation, prepared, replay } };
    } });
  pi.registerCommand("fixture-native", { description: "Invokes real wrapped tool; no model", handler: () => {
    commandPromise = (async () => {
      const wrapped = currentSession.state.tools.find((tool) => tool.name === "fixture_probe");
      assert.ok(wrapped); outcome = await wrapped.execute("trusted-fixture", {}, new AbortController().signal);
    })();
    return commandPromise;
  } });
};
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
  noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  additionalExtensionPaths: [fileURLToPath(new URL("../../index.ts", import.meta.url))], extensionFactories: [factory] });
try {
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  const result = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd), modelRuntime: runtime, tools: ["spec_new", "spec_review", "fixture_probe"],
    model: { id: "offline", name: "offline fixture", provider: "fixture-offline", api: "openai-completions", baseUrl: "http://127.0.0.1:1",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 1 } });
  currentSession = result.session; currentSession.subscribe((event) => seen.push(event));
  await currentSession.bindExtensions({});
  currentSession.setActiveToolsByName(["spec_new", "spec_review", "fixture_probe"]);
  for (const name of ["spec_new", "spec_review"]) {
    assert.ok(currentSession.getCallableToolNames().includes(name), JSON.stringify({ missing: name, tools: currentSession.getAllTools().map((tool) => tool.name), extensions: loader.getExtensions().extensions.map((extension) => extension.path) }));
    assert.ok(currentSession.getToolDefinition(name).outputSchema);
    assert.ok(currentSession.systemPrompt.includes(name));
  }
  assert.ok(currentSession.getToolDefinition("spec_review").outputSchema.properties.executionInfo);
  // The nested-call pipeline needs an issuing assistant. Seed one dummy, zero-usage
  // tool call in the PRIVATE in-memory manager; it is plumbing, not model evidence.
  currentSession.sessionManager.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture-offline", model: "synthetic-plumbing",
    content: [{ type: "toolCall", id: "trusted-fixture", name: "fixture_probe", arguments: {} }], stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  currentSession.refreshContext();
  await currentSession.prompt("/fixture-native"); await commandPromise; assert.ok(outcome);
  assert.ok(seen.some((event) => event.type === "tool_execution_start" && event.toolName === "spec_new" && event.parentToolCallId));
  await currentSession.prompt('/spec new {"title":"Command-created draft","prefix":"S"}');
  assert.ok(fs.existsSync(path.join(cwd, "docs/specs/S2-spec.md")));
  await currentSession.prompt(`/spec review ${JSON.stringify({ mode: "proposal", id: "S1" })}`);
  assert.ok(!seen.some((event) => ["agent_start", "auto_retry_start", "auto_compaction_start"].includes(event.type)));
  assert.equal(currentSession.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(currentSession.messages.find((message) => message.role === "assistant").model, "synthetic-plumbing");
  console.log("PASS trusted Pi 1.x discovers typed tools and calls them through ctx.executeTool + handled commands, no provider/production state");
} finally { currentSession?.dispose(); fs.rmSync(sandbox, { recursive: true, force: true }); }
