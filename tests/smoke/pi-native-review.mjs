// Actual Pi 1.x loader and tool pipeline, with private state and no provider.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  engineIdentity,
  findSpec,
  repositorySnapshotHash,
  specContractHash,
  writeFrontmatter,
} from "../../packages/core/src/core.mjs";
import { loadProjectProfile } from "../../packages/core/src/project-profile.mjs";
import { normalizeReviewResult } from "../../packages/core/src/review-engine.mjs";
import { digest, loadJob, reviewStore, saveJob } from "../../packages/core/src/review-storage.mjs";
import { mechanicalCoverage, seedLegacyReviewFixture } from "../helpers/review-fixture.mjs";

const sdkRoot = process.env.SPECFLOW_PI_SDK;
if (!sdkRoot)
  throw new Error(
    "Set SPECFLOW_PI_SDK to an already-installed trusted Pi 1.x package; never auto-install",
  );
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } =
  await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const { Type } = await import(
  pathToFileURL(path.join(sdkRoot, "node_modules/typebox/build/index.mjs")).href
).catch(async () => {
  // Resolve through the selected SDK's dependency tree (not the target project).
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(sdkRoot, "package.json"));
  return import(pathToFileURL(req.resolve("typebox")).href);
});
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-pi-native-"));
const cwd = path.join(sandbox, "trusted project"),
  agentDir = path.join(sandbox, "private-agent");
fs.mkdirSync(path.join(cwd, "docs/specs"), { recursive: true });
fs.mkdirSync(agentDir);
fs.writeFileSync(
  path.join(cwd, "docs/specs/S1.md"),
  writeFrontmatter("# Offline contract\n\n- [ ] real native tool boundary\n", {
    id: "S1",
    status: "approved",
    review: { decision: "approved" },
  }),
);
fs.writeFileSync(
  path.join(cwd, "package.json"),
  JSON.stringify({ pi: { extensions: ["./unsafe.ts"] } }),
);
fs.writeFileSync(path.join(cwd, "unsafe.ts"), "throw new Error('unknown target must not load');\n");
execFileSync("git", ["init", "-q"], { cwd });
execFileSync("git", ["add", "."], { cwd });
execFileSync(
  "git",
  ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"],
  { cwd },
);
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const settings = SettingsManager.inMemory({
  retry: { enabled: false },
  compaction: { enabled: false },
});
let currentSession, outcome, commandPromise;
const seen = [];
const factory = (pi) => {
  pi.registerTool({
    name: "fixture_probe",
    label: "Offline fixture",
    description: "Trusted mechanical native acceptance",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      const creation = await ctx.executeTool(
        "spec_new",
        { title: "Native typed draft", dryRun: true },
        { signal },
      );
      const prepared = await ctx.executeTool(
        "spec_review",
        { action: "prepare", id: "S1", base: sha, head: sha },
        { signal },
      );
      assert.equal(creation.isError, false, JSON.stringify(creation));
      assert.equal(prepared.isError, false, JSON.stringify(prepared));
      assert.equal(creation.result.structuredContent.status, "draft");
      assert.equal(creation.result.structuredContent.dryRun, true);
      assert.equal(creation.result.structuredContent.template.version, 2);
      assert.equal(prepared.result.structuredContent.engine.version, engineIdentity().version);
      assert.equal(
        prepared.result.structuredContent.engine.source_sha256,
        engineIdentity().source_sha256,
      );
      assert.equal(prepared.result.structuredContent.receipt.result_protocol_version, 3);
      assert.equal(prepared.result.structuredContent.state, "skipped");
      assert.equal(prepared.result.structuredContent.modelInvoked, false);
      const replay = await ctx.executeTool(
        "spec_review",
        { action: "run", jobId: prepared.result.structuredContent.jobId },
        { signal },
      );
      assert.equal(replay.isError, false, JSON.stringify(replay));
      assert.equal(replay.result.structuredContent.executionInfo.action, "reuse-result");
      assert.equal(replay.result.structuredContent.executionInfo.timeoutApplied, false);
      assert.equal(replay.result.structuredContent.modelInvoked, false);
      const defaulted = await ctx.executeTool(
        "spec_review",
        { id: "S1", base: sha, head: sha },
        { signal },
      );
      const status = await ctx.executeTool(
        "spec_review",
        { action: "status", jobId: prepared.result.structuredContent.jobId },
        { signal },
      );
      const proposal = await ctx.executeTool(
        "spec_review",
        { mode: "proposal", id: "S1" },
        { signal },
      );
      for (const result of [defaulted, status, proposal]) {
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.equal(result.result.structuredContent.modelInvoked, false);
      }
      assert.equal(defaulted.result.structuredContent.state, "skipped");
      assert.equal(status.result.structuredContent.state, "skipped");
      assert.equal(proposal.result.structuredContent.state, "prepared");
      const jobId = proposal.result.structuredContent.jobId;
      const store = reviewStore(ctx.cwd),
        jobs = fs.readdirSync(path.join(store, "jobs")).sort();
      const beforeSpec = fs.readFileSync(path.join(cwd, "docs/specs/S1.md"));
      const beforeJob = fs.readFileSync(path.join(store, "jobs", jobId, "job.json"));
      const invalid = [
        { action: "run" },
        { action: "status" },
        { action: "run", jobId, base: sha, budgetId: "not-authorized" },
        { action: "status", jobId, budgetId: "not-authorized" },
        { mode: "proposal", id: "S1", budgetId: "not-authorized" },
        { action: "prepare", mode: "proposal", id: "S1", jobId },
        { action: "launch", jobId },
        { action: "run", jobId: "../outside" },
        { action: "status", jobId, surprise: true },
        { action: "prepare", mode: "working-tree-audit", id: "S1" },
      ];
      for (const args of invalid) {
        const result = await ctx.executeTool("spec_review", args, { signal });
        assert.equal(result.isError, true, JSON.stringify({ args, result }));
      }
      assert.deepEqual(fs.readdirSync(path.join(store, "jobs")).sort(), jobs);
      assert.deepEqual(fs.readFileSync(path.join(cwd, "docs/specs/S1.md")), beforeSpec);
      assert.deepEqual(fs.readFileSync(path.join(store, "jobs", jobId, "job.json")), beforeJob);
      assert.equal(fs.existsSync(path.join(store, "budgets")), false);
      // Synthetic completed legacy precondition in a PRIVATE fixture, not a
      // provider response. Exercise native repair + validation without any model.
      const seededRaw = {
        verdict: "pass",
        criteria: [
          { criterion: "mechanical protocol", status: "pass", evidence: "Synthetic fixture only" },
        ],
        scope_deviations: [{ file: "outside.txt", note: "Synthetic observation only" }],
      };
      const retained = loadJob(ctx.cwd, jobId),
        seededBytes = JSON.stringify(seededRaw);
      seedLegacyReviewFixture(retained.dir, retained.job);
      Object.assign(retained.job, {
        state: "completed",
        model_invoked: true,
        raw_verdict: "pass",
        raw_sha256: digest(seededBytes),
        child_input_sha256: retained.job.packet_sha256,
      });
      retained.job.result = normalizeReviewResult(seededRaw, retained.job);
      fs.writeFileSync(path.join(retained.dir, "stdout.txt"), seededBytes, { mode: 0o600 });
      saveJob(retained.dir, retained.job);
      const sourceBytes = fs.readFileSync(path.join(retained.dir, "job.json"));
      const repaired = await ctx.executeTool(
        "spec_review",
        { action: "repair", jobId },
        { signal },
      );
      assert.equal(repaired.isError, false, JSON.stringify(repaired));
      assert.equal(repaired.result.structuredContent.modelInvoked, false);
      assert.equal(repaired.result.structuredContent.result.verdict, "pass");
      assert.equal(repaired.result.structuredContent.receipt.recovery.source_job_id, jobId);
      const denied = await ctx.executeTool(
        "spec_review",
        { action: "repair", jobId, budgetId: "not-authorized" },
        { signal },
      );
      assert.equal(denied.isError, true);
      assert.deepEqual(fs.readFileSync(path.join(retained.dir, "job.json")), sourceBytes);
      assert.deepEqual(fs.readFileSync(path.join(cwd, "docs/specs/S1.md")), beforeSpec);
      assert.equal(fs.existsSync(path.join(store, "budgets")), false);
      // Separate synthetic v3 receipt proves real host serialization/consumption,
      // NOT a provider finding, executed child, semantic review or acceptance.
      const coveragePrepared = await ctx.executeTool(
        "spec_review",
        { mode: "proposal", id: "S1" },
        { signal },
      );
      const v3 = loadJob(ctx.cwd, coveragePrepared.result.structuredContent.jobId);
      const rawV3 = mechanicalCoverage(
        {
          verdict: "pass",
          criteria: [
            { criterion: "fixture static record", status: "pass", evidence: "synthetic only" },
          ],
          scope_deviations: [],
        },
        fs.readFileSync(path.join(v3.dir, "packet.md"), "utf8"),
      );
      const acceptance = rawV3.coverage.find((row) =>
        v3.job.coverage_index.acceptance_ids.includes(row.id),
      );
      acceptance.disposition = "gap";
      acceptance.acceptance_ids = [];
      acceptance.criterion_ids = [];
      acceptance.evidence =
        "Synthetic missing-entry-evidence classification; no actual model discovery";
      const rawBytes = JSON.stringify(rawV3);
      Object.assign(v3.job, {
        state: "completed",
        model_invoked: false,
        raw_verdict: "pass",
        raw_sha256: digest(rawBytes),
        child_input_sha256: v3.job.packet_sha256,
      });
      v3.job.result = normalizeReviewResult(rawV3, v3.job);
      fs.writeFileSync(path.join(v3.dir, "stdout.txt"), rawBytes, { mode: 0o600 });
      saveJob(v3.dir, v3.job);
      const coverageStatus = await ctx.executeTool(
        "spec_review",
        { action: "status", jobId: v3.job.id },
        { signal },
      );
      assert.equal(coverageStatus.isError, false, JSON.stringify(coverageStatus));
      assert.equal(coverageStatus.result.structuredContent.outputInfo.category, "coverage-gap");
      assert.equal(
        coverageStatus.result.structuredContent.result.coverage_summary.semantic_guarantee,
        false,
      );
      assert.equal(coverageStatus.result.structuredContent.result.verdict, "fail");
      assert.equal(coverageStatus.result.structuredContent.modelInvoked, false);
      // ─── S2.2 native board / free audit prepare / failure / long receipt ───
      const specPath = path.join(cwd, "docs/specs/S1.md");
      const boardRecord = await ctx.executeTool("spec_board", {}, { signal });
      assert.equal(boardRecord.isError, false, JSON.stringify(boardRecord));
      assert.equal(boardRecord.result.structuredContent.freshness, "record-only");
      assert.equal(boardRecord.result.structuredContent.specs[0].id, "S1");
      assert.ok(Array.isArray(boardRecord.result.structuredContent.specs[0].nextActions));
      assert.match(boardRecord.result.content[0].text, /record-only/);

      // Synthesize a v2 in-progress Spec with a passing impl binding in this
      // disposable repo, then add an uncommitted change for a non-empty diff.
      const liveBody =
        "# Offline contract\n\n- 状态：进行中\n\n## Outcome\n\n- [A1] native audit prepare\n";
      const liveFm = {
        id: "S1",
        title: "Offline contract",
        kind: "spec",
        author: "agent",
        status: "in-progress",
        created: "2026-10-22",
        review: { decision: "approved" },
        evidence: { e2e: [], migrations: [], human: [] },
        template: {
          version: 2,
          sha256: "358de590b6ba9668445b5880a12561216ed9e9d215c4a07d6b3ddfc1ab92accf",
        },
        workflow_version: 2,
      };
      fs.writeFileSync(specPath, writeFrontmatter(liveBody, liveFm));
      fs.writeFileSync(path.join(cwd, "impl-change.txt"), "uncommitted native fixture\n");
      const liveProfile = loadProjectProfile(cwd);
      const contractHash = specContractHash(fs.readFileSync(specPath, "utf8"), liveProfile);
      const liveSnapshot = await repositorySnapshotHash(cwd, { excludePaths: [specPath] });
      fs.writeFileSync(
        specPath,
        writeFrontmatter(liveBody, {
          ...liveFm,
          impl: {
            base_sha: sha,
            at: new Date().toISOString(),
            pass: true,
            required_gates: [],
            gates: {},
            e2e: {},
            migrations: { pass: true, checked: [], problems: [] },
            diagnostics: [],
            snapshot_hash: liveSnapshot.hash,
            contract_hash: contractHash,
          },
        }),
      );
      assert.equal(specContractHash(fs.readFileSync(specPath, "utf8"), liveProfile), contractHash);
      assert.equal(findSpec(cwd, "S1").frontmatter.impl.pass, true);

      const boardLive = await ctx.executeTool("spec_board", { live: true }, { signal });
      assert.equal(boardLive.isError, false, JSON.stringify(boardLive));
      assert.equal(boardLive.result.structuredContent.freshness, "live");
      assert.equal(boardLive.result.structuredContent.specs[0].fresh, true);
      assert.equal(boardLive.result.structuredContent.specs[0].stage, "audit");

      // A12: a registered but unverifiable sibling worktree must surface a
      // structured member diagnostic through the native tools, not a raw Git
      // error, and must not allocate an ID or mutate the current Spec.
      const member = path.join(sandbox, "prunable member");
      execFileSync("git", ["worktree", "add", "--detach", member], { cwd });
      fs.rmSync(path.join(member, ".git"));
      const specBeforeFamily = fs.readFileSync(specPath);
      try {
        for (const [name, args] of [
          ["spec_alloc", { prefix: "S" }],
          ["spec_new", { title: "Blocked by family" }],
        ]) {
          const blocked = await ctx.executeTool(name, args, { signal });
          assert.equal(blocked.isError, true, JSON.stringify(blocked));
          const diagnostic = blocked.result.structuredContent.diagnostic;
          assert.equal(diagnostic.code, "SPECFLOW_WORKTREE_UNAVAILABLE");
          assert.equal(diagnostic.stage, "worktree-inventory");
          assert.equal(diagnostic.member.prunable, true);
          assert.ok(
            diagnostic.nextActions.some((action) => /prune --dry-run/.test(action.args.command)),
          );
          assert.match(blocked.result.content[0].text, /SPECFLOW_WORKTREE_UNAVAILABLE/);
          assert.match(blocked.result.content[0].text, /prunable/);
          assert.doesNotMatch(blocked.result.content[0].text, /^fatal: not a git repository/m);
        }
        const preview = await ctx.executeTool(
          "spec_new",
          { title: "Read-only preview", dryRun: true },
          { signal },
        );
        assert.equal(preview.isError, false, JSON.stringify(preview));
        assert.equal(preview.result.structuredContent.dryRun, true);
        assert.deepEqual(fs.readFileSync(specPath), specBeforeFamily);
      } finally {
        execFileSync("git", ["worktree", "prune"], { cwd });
      }

      const beforePrepareSpec = fs.readFileSync(specPath);
      const ledgerPath = path.join(cwd, ".spec-flow-ledger.jsonl");
      const ledgerBefore = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : null;
      const auditPrepared = await ctx.executeTool(
        "spec_audit",
        { action: "prepare", id: "S1" },
        { signal },
      );
      assert.equal(auditPrepared.isError, false, JSON.stringify(auditPrepared));
      const preparedAudit = auditPrepared.result.structuredContent;
      assert.equal(preparedAudit.prepared, true);
      assert.equal(preparedAudit.modelInvoked, false);
      assert.equal(preparedAudit.state, "prepared");
      assert.equal(preparedAudit.action, "prepare");
      assert.match(preparedAudit.jobId, /^[a-f0-9]{32}$/);
      assert.ok(preparedAudit.packetPath.endsWith("/packet.md"));
      assert.ok(preparedAudit.bytes > 0);
      assert.equal(preparedAudit.receipt.packet_bytes, preparedAudit.bytes);
      // A3/A5: no explicit/env limit must seal source=default. The engine must
      // consume the already-resolved limit passed by core, not re-resolve the
      // internal numeric maxBytes as an "argument".
      assert.equal(preparedAudit.receipt.review_limit.source, "default");
      assert.ok(
        preparedAudit.nextActions.some(
          (action) => action.tool === "spec_audit" && action.requiresAuthorization === true,
        ),
      );
      assert.deepEqual(fs.readFileSync(specPath), beforePrepareSpec);
      assert.deepEqual(
        fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : null,
        ledgerBefore,
      );
      assert.equal(fs.existsSync(path.join(store, "budgets")), false);

      process.env.SPECFLOW_AUDIT_MAX_BYTES = "1";
      try {
        const envLimited = await ctx.executeTool(
          "spec_audit",
          { action: "prepare", id: "S1" },
          { signal },
        );
        assert.equal(envLimited.isError, true);
        assert.equal(envLimited.result.structuredContent.diagnostic.limitSource, "environment");
        assert.equal(envLimited.result.structuredContent.diagnostic.limitBytes, 1);
        const explicitLimit = await ctx.executeTool(
          "spec_audit",
          { action: "prepare", id: "S1", maxBytes: 524288 },
          { signal },
        );
        assert.equal(explicitLimit.isError, false, JSON.stringify(explicitLimit));
        assert.equal(
          explicitLimit.result.structuredContent.receipt.review_limit.source,
          "argument",
        );
        assert.equal(explicitLimit.result.structuredContent.receipt.review_limit.maxBytes, 524288);
      } finally {
        delete process.env.SPECFLOW_AUDIT_MAX_BYTES;
      }

      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify({ type: "module", scripts: { test: 'node -e "process.exit(1)"' } }),
      );
      const implFailed = await ctx.executeTool("spec_impl", { id: "S1" }, { signal });
      assert.equal(implFailed.isError, true, JSON.stringify(implFailed));
      assert.equal(implFailed.result.structuredContent.operation, "impl");
      assert.equal(implFailed.result.structuredContent.pass, false);
      assert.equal(implFailed.result.structuredContent.category, "impl-fail");
      assert.ok(implFailed.result.structuredContent.nextActions.length > 0);
      assert.match(implFailed.result.content[0].text, /impl: FAIL/);
      assert.match(fs.readFileSync(specPath, "utf8"), /pass: false/);
      assert.match(fs.readFileSync(ledgerPath, "utf8"), /"type":\s*"impl"/);

      // A real retained receipt >12000 chars through the model-visible channel.
      const longPrepared = await ctx.executeTool(
        "spec_review",
        { mode: "proposal", id: "S1" },
        { signal },
      );
      assert.equal(longPrepared.isError, false, JSON.stringify(longPrepared));
      const longJob = loadJob(ctx.cwd, longPrepared.result.structuredContent.jobId);
      seedLegacyReviewFixture(longJob.dir, longJob.job);
      const longRaw = {
        verdict: "pass",
        criteria: Array.from({ length: 30 }, (_, index) => ({
          id: `C${index + 1}`,
          criterion: `Synthetic long receipt criterion ${index + 1}`,
          status: "pass",
          evidence: `Synthetic receipt padding for the native text channel only ${index + 1}: ${"x".repeat(480)}`,
        })),
        // Exact legacy file/note object: compatible but still a protocol issue,
        // so the text summary must expose the free repair action.
        scope_deviations: [{ file: "outside.txt", note: "Synthetic compatibility observation" }],
      };
      const longBytes = JSON.stringify(longRaw);
      Object.assign(longJob.job, {
        state: "completed",
        model_invoked: false,
        raw_verdict: "pass",
        raw_sha256: digest(longBytes),
        child_input_sha256: longJob.job.packet_sha256,
      });
      longJob.job.result = normalizeReviewResult(longRaw, longJob.job);
      fs.writeFileSync(path.join(longJob.dir, "stdout.txt"), longBytes, { mode: 0o600 });
      saveJob(longJob.dir, longJob.job);
      assert.ok(JSON.stringify(longJob.job).length > 12000);
      const longStatus = await ctx.executeTool(
        "spec_review",
        { action: "status", jobId: longJob.job.id },
        { signal },
      );
      assert.equal(longStatus.isError, false, JSON.stringify(longStatus));
      const longValue = longStatus.result.structuredContent;
      assert.ok(longValue.result.criteria.length >= 30);
      assert.equal(longValue.outputInfo.category, "protocol-error");
      assert.equal(longValue.outputInfo.repairable, true);
      assert.ok(JSON.stringify(longValue.receipt).length > 12000);

      const longText = longStatus.result.content.map((part) => part.text).join("\n");
      assert.ok(longText.length <= 12100, `model text ${longText.length}`);
      assert.match(longText, /下一步:/);
      assert.match(longText, /"action":"repair"/);
      for (const expected of [
        longValue.jobId,
        "state=completed",
        longValue.packetPath,
        "下一步:",
        "摘要边界",
      ]) {
        assert.ok(longText.includes(expected), `long receipt text missing ${expected}`);
      }

      return {
        content: [{ type: "text", text: "offline native acceptance" }],
        details: {
          creation,
          prepared,
          replay,
          defaulted,
          status,
          proposal,
          repaired,
          coverageStatus,
          rejectedInputs: invalid.length,
          boardRecord,
          boardLive,
          preparedAudit,
          implFailed,
          longStatus,
        },
      };
    },
  });
  pi.registerCommand("fixture-native", {
    description: "Invokes real wrapped tool; no model",
    handler: () => {
      commandPromise = (async () => {
        const wrapped = currentSession.state.tools.find((tool) => tool.name === "fixture_probe");
        assert.ok(wrapped);
        outcome = await wrapped.execute("trusted-fixture", {}, new AbortController().signal);
      })();
      return commandPromise;
    },
  });
};
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
  additionalExtensionPaths: [fileURLToPath(new URL("../../packages/pi/index.ts", import.meta.url))],
  extensionFactories: [factory],
});
try {
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const result = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    modelRuntime: runtime,
    tools: [
      "spec_new",
      "spec_review",
      "spec_board",
      "spec_audit",
      "spec_impl",
      "spec_alloc",
      "fixture_probe",
    ],
    model: {
      id: "offline",
      name: "offline fixture",
      provider: "fixture-offline",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      maxTokens: 1,
    },
  });
  currentSession = result.session;
  currentSession.subscribe((event) => seen.push(event));
  await currentSession.bindExtensions({});
  currentSession.setActiveToolsByName([
    "spec_new",
    "spec_review",
    "spec_board",
    "spec_audit",
    "spec_impl",
    "spec_alloc",
    "fixture_probe",
  ]);
  for (const name of ["spec_new", "spec_review"]) {
    assert.ok(
      currentSession.getCallableToolNames().includes(name),
      JSON.stringify({
        missing: name,
        tools: currentSession.getAllTools().map((tool) => tool.name),
        extensions: loader.getExtensions().extensions.map((extension) => extension.path),
      }),
    );
    assert.ok(currentSession.getToolDefinition(name).outputSchema);
    assert.ok(currentSession.systemPrompt.includes(name));
  }
  assert.ok(currentSession.getToolDefinition("spec_review").outputSchema.properties.executionInfo);
  // The nested-call pipeline needs an issuing assistant. Seed one dummy, zero-usage
  // tool call in the PRIVATE in-memory manager; it is plumbing, not model evidence.
  currentSession.sessionManager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "fixture-offline",
    model: "synthetic-plumbing",
    content: [{ type: "toolCall", id: "trusted-fixture", name: "fixture_probe", arguments: {} }],
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  currentSession.refreshContext();
  await currentSession.prompt("/fixture-native");
  await commandPromise;
  assert.ok(outcome);
  assert.equal(outcome.details?.rejectedInputs, 10, JSON.stringify(outcome));
  console.log(
    "PASS native v3 index/template v2 and synthetic coverage-gap structured output, default prepare/proposal/status/skipped run, legacy repair, invalid requests; no grant, charge, model or executor spawn",
  );
  assert.ok(
    seen.some(
      (event) =>
        event.type === "tool_execution_start" &&
        event.toolName === "spec_new" &&
        event.parentToolCallId,
    ),
  );
  await currentSession.prompt('/spec new {"title":"Command-created draft","prefix":"S"}');
  assert.ok(fs.existsSync(path.join(cwd, "docs/specs/S2-spec.md")));
  await currentSession.prompt(`/spec review ${JSON.stringify({ mode: "proposal", id: "S1" })}`);
  assert.ok(
    !seen.some((event) =>
      ["agent_start", "auto_retry_start", "auto_compaction_start"].includes(event.type),
    ),
  );
  assert.equal(currentSession.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(
    currentSession.messages.find((message) => message.role === "assistant").model,
    "synthetic-plumbing",
  );
  console.log(
    "PASS trusted Pi 1.x discovers typed tools and calls them through ctx.executeTool + handled commands, no provider/production state",
  );
} finally {
  currentSession?.dispose();
  fs.rmSync(sandbox, { recursive: true, force: true });
}
