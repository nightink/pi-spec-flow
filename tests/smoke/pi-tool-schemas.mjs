// Actual Pi loader + provider serializers; capture BEFORE network, never infer
// hosted acceptance from mechanical payload checks. No tool/task is executed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const sdkRoot = process.env.SPECFLOW_PI_SDK;
if (!sdkRoot) throw new Error("Set SPECFLOW_PI_SDK to an already-installed trusted Pi 1.x package; never auto-install");
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const req = createRequire(path.join(sdkRoot, "package.json"));
// pi-ai has an import-only export; CJS require.resolve cannot resolve its main.
// Locate the already-installed dependency via the selected trusted SDK's search
// paths, then import its real API serializers. No target project or install.
const aiPackage = req.resolve.paths("@earendil-works/pi-ai").map(dir => path.join(dir, "@earendil-works/pi-ai/package.json")).find(file => fs.existsSync(file));
if (!aiPackage) throw new Error("Selected trusted SDK has no installed pi-ai dependency");
const aiDist = path.join(path.dirname(aiPackage), "dist");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-pi-schemas-"));
let session;
try {
  const cwd = path.join(root, "project"), agentDir = path.join(root, "private-agent");
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../../index.ts", import.meta.url))] });
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  const model = { id: "offline", name: "Schema capture only", provider: "fixture-offline", api: "openai-completions", baseUrl: "http://127.0.0.1:1",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 16 };
  const names = ["spec_alloc", "spec_attest", "spec_audit", "spec_begin", "spec_board", "spec_done", "spec_impl", "spec_new", "spec_review"];
  // SDK tools is a construction-time allowlist, not merely the initial loadout.
  ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd), modelRuntime: runtime, model, tools: names }));
  await session.bindExtensions({});
  session.setActiveToolsByName(names);
  const tools = names.map(name => { const def = session.getToolDefinition(name); assert.ok(def, name); return { name, description: def.description, parameters: def.parameters }; });
  const invalid = [];
  for (const tool of tools) {
    if (tool.parameters.type !== "object" || ["anyOf", "oneOf", "allOf"].some(key => Object.hasOwn(tool.parameters, key))) invalid.push(`native:${tool.name}: root is not a plain explicit object`);
  }
  console.log(JSON.stringify({ native_tool_roots: Object.fromEntries(tools.map(tool => [tool.name, tool.parameters.type ?? null])) }));
  // Canonical transcript declaration, not a reconstructed fake converter.
  const context = { messages: [
    { role: "system", content: "Offline schema capture; no task or model execution.", toolsAdded: tools, timestamp: Date.now() },
    { role: "user", content: "Schema fixture only.", timestamp: Date.now() },
  ] };
  let requests = 0;
  const stop = "OFFLINE_SCHEMA_CAPTURE_BEFORE_REQUEST";
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
    const { stream } = await import(pathToFileURL(path.join(aiDist, "api", `${api}.js`)).href);
    let payload;
    const output = await stream({ ...model, api }, context, {
      // Explicit non-credential; never read real auth from the environment.
      apiKey: "dummy", env: {}, cacheRetention: "none", maxRetries: 0, timeoutMs: 1000,
      fetch: async () => { requests++; throw new Error("Network prohibited in schema acceptance"); },
      onPayload(value) { payload = JSON.parse(JSON.stringify(value)); throw new Error(stop); },
    }).result();
    assert.ok(payload, `${api}: real serializer never reached onPayload`);
    assert.equal(output.stopReason, "error");
    assert.ok(output.errorMessage?.includes(stop), `${api}: unexpected setup failure ${output.errorMessage}`);
    assert.equal(requests, 0);
    const wire = (payload.tools || []).filter(item => (item.name || item.function?.name)?.startsWith("spec_"));
    assert.deepEqual(wire.map(item => item.name || item.function.name).sort(), names);
    const failures = [];
    for (const item of wire) {
      const name = item.name || item.function.name;
      const schema = item.input_schema || item.parameters || item.function.parameters;
      if (schema.type !== "object") failures.push(`${name}: root type=${schema.type ?? null}`);
      if (["anyOf", "oneOf", "allOf"].some(key => Object.hasOwn(schema, key))) failures.push(`${name}: root composition`);
      const canonical = tools.find(tool => tool.name === name).parameters.properties || {};
      if (JSON.stringify(schema.properties || {}) !== JSON.stringify(canonical)) failures.push(`${name}: property declarations lost`);
      // The old Anthropic converter dropped root-union branches into {}.
      if (name === "spec_review" && !Object.hasOwn(schema.properties || {}, "action")) failures.push(`${name}: action declaration lost`);
    }
    console.log(JSON.stringify({ api, tools: wire.length, requests, failures }));
    invalid.push(...failures.map(value => `${api}:${value}`));
  }
  assert.deepEqual(invalid, [], "model-facing schemas must survive actual provider serialization; valid JSON Schema alone is insufficient");
  assert.equal(requests, 0);
  console.log("PASS all nine native tool object roots and exact property declarations through actual OpenAI Completions/Responses + Anthropic serializers, zero HTTP requests");
} finally { session?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
