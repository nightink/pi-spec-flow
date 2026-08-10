// spec-flow core.test.mjs — node --test self-verification
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  parseFrontmatter,
  writeFrontmatter,
  extractStatusLine,
  updateStatusLine,
  detectDrift,
  detectProjectConfig,
  loadSpecs,
  migrateAlloc,
  attest,
  done,
  board,
  checkCI,
  audit,
  shouldBypass,
} from "./core.mjs";

// Helper: create temp project
function mkProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────
test("frontmatter: parse and write roundtrip", () => {
  const content = `---
id: S1.0
status: pending
---

# Title

Body`;

  const fm = parseFrontmatter(content);
  assert.equal(fm?.data?.id, "S1.0");
  assert.equal(fm?.data?.status, "pending");

  const written = writeFrontmatter(content, { ...fm.data, status: "in-progress" });
  const fm2 = parseFrontmatter(written);
  assert.equal(fm2?.data?.status, "in-progress");
  assert.ok(written.includes("# Title"));
});

test("frontmatter: missing returns null", () => {
  const content = "# No frontmatter\n\nBody";
  const fm = parseFrontmatter(content);
  assert.equal(fm, null);
});

// ─── Status line ─────────────────────────────────────────────────────────────
test("status line: extract and update", () => {
  const content = `---
status: pending
---

- 状态：待 review
- 规模：L

Body`;

  const extracted = extractStatusLine(content);
  assert.equal(extracted, "待 review");

  const updated = updateStatusLine(content, "in-progress");
  const newLine = extractStatusLine(updated);
  assert.equal(newLine, "进行中");
});

test("status line: update preserves note", () => {
  const content = `- 状态：进行中（2026-08-10 开工）`;
  const updated = updateStatusLine(content, "done");
  assert.ok(updated.includes("已完成"));
  // Note should be preserved when no new note is provided
  assert.ok(updated.includes("2026-08-10 开工"));
});

test("status line: update replaces note when new note provided", () => {
  const content = `- 状态：进行中（旧备注）`;
  const updated = updateStatusLine(content, "done", "新备注");
  assert.ok(updated.includes("已完成"));
  assert.ok(updated.includes("新备注"));
  assert.ok(!updated.includes("旧备注"));
});

test("status line: update without note on line without note", () => {
  const content = `- 状态：进行中`;
  const updated = updateStatusLine(content, "done");
  assert.equal(updated, `- 状态：已完成`);
});

// ─── Drift detection ─────────────────────────────────────────────────────────
test("drift: no drift when body matches frontmatter", () => {
  const content = `---
status: in-progress
---

- 状态：进行中`;

  const fm = parseFrontmatter(content);
  const drift = detectDrift(content, fm.data);
  assert.equal(drift.drifted, false);
});

test("drift: detect mismatch", () => {
  const content = `---
status: in-progress
---

- 状态：已完成`;

  const fm = parseFrontmatter(content);
  const drift = detectDrift(content, fm.data);
  assert.equal(drift.drifted, true);
  assert.equal(drift.expected, "进行中");
  assert.equal(drift.got, "已完成");
});

test("drift: ignore parenthetical notes", () => {
  const content = `---
status: in-progress
---

- 状态：进行中（2026-08-10 开工）`;

  const fm = parseFrontmatter(content);
  const drift = detectDrift(content, fm.data);
  assert.equal(drift.drifted, false);
});

test("drift: ignore emoji prefix", () => {
  const content = `---
status: in-progress
---

- 状态：🔄 进行中（2026-08-10 开工）`;

  const fm = parseFrontmatter(content);
  const drift = detectDrift(content, fm.data);
  assert.equal(drift.drifted, false);
});

// ─── Project config detection ────────────────────────────────────────────────
test("config: detect gates", () => {
  const dir = mkProject({
    "package.json": JSON.stringify({
      scripts: {
        typecheck: "tsc",
        test: "vitest run",
      },
    }),
    "biome.json": "{}",
  });

  const config = detectProjectConfig(dir);
  assert.equal(config.gates.length, 3);
  assert.ok(config.gates.some((g) => g.name === "typecheck"));
  assert.ok(config.gates.some((g) => g.name === "biome"));
  assert.ok(config.gates.some((g) => g.name === "vitest"));
});

test("config: degrade gracefully when no config", () => {
  const dir = mkProject({});
  const config = detectProjectConfig(dir);
  assert.equal(config.gates.length, 0);
  assert.equal(config.e2eFiles.length, 0);
  assert.equal(config.migFiles.length, 0);
});

// ─── migrate-alloc ───────────────────────────────────────────────────────────
test("migrate-alloc: increment from last", () => {
  const dir = mkProject({
    "packages/db/src/migrations/001-init.ts": "",
    "packages/db/src/migrations/002-add.ts": "",
    "packages/db/src/migrations/015-last.ts": "",
  });

  const next = migrateAlloc(dir);
  assert.equal(next, "016");
});

test("migrate-alloc: reject when no directory", () => {
  const dir = mkProject({});
  assert.throws(() => migrateAlloc(dir), /No migration directory/);
});

// ─── attest ──────────────────────────────────────────────────────────────────
test("attest: reject short note", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
evidence:
  human: [R1]
---

- 状态：进行中`,
  });

  assert.throws(
    () => attest(dir, "S1.0", "R1", "short"),
    /too short/
  );
});

test("attest: accept valid note", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
evidence:
  human: [R1]
---

- 状态：进行中`,
  });

  const output = attest(dir, "S1.0", "R1", "Verified with sample data in tests/fixtures/sample.json");
  assert.ok(output.includes("已登记"));

  // Check ledger
  const ledger = fs.readFileSync(path.join(dir, ".spec-flow-ledger.jsonl"), "utf8");
  assert.ok(ledger.includes('"type":"attest"'));
});

// ─── done ────────────────────────────────────────────────────────────────────
test("done: list gaps when incomplete", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
---

- 状态：进行中`,
  });

  assert.throws(
    () => done(dir, "S1.0"),
    /缺口/
  );
});

test("done: reject when audit sha stale", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  at: "2026-08-10T00:00:00Z"
  gates: {}
  e2e: {}
audit:
  verdict: pass
  sha: oldsha
---

- 状态：进行中`,
  });

  // Initialize git repo to get a real HEAD
  fs.writeFileSync(path.join(dir, ".gitignore"), "");
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dir,
      stdio: "pipe",
    });
  } catch {
    // git not available or commit failed, skip
    return;
  }

  assert.throws(
    () => done(dir, "S1.0"),
    /sha 过期/
  );
});

// ─── board ───────────────────────────────────────────────────────────────────
test("board: show managed and unmanaged specs", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: pending
---

- 状态：待 review`,
    "docs/specs/S2.0.md": `# No frontmatter

Body`,
  });

  const output = board(dir);
  assert.ok(output.includes("S1.0"));
  assert.ok(output.includes("待 review"));
  assert.ok(output.includes("S2.0.md"));
  assert.ok(output.includes("未纳管"));
});

// ─── Evidence validation ─────────────────────────────────────────────────────
test("evidence: check --ci detects missing e2e file", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
evidence:
  e2e: [e2e-99]
---

- 状态：进行中`,
  });

  const result = checkCI(dir);
  assert.equal(result.pass, false);
  assert.ok(result.output.includes("e2e-99.mjs"));
});

// ─── shouldBypass ────────────────────────────────────────────────────────────
test("bypass: env prefix to git commit is recognized", () => {
  assert.equal(shouldBypass("SPECFLOW_BYPASS=1 git commit -m 'fix'"), true);
  assert.equal(shouldBypass("SPECFLOW_BYPASS=1 git commit --allow-empty"), true);
});

test("bypass: after separator is recognized", () => {
  assert.equal(shouldBypass("echo ok; SPECFLOW_BYPASS=1 git commit -m 'x'"), true);
  assert.equal(shouldBypass("true && SPECFLOW_BYPASS=1 git commit -m 'x'"), true);
  assert.equal(shouldBypass("false || SPECFLOW_BYPASS=1 git commit -m 'x'"), true);
});

test("bypass: substring in commit message is NOT recognized", () => {
  assert.equal(
    shouldBypass('git commit -m "document SPECFLOW_BYPASS=1 behavior"'),
    false
  );
  assert.equal(
    shouldBypass('git commit -m "fix: SPECFLOW_BYPASS=1 now works"'),
    false
  );
});

test("bypass: no bypass var is not recognized", () => {
  assert.equal(shouldBypass("git commit -m 'normal'"), false);
  assert.equal(shouldBypass("OTHER_VAR=1 git commit -m 'x'"), false);
});

// ─── Audit criteria naming ──────────────────────────────────────────────────
test("audit: fallback uses spec-contract field names (criteria/status)", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  base_sha: abc123
---

- 状态：进行中`,
  });
  // Init git so getHeadSha works
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dir,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }
  // pi subprocess will fail in test env, triggering fallback path
  const output = await audit(dir, "S1.0");
  // The summary should use "criteria" not "findings"
  assert.ok(output.includes("criteria:"), "summary should say 'criteria:' not 'findings:'");
  assert.ok(!output.includes("findings:"), "should not contain old field name 'findings:'");
});

console.log("✅ All tests defined");
