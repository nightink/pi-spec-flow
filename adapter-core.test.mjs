// adapter-core.test.mjs — host-free unit tests for the Pi adapter helpers.
// Run: node --test adapter-core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ATTEST_NOTE_DISPLAY_LIMIT,
  TOOL_TEXT_LIMIT,
  attestationGate,
  formatAttestationPrompt,
  truncateToolText,
} from "./adapter-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const adapterSource = readFileSync(join(here, "index.ts"), "utf8");
const NOTE = "已在 tests/e2e/e2e-commit-gate.mjs 用临时仓库复现，输出 PASS 行";

// ─── attestationGate: allow / deny / no-UI ──────────────────────────────────

test("gate: allow — 用户确认后放行，透传 signal 且展示 item+note", async () => {
  const calls = [];
  const controller = new AbortController();
  const decision = await attestationGate({
    hasUI: true,
    id: "S1.2",
    item: "R1",
    note: NOTE,
    signal: controller.signal,
    confirm: async (title, body, opts) => {
      calls.push({ title, body, opts });
      return true;
    },
  });

  assert.deepEqual(decision, { allowed: true, reason: "confirmed" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /人工核验/);
  assert.match(calls[0].body, /S1\.2/);
  assert.match(calls[0].body, /R1/);
  assert.match(calls[0].body, /e2e-commit-gate\.mjs/);
  assert.equal(calls[0].opts?.signal, controller.signal);
});

test("gate: allow — 无可用 signal 时不传 opts", async () => {
  let opts = "unset";
  const decision = await attestationGate({
    hasUI: true,
    id: "S1.2",
    item: "R1",
    note: NOTE,
    confirm: async (_title, _body, o) => {
      opts = o;
      return true;
    },
  });

  assert.equal(decision.allowed, true);
  assert.equal(opts, undefined);
});

test("gate: deny — confirm 返回 false 时不放行", async () => {
  let called = 0;
  const decision = await attestationGate({
    hasUI: true,
    id: "S1.2",
    item: "R1",
    note: NOTE,
    confirm: async () => {
      called++;
      return false;
    },
  });

  assert.deepEqual(decision, { allowed: false, reason: "declined" });
  assert.equal(called, 1);
});

test("gate: deny — confirm 返回 undefined（取消）时不放行", async () => {
  const decision = await attestationGate({
    hasUI: true,
    id: "S1.2",
    item: "R1",
    note: NOTE,
    confirm: async () => undefined,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "declined");
});

test("gate: no-ui — hasUI=false 拒绝且不调用 confirm", async () => {
  let called = 0;
  const decision = await attestationGate({
    hasUI: false,
    id: "S1.2",
    item: "R1",
    note: NOTE,
    confirm: async () => {
      called++;
      return true;
    },
  });

  assert.deepEqual(decision, { allowed: false, reason: "no-ui" });
  assert.equal(called, 0);
});

test("gate: no-ui — hasUI=true 但没有 confirm 实现时同样拒绝", async () => {
  const decision = await attestationGate({
    hasUI: true,
    id: "S1.2",
    item: "R1",
    note: NOTE,
  });

  assert.deepEqual(decision, { allowed: false, reason: "no-ui" });
});

test("gate: confirm 抛错时向上抛出（不伪造放行/拒绝）", async () => {
  await assert.rejects(
    attestationGate({
      hasUI: true,
      id: "S1.2",
      item: "R1",
      note: NOTE,
      confirm: async () => {
        throw new Error("dialog exploded");
      },
    }),
    /dialog exploded/
  );
});

// ─── prompt / output truncation ─────────────────────────────────────────────

test("formatAttestationPrompt 同时包含 item 与 note，超长 note 有明确上限", () => {
  const longNote = "x".repeat(ATTEST_NOTE_DISPLAY_LIMIT + 500);
  const body = formatAttestationPrompt({ id: "S1.2", item: "R1", note: longNote });

  assert.match(body, /R1/);
  assert.match(body, /x{100}/);
  assert.match(body, /已截断 500 字符/);
  assert.ok(body.length < longNote.length, "prompt 不应包含完整超长 note");
});

test("truncateToolText 短文本原样返回、长文本截断并标记", () => {
  assert.equal(truncateToolText("hello"), "hello");

  const long = "a".repeat(TOOL_TEXT_LIMIT + 10);
  const clipped = truncateToolText(long);
  assert.ok(clipped.length <= TOOL_TEXT_LIMIT + 80);
  assert.match(clipped, /已截断 10 字符/);
  assert.ok(clipped.startsWith("a".repeat(TOOL_TEXT_LIMIT)));
});

// ─── index.ts source assertions (N1: mutation queue / throw 测试缝) ─────────

test("index.ts: begin/impl/audit/attest/done 都在 mutation queue 包裹内", () => {
  const wrapped = adapterSource.match(/runSpecMutation\(ctx\.cwd, params\.id/g) ?? [];
  assert.equal(wrapped.length, 5, "五个生命周期工具都必须走 runSpecMutation");

  for (const fn of ["begin", "impl", "audit", "attest", "done"]) {
    const pattern = new RegExp(
      `runSpecMutation\\(ctx\\.cwd, params\\.id, \\(\\) =>\\s*${fn}\\(ctx\\.cwd, params\\.id`
    );
    assert.match(adapterSource, pattern, `${fn} 必须经 withFileMutationQueue 包裹`);
  }

  assert.match(
    adapterSource,
    /withFileMutationQueue\(resolve\(spec\.path\)/,
    "队列 key 必须是解析后的真实 spec.path"
  );
});

test("index.ts: 工具错误直接 throw，不返回伪造的 isError 字段", () => {
  assert.doesNotMatch(adapterSource, /isError\s*:/);
  assert.match(adapterSource, /throw new Error\(`Spec \$\{id\} not found`\)/);
});

test("index.ts: 已移除无用 imports（migrateAlloc/checkCI/parseFrontmatter）", () => {
  assert.doesNotMatch(adapterSource, /migrateAlloc|checkCI|parseFrontmatter/);
});

test("index.ts: fake Pi 可加载注册，且并发 begin 由真实 spec path 串行化", async () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), "specflow-adapter-"));
  try {
    fs.writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(join(root, "index.ts"), adapterSource);
    fs.symlinkSync(join(here, "core.mjs"), join(root, "core.mjs"));
    fs.symlinkSync(join(here, "adapter-core.mjs"), join(root, "adapter-core.mjs"));

    const agentDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(join(agentDir, "package.json"), '{"type":"module","exports":"./index.js"}\n');
    fs.writeFileSync(
      join(agentDir, "index.js"),
      `const tails = new Map();
export const queueState = { active: 0, maxActive: 0, calls: [] };
export async function withFileMutationQueue(key, fn) {
  queueState.calls.push(key);
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  queueState.active++;
  queueState.maxActive = Math.max(queueState.maxActive, queueState.active);
  try { return await fn(); }
  finally {
    queueState.active--;
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
`
    );
    const typeboxDir = join(root, "node_modules/typebox");
    fs.mkdirSync(typeboxDir, { recursive: true });
    fs.writeFileSync(join(typeboxDir, "package.json"), '{"type":"module","exports":"./index.js"}\n');
    fs.writeFileSync(
      join(typeboxDir, "index.js"),
      "export const Type = { Object: (value) => value, String: (value = {}) => ({ type: 'string', ...value }) };\n"
    );

    const project = join(root, "project");
    fs.mkdirSync(join(project, "docs/specs"), { recursive: true });
    fs.writeFileSync(
      join(project, "docs/specs/S9.md"),
      `---
id: S9
status: approved
review:
  decision: approved
evidence:
  human: []
---

# Queue smoke

- 状态：已批准
`
    );
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync(
      "git",
      ["-c", "user.name=spec-flow", "-c", "user.email=spec-flow@example.invalid", "commit", "-qm", "init"],
      { cwd: project }
    );

    const tools = new Map();
    const commands = new Map();
    const events = new Map();
    const fakePi = {
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      on(name, handler) { events.set(name, handler); },
    };
    const extension = await import(`${pathToFileURL(join(root, "index.ts")).href}?v=${Date.now()}`);
    extension.default(fakePi);

    assert.deepEqual(
      [...tools.keys()].sort(),
      ["spec_attest", "spec_audit", "spec_begin", "spec_board", "spec_done", "spec_impl"]
    );
    assert.ok(commands.has("spec"));
    assert.ok(events.has("tool_call"));
    assert.ok(events.has("session_start"));

    const beginTool = tools.get("spec_begin");
    const ctx = {
      cwd: project,
      hasUI: true,
      ui: { notify() {}, confirm: async () => true },
    };
    const results = await Promise.allSettled([
      beginTool.execute("a", { id: "S9" }, undefined, undefined, ctx),
      beginTool.execute("b", { id: "S9" }, undefined, undefined, ctx),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const queueModule = await import(pathToFileURL(join(agentDir, "index.js")).href);
    assert.equal(queueModule.queueState.maxActive, 1);
    assert.equal(queueModule.queueState.calls.length, 2);
    assert.equal(queueModule.queueState.calls[0], join(project, "docs/specs/S9.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
