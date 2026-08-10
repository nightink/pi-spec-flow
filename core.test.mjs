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
  commitGateAction,
  parseE2eOutput,
  impl,
  buildAuditorArgs,
  nextStep,
  getHeadSha,
  parseVerdictJson,
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

test("done: accepts audit sha from impl.repo (external repo)", async () => {
  // Project A: spec project
  const dirA = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  repo: DIR_B_PLACEHOLDER
  at: "2026-08-10T00:00:00Z"
  gates: {}
  e2e: {}
audit:
  verdict: pass
  sha: SHA_B_PLACEHOLDER
evidence:
  human: []
---

- 状态：进行中`,
  });
  // Project B: separate implementation repo
  const dirB = mkProject({});
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dirB,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }
  const shaB = execSync("git rev-parse HEAD", { cwd: dirB, stdio: "pipe" }).toString().trim();

  // Also init dirA as git repo (but its HEAD will differ from dirB)
  execSync("git init && git add . && git commit -m init --allow-empty", {
    cwd: dirA,
    stdio: "pipe",
  });

  // Patch the spec to use actual dirB path and shaB
  let specContent = fs.readFileSync(path.join(dirA, "docs/specs/S1.0.md"), "utf8");
  specContent = specContent.replace("DIR_B_PLACEHOLDER", dirB);
  specContent = specContent.replace("SHA_B_PLACEHOLDER", shaB);
  fs.writeFileSync(path.join(dirA, "docs/specs/S1.0.md"), specContent);

  // done() should succeed — audit.sha matches dirB HEAD even though dirA HEAD differs
  const output = done(dirA, "S1.0");
  assert.ok(output.includes("已完成"));
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

test("done: ledger includes impl summary and audit info", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  at: "2026-08-10T00:00:00Z"
  gates:
    typecheck:
      pass: true
      tail: ""
    biome:
      pass: true
      tail: ""
  e2e:
    e2e-01:
      pass: true
      passCount: 3
      failCount: 0
    e2e-02:
      pass: true
      passCount: 5
      failCount: 0
audit:
  verdict: pass
  sha: SHA_PLACEHOLDER
evidence:
  human: []
---

- 状态：进行中`,
  });
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dir,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }
  const realSha = getHeadSha(dir);
  let content = fs.readFileSync(path.join(dir, "docs/specs/S1.0.md"), "utf8");
  content = content.replace("SHA_PLACEHOLDER", realSha);
  fs.writeFileSync(path.join(dir, "docs/specs/S1.0.md"), content);

  const output = done(dir, "S1.0");
  assert.ok(output.includes("已完成"));

  // Read ledger and verify structure
  const ledger = fs.readFileSync(path.join(dir, ".spec-flow-ledger.jsonl"), "utf8");
  const doneLine = ledger.split("\n").filter(Boolean).find((l) => JSON.parse(l).type === "done");
  assert.ok(doneLine, "done ledger entry should exist");
  const entry = JSON.parse(doneLine);

  // gates summary
  assert.deepEqual(entry.impl_summary.gates, { typecheck: "pass", biome: "pass" });

  // e2e summary
  assert.deepEqual(entry.impl_summary.e2e["e2e-01"], { pass: "PASS", passCount: 3, failCount: 0 });
  assert.deepEqual(entry.impl_summary.e2e["e2e-02"], { pass: "PASS", passCount: 5, failCount: 0 });

  // audit summary
  assert.equal(entry.audit.verdict, "pass");
  assert.equal(entry.audit.sha, realSha.slice(0, 8));
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

// ─── E2E output parsing ─────────────────────────────────────────────────────
test("e2e parse: all PASS exit0 → pass", () => {
  const output = "PASS x\nPASS y\nPASS z\n";
  const result = parseE2eOutput(output);
  assert.equal(result.pass, true);
  assert.equal(result.passCount, 3);
  assert.equal(result.failCount, 0);
});

test("e2e parse: PASS + FAIL lines → fail", () => {
  const output = "PASS x\nFAIL y\n";
  const result = parseE2eOutput(output);
  assert.equal(result.pass, false);
  assert.equal(result.passCount, 1);
  assert.equal(result.failCount, 1);
});

test("e2e parse: only FAIL → fail", () => {
  const output = "FAIL something\n";
  const result = parseE2eOutput(output);
  assert.equal(result.pass, false);
  assert.equal(result.passCount, 0);
  assert.equal(result.failCount, 1);
});

test("e2e parse: no PASS no FAIL → fail", () => {
  const output = "some random output\n";
  const result = parseE2eOutput(output);
  assert.equal(result.pass, false);
  assert.equal(result.passCount, 0);
  assert.equal(result.failCount, 0);
});

test("e2e parse: PASS must be at line start", () => {
  // "PASS" inside a word should not count
  const output = "COMPASS test\nPASS real\n";
  const result = parseE2eOutput(output);
  assert.equal(result.pass, true);
  assert.equal(result.passCount, 1);
});

test("impl: e2e with FAIL lines in output is detected as failure", () => {
  const dir = mkProject({
    "package.json": JSON.stringify({ scripts: {} }),
    "tests/e2e/e2e-01.mjs": `console.log("PASS x"); console.log("FAIL y"); process.exit(0);`,
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
evidence:
  e2e: [e2e-01]
---

- 状态：进行中`,
  });
  const output = impl(dir, "S1.0");
  // The e2e should be detected as failed because of FAIL line
  assert.ok(output.includes("✗") || output.includes("FAIL"), "e2e with FAIL line should not pass");
});

test("impl: e2e with all PASS lines passes", () => {
  const dir = mkProject({
    "package.json": JSON.stringify({ scripts: {} }),
    "tests/e2e/e2e-01.mjs": `console.log("PASS a"); console.log("PASS b");`,
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
evidence:
  e2e: [e2e-01]
---

- 状态：进行中`,
  });
  const output = impl(dir, "S1.0");
  assert.ok(output.includes("✓") || output.includes("PASS"), "all PASS should succeed");
  assert.ok(output.includes("2 PASS"), "should show count");
});

test("impl: e2e with non-zero exit is failure", () => {
  const dir = mkProject({
    "package.json": JSON.stringify({ scripts: {} }),
    "tests/e2e/e2e-01.mjs": `console.log("PASS x"); process.exit(1);`,
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
evidence:
  e2e: [e2e-01]
---

- 状态：进行中`,
  });
  const output = impl(dir, "S1.0");
  assert.ok(output.includes("✗"), "non-zero exit should fail");
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

// ─── buildAuditorArgs ──────────────────────────────────────────────────────
test("buildAuditorArgs: returns array without model when model is empty", () => {
  const args = buildAuditorArgs("hello");
  assert.deepStrictEqual(args, ["-p", "--no-extensions", "--no-skills", "--no-context-files", "hello"]);
});

test("buildAuditorArgs: includes --model when model is provided", () => {
  const args = buildAuditorArgs("hello", "gpt-4");
  assert.deepStrictEqual(args, ["-p", "--no-extensions", "--no-skills", "--no-context-files", "--model", "gpt-4", "hello"]);
});

test("buildAuditorArgs: preserves backticks, ${}, $(), double quotes in prompt", () => {
  const nasty = 'echo `whoami` && ${HOME} && $(cat /etc/passwd) and "quoted"';
  const args = buildAuditorArgs(nasty);
  // The prompt must be the last element, character-for-character identical
  assert.strictEqual(args[args.length - 1], nasty);
  // No shell interpolation should have occurred
  assert.ok(args[args.length - 1].includes("`whoami`"));
  assert.ok(args[args.length - 1].includes("${HOME}"));
  assert.ok(args[args.length - 1].includes("$(cat /etc/passwd)"));
  assert.ok(args[args.length - 1].includes('"quoted"'));
});

test("buildAuditorArgs: returns a new array each call (no shared mutation)", () => {
  const a = buildAuditorArgs("x");
  const b = buildAuditorArgs("y");
  a.push("MUTATE");
  assert.ok(!b.includes("MUTATE"));
});

// ─── nextStep ──────────────────────────────────────────────────────────────
test("nextStep: impl.at empty → spec_impl", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
---

- 状态：进行中`,
  });
  const specs = loadSpecs(dir);
  const step = nextStep(dir, specs[0]);
  assert.equal(step, "下一步：spec_impl S1.0");
});

test("nextStep: impl pass, no audit → spec_audit", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  at: '2026-08-10T00:00:00Z'
  gates:
    typecheck:
      pass: true
      tail: ''
  e2e:
    e2e-01:
      pass: true
      passCount: 3
      failCount: 0
---

- 状态：进行中`,
  });
  const specs = loadSpecs(dir);
  const step = nextStep(dir, specs[0]);
  assert.equal(step, "下一步：spec_audit S1.0");
});

test("nextStep: impl has gate failure → fix impl", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  at: '2026-08-10T00:00:00Z'
  gates:
    typecheck:
      pass: false
      tail: 'error TS2345'
  e2e: {}
---

- 状态：进行中`,
  });
  const specs = loadSpecs(dir);
  const step = nextStep(dir, specs[0]);
  assert.equal(step, "下一步：修复 impl 问题后重跑 spec_impl S1.0");
});

test("nextStep: audit verdict fail → fix findings", () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  at: '2026-08-10T00:00:00Z'
  gates:
    typecheck:
      pass: true
      tail: ''
  e2e: {}
audit:
  verdict: fail
  sha: abc123
---

- 状态：进行中`,
  });
  const specs = loadSpecs(dir);
  const step = nextStep(dir, specs[0]);
  assert.equal(step, "下一步：修复审计 findings 后重跑 spec_audit S1.0");
});

test("nextStep: audit pass but sha stale → rerun audit", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  at: '2026-08-10T00:00:00Z'
  gates:
    typecheck:
      pass: true
      tail: ''
  e2e: {}
audit:
  verdict: pass
  sha: stale_sha
---

- 状态：进行中`,
  });
  // Init git to get a real HEAD
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dir,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }
  const specs = loadSpecs(dir);
  const step = nextStep(dir, specs[0]);
  assert.equal(step, "下一步：重跑 spec_audit S1.0（sha 失配）");
});

test("nextStep: all green → spec_done", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  at: '2026-08-10T00:00:00Z'
  gates:
    typecheck:
      pass: true
      tail: ''
  e2e:
    e2e-01:
      pass: true
      passCount: 2
      failCount: 0
audit:
  verdict: pass
  sha: PLACEHOLDER
---

- 状态：进行中`,
  });
  // Init git to get a real HEAD
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dir,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }
  const realSha = getHeadSha(dir);
  // Patch the spec to use real sha
  let content = fs.readFileSync(path.join(dir, "docs/specs/S1.0.md"), "utf8");
  content = content.replace("PLACEHOLDER", realSha);
  fs.writeFileSync(path.join(dir, "docs/specs/S1.0.md"), content);

  const specs = loadSpecs(dir);
  const step = nextStep(dir, specs[0]);
  assert.equal(step, "下一步：spec_done S1.0");
});

test("nextStep: uses impl.repo for sha comparison when set", async () => {
  const dirA = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
impl:
  repo: DIR_B_PLACEHOLDER
  at: '2026-08-10T00:00:00Z'
  gates: {}
  e2e: {}
audit:
  verdict: pass
  sha: SHA_B_PLACEHOLDER
---

- 状态：进行中`,
  });
  const dirB = mkProject({});
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dirB,
      stdio: "pipe",
    });
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: dirA,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }
  const shaB = execSync("git rev-parse HEAD", { cwd: dirB, stdio: "pipe" }).toString().trim();

  let content = fs.readFileSync(path.join(dirA, "docs/specs/S1.0.md"), "utf8");
  content = content.replace("DIR_B_PLACEHOLDER", dirB);
  content = content.replace("SHA_B_PLACEHOLDER", shaB);
  fs.writeFileSync(path.join(dirA, "docs/specs/S1.0.md"), content);

  const specs = loadSpecs(dirA);
  const step = nextStep(dirA, specs[0]);
  // sha matches dirB HEAD → all green
  assert.equal(step, "下一步：spec_done S1.0");
});

// ─── parseVerdictJson ─────────────────────────────────────────────────────
test("parseVerdictJson: handles \\s in evidence string", () => {
  // Simulate auditor output where evidence contains regex with lone backslashes
  const raw = `Some preamble text
{
  "verdict": "pass",
  "criteria": [
    {
      "criterion": "正则匹配正确",
      "status": "pass",
      "evidence": "代码使用 /\\s+\\.+/ 正则匹配 whitespace 和 dot"
    }
  ],
  "scope_deviations": []
}`;
  const result = parseVerdictJson(raw);
  assert.equal(result.verdict, "pass");
  assert.equal(result.criteria.length, 1);
  assert.ok(result.criteria[0].evidence.includes("\\s"));
});

test("parseVerdictJson: valid JSON passes through unchanged", () => {
  const raw = `{"verdict":"fail","criteria":[{"criterion":"test","status":"fail","evidence":"no diff"}],"scope_deviations":[]}`;
  const result = parseVerdictJson(raw);
  assert.equal(result.verdict, "fail");
  assert.equal(result.criteria[0].status, "fail");
});

test("parseVerdictJson: totally broken JSON falls back to verdict=fail", () => {
  const raw = `not json at all {{{`;
  const result = parseVerdictJson(raw);
  assert.equal(result.verdict, "fail");
  assert.ok(result.criteria[0].evidence.includes("未找到 JSON 对象"));
});

// ─── commitGateAction ─────────────────────────────────────────────────────
test("commitGateAction: non-commit command → allow", () => {
  const result = commitGateAction("echo hello", { typecheck: { pass: false, tail: "error" } });
  assert.equal(result.action, "allow");
});

test("commitGateAction: all gates green → allow", () => {
  const result = commitGateAction("git commit -m 'fix'", {
    typecheck: { pass: true, tail: "" },
    biome: { pass: true, tail: "" },
  });
  assert.equal(result.action, "allow");
});

test("commitGateAction: red gate → block with gate name in reason", () => {
  const result = commitGateAction("git commit -m 'fix'", {
    typecheck: { pass: true, tail: "" },
    biome: { pass: false, tail: "Unexpected token" },
  });
  assert.equal(result.action, "block");
  assert.ok(result.reason.includes("biome"));
  assert.ok(result.reason.includes("Unexpected token"));
});

test("commitGateAction: SPECFLOW_BYPASS prefix → bypass", () => {
  const result = commitGateAction("SPECFLOW_BYPASS=1 git commit -m 'fix'", {
    typecheck: { pass: false, tail: "error" },
  });
  assert.equal(result.action, "bypass");
});

test("commitGateAction: SPECFLOW_BYPASS in message → NOT bypass, still block", () => {
  const result = commitGateAction('git commit -m "document SPECFLOW_BYPASS=1"', {
    typecheck: { pass: false, tail: "error TS2345" },
  });
  assert.equal(result.action, "block");
  assert.ok(result.reason.includes("typecheck"));
});

console.log("✅ All tests defined");

test("runGates: success captures stdout tail for evidence", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "specflow-gates-tail-"));
  const res = runGates(cwd, [{ name: "echo", cmd: "node -e \"console.log('a');console.log('Tests 218 passed')\"" }]);
  assert.equal(res.echo.pass, true);
  assert.match(res.echo.tail, /Tests 218 passed/);
});
