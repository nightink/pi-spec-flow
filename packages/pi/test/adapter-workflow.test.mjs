// adapter-workflow.test.mjs — host-free tests for the agent-facing text/error
// contract added for S2.2. These helpers never decide evidence or authorization.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failureResult,
  formatBoardText,
  formatNextAction,
  formatNextActions,
  formatOutcomeText,
  formatReviewSummary,
  reviewNextActions,
  reviewReceiptPath,
  specflowFailure,
  TOOL_TEXT_LIMIT,
} from "../adapter-core.mjs";

const ACTION = {
  tool: "spec_review",
  args: { action: "run", jobId: "a".repeat(32) },
  reason: "run 仅消费已存在的授权 grant",
  requiresAuthorization: true,
  requiresHuman: false,
};

function baseStatus(overrides = {}) {
  return {
    version: 1,
    jobId: "b".repeat(32),
    mode: "working-tree-audit",
    state: "prepared",
    modelInvoked: false,
    receipt: { mode: "working-tree-audit", bindings: { spec_id: "S9" } },
    packetPath: `/private/spec-flow/review-v1/jobs/${"b".repeat(32)}/packet.md`,
    result: null,
    ...overrides,
  };
}

// ─── nextActions rendering ─────────────────────────────────────────────────

test("formatNextAction 显示 tool/args/reason 与授权、人工标记", () => {
  assert.equal(
    formatNextAction(ACTION),
    `- spec_review {"action":"run","jobId":"${"a".repeat(32)}"} [requiresAuthorization] — run 仅消费已存在的授权 grant`,
  );
  assert.equal(
    formatNextAction({
      tool: "spec_attest",
      args: { id: "S9", item: "R1" },
      reason: "人工核验",
      requiresHuman: true,
    }),
    '- spec_attest {"id":"S9","item":"R1"} [requiresHuman] — 人工核验',
  );
  assert.match(formatNextActions([]), /none/);
  assert.equal(formatNextActions([ACTION]).split("\n").length, 1);
});

test("reviewNextActions: prepared 普通审查 → 授权 run；不伪造授权", () => {
  const actions = reviewNextActions(
    baseStatus({ mode: "proposal", receipt: { mode: "proposal", bindings: {} } }),
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].tool, "spec_review");
  assert.deepEqual(actions[0].args, { action: "run", jobId: "b".repeat(32) });
  assert.equal(actions[0].requiresAuthorization, true);
  assert.equal(actions[0].requiresHuman, false);
});

test("reviewNextActions: prepared full audit → spec_audit 复用 reviewJobId", () => {
  const actions = reviewNextActions(baseStatus());
  assert.deepEqual(actions[0].args, { id: "S9", reviewJobId: "b".repeat(32) });
  assert.equal(actions[0].requiresAuthorization, true);
});

test("reviewNextActions: repairable 协议错误 → 免费 repair；失败 job 只读 status", () => {
  const repairable = reviewNextActions(
    baseStatus({
      state: "completed",
      outputInfo: { category: "protocol-error", repairable: true },
    }),
  );
  assert.deepEqual(repairable[0].args, { action: "repair", jobId: "b".repeat(32) });
  assert.equal(repairable[0].requiresAuthorization, false);

  const failed = reviewNextActions(baseStatus({ state: "failed" }));
  assert.deepEqual(failed[0].args, { action: "status", jobId: "b".repeat(32) });
  assert.equal(failed[0].requiresAuthorization, false);
});

test("reviewNextActions: 已有 core nextActions 时原样透传", () => {
  const actions = reviewNextActions(baseStatus({ nextActions: [ACTION] }));
  assert.deepEqual(actions, [ACTION]);
});

// ─── bounded review summary (>12000-char receipt) ──────────────────────────

test("formatReviewSummary 大 receipt 仍先给 state/category/jobId/packetPath/nextActions", () => {
  const hugeReceipt = {
    ...baseStatus().receipt,
    state: "completed",
    raw_stdout: "x".repeat(20000),
    criteria: Array.from({ length: 120 }, (_, index) => ({
      criterion: `criterion ${index} ${"y".repeat(120)}`,
    })),
  };
  const status = baseStatus({
    state: "completed",
    receipt: hugeReceipt,
    outputInfo: { category: "product-fail", code: "REVIEW_FINDING", repairable: false },
    result: { verdict: "fail", criteria: [{ criterion: "one" }] },
  });
  assert.ok(JSON.stringify(status).length > TOOL_TEXT_LIMIT, "fixture must exceed the model cap");

  const text = formatReviewSummary(status);
  assert.ok(text.length <= TOOL_TEXT_LIMIT + 100, `summary grew to ${text.length}`);
  for (const expected of [
    "state=completed",
    "category=product-fail",
    `job=${"b".repeat(32)}`,
    status.packetPath,
    "下一步:",
    "摘要边界",
  ]) {
    assert.ok(text.includes(expected), `missing ${expected}\n${text}`);
  }
  assert.ok(!text.startsWith("{"), "must not be a head-truncated JSON dump");
  assert.ok(!text.includes("x".repeat(1000)), "receipt body must not be copied into model text");
  assert.ok(
    text.indexOf("下一步:") < text.indexOf("摘要边界"),
    "recovery actions come before the boundary note",
  );
});

test("reviewReceiptPath 从封存 packet 推导私有 job.json，非法输入返回 null", () => {
  assert.equal(
    reviewReceiptPath(`/private/jobs/${"a".repeat(32)}/packet.md`),
    `/private/jobs/${"a".repeat(32)}/job.json`,
  );
  assert.equal(reviewReceiptPath(""), null);
  assert.equal(reviewReceiptPath(undefined), null);
});

// ─── board text ────────────────────────────────────────────────────────────

test("formatBoardText: record-only 明说未查 freshness；live 显示 yes/NO 与阻塞", () => {
  const board = {
    version: 1,
    freshness: "record-only",
    summary: "2 specs, 1 active",
    specs: [
      {
        id: "S9",
        status: "in-progress",
        stage: "impl",
        fresh: null,
        blockers: ["impl 未通过"],
        nextActions: [ACTION],
      },
    ],
  };
  const record = formatBoardText(board);
  assert.match(record, /record-only/);
  assert.match(record, /fresh=not-checked/);
  assert.match(record, /impl 未通过/);
  assert.match(record, /requiresAuthorization/);
  assert.match(record, /freshness 时用 live=true/);

  const live = formatBoardText({
    ...board,
    freshness: "live",
    specs: [{ ...board.specs[0], fresh: false }],
  });
  assert.match(live, /fresh=NO/);
  assert.doesNotMatch(live, /freshness 时用 live=true/);
  assert.ok(live.length <= TOOL_TEXT_LIMIT + 100);
});

// ─── impl/audit outcome text ───────────────────────────────────────────────

test("formatOutcomeText 长 summary 不挤掉 nextActions 与 job/packet 恢复入口", () => {
  const outcome = {
    version: 1,
    operation: "audit",
    specId: "S9",
    pass: false,
    category: "product-fail",
    summary: `criteria:\n${"z".repeat(30000)}`,
    nextActions: [ACTION],
    jobId: "c".repeat(32),
    packetPath: "/private/jobs/c/packet.md",
  };
  const text = formatOutcomeText(outcome);
  assert.ok(text.length <= TOOL_TEXT_LIMIT + 100);
  for (const expected of [
    "Spec S9 audit: FAIL",
    "category=product-fail",
    `job=${"c".repeat(32)}`,
    outcome.packetPath,
    "下一步:",
    "requiresAuthorization",
    "摘要边界",
  ]) {
    assert.ok(text.includes(expected), `missing ${expected}\n${text}`);
  }
  assert.ok(
    !text.includes("z".repeat(1000)) || text.includes("输出已截断"),
    "long output is explicitly marked when clipped",
  );
});

test("formatOutcomeText PASS 不伪造 FAIL；诊断行包含 code/stage", () => {
  const text = formatOutcomeText({
    version: 1,
    operation: "impl",
    specId: "S9",
    pass: true,
    category: "pass",
    summary: "门禁全部通过",
    nextActions: [],
    diagnostic: { code: "X", category: "y", stage: "z" },
  });
  assert.match(text, /impl: PASS/);
  assert.match(text, /诊断: X \(y\) stage=z/);
  assert.match(text, /none/);
});

// ─── structured failure propagation (A12) ──────────────────────────────────

test("failureResult 保留 core error.diagnostic 的 code/category/nextActions 且 isError", () => {
  const diagnostic = {
    version: 1,
    code: "WORKTREE_FAMILY_UNAVAILABLE",
    category: "workspace",
    stage: "alloc",
    message: "family member prunable: /tmp/gone",
    members: [{ path: "/tmp/gone", problem: "prunable" }],
    nextActions: [{ ...ACTION, requiresAuthorization: false, requiresHuman: true }],
  };
  const error = Object.assign(new Error(diagnostic.message), { diagnostic });
  const result = failureResult(error, "alloc", { specId: null });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.version, 1);
  assert.equal(result.structuredContent.operation, "alloc");
  assert.equal(result.structuredContent.pass, false);
  assert.equal(result.structuredContent.category, "workspace");
  assert.equal(result.structuredContent.diagnostic.code, "WORKTREE_FAMILY_UNAVAILABLE");
  assert.deepEqual(result.structuredContent.diagnostic.members, diagnostic.members);
  assert.equal(result.structuredContent.nextActions[0].requiresHuman, true);
  assert.match(result.content[0].text, /WORKTREE_FAMILY_UNAVAILABLE/);
  assert.match(result.content[0].text, /requiresHuman/);
});

test("specflowFailure 对无 diagnostic 的普通异常给稳定 envelope", () => {
  const failure = specflowFailure(new Error("boom"), "board", { specId: "S9" });
  assert.equal(failure.category, "tool-error");
  assert.equal(failure.diagnostic.code, "Error");
  assert.equal(failure.summary, "boom");
  assert.deepEqual(failure.nextActions, []);
});

// ─── fake-Pi integration: real core, no provider/budget ────────────────────

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function writeFile(path, text) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
}

async function loadFakePiAdapter() {
  const root = fs.mkdtempSync(join(os.tmpdir(), "specflow-workflow-"));
  writeFile(join(root, "package.json"), '{"type":"module"}\n');
  fs.copyFileSync(join(here, "../index.ts"), join(root, "index.ts"));
  fs.mkdirSync(join(root, "node_modules/@nightink"), { recursive: true });
  fs.symlinkSync(
    resolve(here, "../../core"),
    join(root, "node_modules/@nightink/spec-flow-core"),
    "dir",
  );
  fs.symlinkSync(join(here, "../adapter-core.mjs"), join(root, "adapter-core.mjs"));
  const agentDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
  writeFile(join(agentDir, "package.json"), '{"type":"module","exports":"./index.js"}\n');
  writeFile(
    join(agentDir, "index.js"),
    `const tails = new Map();
export async function withFileMutationQueue(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try { return await fn(); }
  finally { release(); if (tails.get(key) === tail) tails.delete(key); }
}
`,
  );
  writeFile(
    join(root, "node_modules/typebox/package.json"),
    '{"type":"module","exports":"./index.js"}\n',
  );
  writeFile(
    join(root, "node_modules/typebox/index.js"),
    "export const Type = { Object: (value, options = {}) => ({ type: 'object', properties: value, ...options }), Optional: (value) => value, Array: (value) => ({items:value}), Union: (value) => ({anyOf:value}), Any: () => ({}), Null: () => ({type:'null'}), Literal: (value) => ({const:value}), Boolean: () => ({type:'boolean'}), Integer: () => ({type:'integer'}), String: (value = {}) => ({ type: 'string', ...value }) };\n",
  );

  const project = join(root, "project");
  writeFile(
    join(project, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: 'node -e "process.exit(1)"' } }),
  );
  writeFile(join(project, "src.txt"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["add", "."], { cwd: project });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "base",
    ],
    { cwd: project },
  );
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: project,
    encoding: "utf8",
  }).trim();
  const specPath = join(project, "docs/specs/S9.md");
  writeFile(
    specPath,
    `---
id: S9
title: Workflow fixture
kind: spec
author: agent
status: in-progress
created: '2026-10-22'
review:
  decision: approved
evidence:
  e2e: []
  migrations: []
  human: []
template:
  version: 2
  sha256: 358de590b6ba9668445b5880a12561216ed9e9d215c4a07d6b3ddfc1ab92accf
workflow_version: 2
impl:
  base_sha: ${base}
---

# Workflow fixture

- 状态：进行中

## Outcome

- 让 fixture 可测
`,
  );
  execFileSync("git", ["add", "."], { cwd: project });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "spec",
    ],
    { cwd: project },
  );

  const tools = new Map();
  const fakePi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {
      // This fake host registers no commands.
    },
    on() {
      // This fake host registers no event handlers.
    },
  };
  const extension = await import(`${pathToFileURL(join(root, "index.ts")).href}?v=${Date.now()}`);
  extension.default(fakePi);
  return {
    root,
    project,
    specPath,
    tools,
    ctx: { cwd: project, hasUI: false, ui: undefined },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("native workflow: board 默认 record-only、live 识别漂移、impl FAIL isError、诊断结构化", async () => {
  const harness = await loadFakePiAdapter();
  const { tools, ctx, project, specPath } = harness;
  try {
    const board = await tools.get("spec_board").execute("board", {}, undefined, undefined, ctx);
    assert.ok(!board.isError);
    assert.equal(board.structuredContent.freshness, "record-only");
    assert.equal(board.structuredContent.specs[0].id, "S9");
    assert.equal(board.structuredContent.specs[0].stage, "impl");
    assert.equal(board.structuredContent.specs[0].nextActions[0].tool, "spec_impl");
    assert.match(board.content[0].text, /record-only/);

    const impl = await tools
      .get("spec_impl")
      .execute("impl", { id: "S9" }, undefined, undefined, ctx);
    assert.equal(impl.isError, true, JSON.stringify(impl));
    assert.equal(impl.structuredContent.pass, false);
    assert.equal(impl.structuredContent.category, "impl-fail");
    assert.equal(impl.structuredContent.operation, "impl");
    assert.ok(impl.structuredContent.nextActions.length > 0);
    assert.match(impl.content[0].text, /impl: FAIL/);
    assert.match(fs.readFileSync(specPath, "utf8"), /pass: false/);

    const liveClean = await tools
      .get("spec_board")
      .execute("live-clean", { live: true }, undefined, undefined, ctx);
    assert.ok(!liveClean.isError);
    assert.equal(liveClean.structuredContent.freshness, "live");
    assert.equal(liveClean.structuredContent.specs[0].stage, "impl-fail");
    assert.equal(liveClean.structuredContent.specs[0].fresh, true);

    writeFile(join(project, "src.txt"), "changed after impl\n");
    const liveStale = await tools
      .get("spec_board")
      .execute("live-stale", { live: true }, undefined, undefined, ctx);
    assert.equal(liveStale.structuredContent.freshness, "live");
    assert.equal(liveStale.structuredContent.specs[0].fresh, false);
    assert.equal(liveStale.structuredContent.specs[0].stage, "impl");
    assert.ok(
      liveStale.structuredContent.specs[0].nextActions.some(
        (action) => action.tool === "spec_impl",
      ),
    );
    assert.match(liveStale.content[0].text, /fresh=NO/);

    const before = fs.readFileSync(specPath);
    const prepare = await tools
      .get("spec_audit")
      .execute("prepare", { action: "prepare", id: "S9" }, undefined, undefined, ctx);
    assert.equal(prepare.isError, true, JSON.stringify(prepare));
    assert.equal(prepare.structuredContent.pass, false);
    assert.equal(prepare.structuredContent.operation, "audit");
    assert.equal(prepare.structuredContent.category, "precondition-error");
    assert.match(prepare.structuredContent.diagnostic.code, /IMPL|AUDIT/);
    assert.ok(prepare.structuredContent.nextActions.length > 0);
    assert.deepEqual(fs.readFileSync(specPath), before, "free prepare must not write the Spec");

    const auditRun = await tools
      .get("spec_audit")
      .execute("run", { id: "S9" }, undefined, undefined, ctx);
    assert.equal(auditRun.isError, true, JSON.stringify(auditRun));
    assert.equal(auditRun.structuredContent.operation, "audit");
    assert.equal(auditRun.structuredContent.pass, false);
    assert.equal(auditRun.structuredContent.category, "precondition-error");
    assert.match(auditRun.content[0].text, /impl is not explicitly passing/);
    assert.deepEqual(
      fs.readFileSync(specPath),
      before,
      "failed audit run writes no impostor evidence",
    );

    await assert.rejects(
      tools
        .get("spec_audit")
        .execute(
          "prepare-grant",
          { action: "prepare", id: "S9", budgetId: "not-authorized" },
          undefined,
          undefined,
          ctx,
        ),
      /prepare is free and forbids/,
    );
    for (const args of [
      { id: "S9", reviewJobId: "a".repeat(32), maxBytes: 1024 },
      { id: "S9", action: "run", maxBytes: 1024 },
    ]) {
      await assert.rejects(
        tools.get("spec_audit").execute("run-limit", args, undefined, undefined, ctx),
        /maxBytes is valid only with action=prepare/,
      );
    }
  } finally {
    harness.cleanup();
  }
});

test("native review: maxBytes 显式>环境>默认，超限返回 isError 诊断且不建 job", async () => {
  const harness = await loadFakePiAdapter();
  const { tools, ctx } = harness;
  try {
    const tiny = await tools
      .get("spec_review")
      .execute(
        "tiny",
        { action: "prepare", mode: "proposal", id: "S9", maxBytes: 1 },
        undefined,
        undefined,
        ctx,
      );
    assert.equal(tiny.isError, true);
    assert.equal(tiny.structuredContent.pass, false);
    assert.equal(tiny.structuredContent.diagnostic.code, "REVIEW_PACKET_LIMIT");
    assert.equal(tiny.structuredContent.diagnostic.limitBytes, 1);
    assert.equal(tiny.structuredContent.diagnostic.source, "argument");
    assert.ok(tiny.structuredContent.nextActions.length > 0);
    assert.match(tiny.content[0].text, /REVIEW_PACKET_LIMIT/);

    process.env.SPECFLOW_AUDIT_MAX_BYTES = "1";
    try {
      const envBlocked = await tools
        .get("spec_review")
        .execute(
          "env",
          { action: "prepare", mode: "proposal", id: "S9" },
          undefined,
          undefined,
          ctx,
        );
      assert.equal(envBlocked.isError, true);
      assert.equal(envBlocked.structuredContent.diagnostic.limitBytes, 1);
      assert.equal(envBlocked.structuredContent.diagnostic.source, "environment");

      const explicitWins = await tools
        .get("spec_review")
        .execute(
          "explicit",
          { action: "prepare", mode: "proposal", id: "S9", maxBytes: 524288 },
          undefined,
          undefined,
          ctx,
        );
      assert.ok(!explicitWins.isError, JSON.stringify(explicitWins));
      assert.equal(explicitWins.structuredContent.state, "prepared");
      assert.deepEqual(explicitWins.structuredContent.receipt.review_limit, {
        version: 1,
        maxBytes: 524288,
        source: "argument",
      });
      assert.ok(explicitWins.structuredContent.jobId);
      assert.ok(explicitWins.structuredContent.packetPath.endsWith("/packet.md"));
      const text = explicitWins.content[0].text;
      assert.ok(text.includes(explicitWins.structuredContent.jobId));
      assert.ok(text.includes(explicitWins.structuredContent.packetPath));
      assert.match(text, /下一步:/);
      assert.match(text, /摘要边界/);
      assert.ok(!text.trimStart().startsWith("{"), "no head-truncated JSON dump");
    } finally {
      delete process.env.SPECFLOW_AUDIT_MAX_BYTES;
    }
  } finally {
    harness.cleanup();
  }
});
