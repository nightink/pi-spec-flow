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
  runGates,
  loadSpecs,
  getSpecDirectories,
  findSpec,
  migrateAlloc,
  begin,
  attest,
  done,
  board,
  checkCI,
  audit,
  shouldBypass,
  commitGateAction,
  isCommitCommand,
  parseCommitTargetRepo,
  resolveCommitRepo,
  commitGateDecision,
  appendCommitLedger,
  parseE2eOutput,
  impl,
  buildAuditorArgs,
  nextStep,
  getHeadSha,
  parseVerdictJson,
  renderBoard,
  renderSpecDetail,
  repositorySnapshotHash,
  specContractHash,
  buildAuditDiff,
  normalizeAuditResult,
  recordConsistencyGaps,
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

function gitInit(dir) {
  execSync(
    "git init -q && git config user.email spec-flow@example.invalid && git config user.name spec-flow && git add . && git commit -qm init --allow-empty",
    { cwd: dir, stdio: "pipe" }
  );
}

function approvedSpec({ id = "S1.0", repo, evidence = {}, body = "## 验收标准\n\n- works" } = {}) {
  return writeFrontmatter(
    `# ${id}\n\n- 状态：已批准\n\n${body}\n`,
    {
      id,
      status: "approved",
      review: { decision: "approved" },
      evidence: { human: [], ...evidence },
      ...(repo ? { impl: { repo } } : {}),
    }
  );
}

function fakeAuditor(verdict = "pass", criteria) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-auditor-"));
  const bin = path.join(dir, "auditor");
  const result = {
    verdict,
    criteria: criteria || [
      {
        criterion: "implementation matches contract",
        status: verdict,
        evidence: "diff --git a/implementation.txt b/implementation.txt",
      },
    ],
    scope_deviations: [],
  };
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(result).replaceAll("'", "'\\''")}'\n`,
    { mode: 0o755 }
  );
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function implementedLifecycle({
  externalRepo = false,
  evidence = {},
  gatesPackage = { scripts: { test: "node -e \"process.exit(0)\"" } },
  implementationFiles = {},
} = {}) {
  const project = mkProject({});
  const repo = externalRepo ? mkProject({}) : project;
  fs.mkdirSync(path.join(project, "docs/specs"), { recursive: true });
  if (gatesPackage) fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify(gatesPackage));
  for (const [relative, content] of Object.entries(implementationFiles)) {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(
    path.join(project, "docs/specs/S1.0.md"),
    approvedSpec({ repo: externalRepo ? repo : undefined, evidence })
  );
  gitInit(repo);
  if (externalRepo) gitInit(project);

  await begin(project, "S1.0");
  fs.writeFileSync(path.join(repo, "implementation.txt"), "implemented\n");
  const implOutput = await impl(project, "S1.0");
  assert.match(implOutput, /PASS/);
  return { project, repo };
}

async function passingLifecycle(options = {}) {
  const lifecycle = await implementedLifecycle(options);
  const auditor = fakeAuditor();
  const oldBin = process.env.SPECFLOW_AUDIT_BIN;
  try {
    process.env.SPECFLOW_AUDIT_BIN = auditor.bin;
    const auditOutput = await audit(lifecycle.project, "S1.0");
    assert.match(auditOutput, /PASS/);
  } finally {
    if (oldBin === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = oldBin;
    auditor.cleanup();
  }
  return lifecycle;
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
  assert.throws(() => migrateAlloc(dir), /No migrations found/);
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

test("attest: accept valid note and bind both hashes", async () => {
  const { project } = await passingLifecycle({ evidence: { human: ["R1"] } });
  const output = attest(
    project,
    "S1.0",
    "R1",
    "Verified settings save and reload with fixture account qa-17"
  );
  assert.ok(output.includes("已登记"));

  const spec = loadSpecs(project)[0].frontmatter;
  assert.equal(spec.attestations.R1.impl_hash, spec.impl.snapshot_hash);
  assert.equal(spec.attestations.R1.contract_hash, spec.audit.contract_hash);
  const ledger = fs.readFileSync(path.join(project, ".spec-flow-ledger.jsonl"), "utf8");
  assert.ok(ledger.includes('"type":"attest"'));
});

// ─── done ────────────────────────────────────────────────────────────────────
test("done: list gaps when incomplete", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
---

- 状态：进行中`,
  });

  await assert.rejects(done(dir, "S1.0"), /缺口/);
});

test("done: accepts hash-bound evidence from impl.repo (external repo)", async () => {
  const { project } = await passingLifecycle({ externalRepo: true });
  const output = await done(project, "S1.0");
  assert.ok(output.includes("已完成"));
});

test("done: reject when tracked or untracked implementation changes after audit", async () => {
  const tracked = await passingLifecycle();
  fs.writeFileSync(path.join(tracked.repo, "implementation.txt"), "changed\n");
  await assert.rejects(done(tracked.project, "S1.0"), /实现快照已变化/);

  const untracked = await passingLifecycle();
  fs.writeFileSync(path.join(untracked.repo, "new-untracked.txt"), "new\n");
  await assert.rejects(done(untracked.project, "S1.0"), /实现快照已变化/);
});

test("check --ci keeps v2 done historical: no live snapshot or current evidence-file recheck", async () => {
  const { project, repo } = await passingLifecycle({
    evidence: { e2e: ["e2e-history"] },
    implementationFiles: {
      "tests/e2e/e2e-history.mjs": 'console.log("PASS historical evidence");\n',
    },
  });
  await done(project, "S1.0");
  fs.rmSync(path.join(repo, "tests/e2e/e2e-history.mjs"));
  fs.writeFileSync(path.join(repo, "new-current-file.txt"), "today\n");
  const result = await checkCI(project);
  assert.equal(result.pass, true, result.output);
});

test("done: ledger includes bound impl and audit summary", async () => {
  const { project } = await passingLifecycle({
    gatesPackage: { scripts: { typecheck: "node -e \"process.exit(0)\"" } },
  });
  const output = await done(project, "S1.0");
  assert.ok(output.includes("已完成"));

  const ledger = fs.readFileSync(path.join(project, ".spec-flow-ledger.jsonl"), "utf8");
  const entry = ledger
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .find((event) => event.type === "done");
  assert.ok(entry);
  assert.deepEqual(entry.impl_summary.gates, { typecheck: "pass" });
  assert.deepEqual(entry.impl_summary.e2e, {});
  assert.equal(entry.impl_summary.migrations.pass, true);
  assert.equal(entry.audit.verdict, "pass");
  assert.equal(entry.audit.prompt_version, 2);
  assert.match(entry.impl_hash, /^[0-9a-f]{64}$/);
  assert.match(entry.contract_hash, /^[0-9a-f]{64}$/);
});

test("done: verdict=pass with a failing criterion is rejected", async () => {
  const { project } = await passingLifecycle();
  const file = path.join(project, "docs/specs/S1.0.md");
  const content = fs.readFileSync(file, "utf8");
  const parsed = parseFrontmatter(content);
  parsed.data.audit.criteria[0].status = "fail";
  fs.writeFileSync(file, writeFrontmatter(content, parsed.data));
  await assert.rejects(done(project, "S1.0"), /criteria 未全绿/);
});

// ─── spec discovery ───────────────────────────────────────────────────────────
test("spec discovery: scans docs/project singular and plural directories without recursion", () => {
  const dir = mkProject({
    "docs/specs/S1.md": approvedSpec({ id: "S1" }),
    "docs/spec/S2.md": approvedSpec({ id: "S2" }),
    "specs/S3.md": approvedSpec({ id: "S3" }),
    "spec/S4.md": approvedSpec({ id: "S4" }),
    "specs/nested/S5.md": approvedSpec({ id: "S5" }),
  });

  assert.deepEqual(
    getSpecDirectories(dir).map((item) => item.relativePath),
    ["docs/specs", "docs/spec", "specs", "spec"]
  );
  assert.deepEqual(
    loadSpecs(dir).map((item) => item.relativePath),
    ["docs/spec/S2.md", "docs/specs/S1.md", "spec/S4.md", "specs/S3.md"]
  );
  assert.equal(findSpec(dir, "S3").relativePath, "specs/S3.md");
  assert.equal(loadSpecs(dir).some((item) => item.frontmatter?.id === "S5"), false);
});

test("spec discovery: ignores a candidate symlink that escapes the project", () => {
  const outside = mkProject({ "S9.md": approvedSpec({ id: "S9" }) });
  const dir = mkProject({});
  fs.symlinkSync(outside, path.join(dir, "specs"), "dir");
  assert.deepEqual(getSpecDirectories(dir), []);
  assert.deepEqual(loadSpecs(dir), []);
});

test("spec discovery: duplicate IDs fail closed instead of selecting one directory", async () => {
  const dir = mkProject({
    "spec/S1.md": approvedSpec({ id: "S1" }),
    "specs/S1-copy.md": approvedSpec({ id: "S1" }),
  });
  assert.throws(() => findSpec(dir, "S1"), /ambiguous/);
  const result = await checkCI(dir);
  assert.equal(result.pass, false);
  assert.match(result.output, /spec id 重复/);
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

  const result = await checkCI(dir);
  assert.equal(result.pass, false);
  assert.ok(result.output.includes("e2e-99.mjs"));
});

// ─── S1.1: commit gate targets the ACTUAL repo, not session cwd ─────────────
test("isCommitCommand: git -C and subshell forms match (S1.1)", () => {
  assert.equal(isCommitCommand("git commit -m 'x'"), true);
  assert.equal(isCommitCommand("git -C /tmp/x commit"), true);
  assert.equal(isCommitCommand("cd /tmp/x && git commit"), true);
  assert.equal(isCommitCommand("(cd /tmp/x && git commit)"), true);
  assert.equal(isCommitCommand("SPECFLOW_BYPASS=1 git commit"), true);
  // non-commit must not match
  assert.equal(isCommitCommand("echo git commit"), false);
  assert.equal(isCommitCommand("git log commit"), false);
  assert.equal(isCommitCommand('git commit -m "document git commit"'), true);
});

test("parseCommitTargetRepo: cd / -C chains resolve to target dir (S1.1)", () => {
  const cwd = "/sess";
  assert.equal(parseCommitTargetRepo("cd /tmp/no-pkg && git commit -m x", cwd), "/tmp/no-pkg");
  assert.equal(parseCommitTargetRepo("git -C /tmp/no-pkg commit", cwd), "/tmp/no-pkg");
  assert.equal(parseCommitTargetRepo("cd a && cd b && git commit", cwd), "/sess/a/b");
  assert.equal(parseCommitTargetRepo("cd a && git -C ../x commit", cwd), "/sess/x");
  assert.equal(parseCommitTargetRepo("(cd /x && git commit)", cwd), "/x");
  assert.equal(parseCommitTargetRepo("SPECFLOW_BYPASS=1 cd /x && git commit", cwd), "/x");
  assert.equal(parseCommitTargetRepo("cd ../pages && git commit", "/sess"), "/pages");
  // no cd/-C → null (session cwd applies); cd AFTER commit is ignored
  assert.equal(parseCommitTargetRepo("git commit -m 'cd /fake'", cwd), null);
  assert.equal(parseCommitTargetRepo("git commit && cd /x", cwd), null);
  // echo cd is not a real cd
  assert.equal(parseCommitTargetRepo("echo cd /x && git commit", cwd), null);
  // S1.1 audit findings: quoted dirs, ~ expansion, -C in other segment
  assert.equal(parseCommitTargetRepo('git -C "/tmp/my dir" commit', cwd), "/tmp/my dir");
  assert.equal(parseCommitTargetRepo('cd "/tmp/my dir" && git commit', cwd), "/tmp/my dir");
  assert.equal(parseCommitTargetRepo("cd ~/pages && git commit", cwd), path.join(os.homedir(), "pages"));
  assert.equal(parseCommitTargetRepo("git -C /a status && git commit", cwd), null);
});

test("resolveCommitRepo: confirms via git rev-parse --show-toplevel (S1.1)", async () => {
  const session = mkProject({ "package.json": "{}" });
  const target = mkProject({}); // no package.json → no gates
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: target,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }

  const r1 = await resolveCommitRepo(session, `cd ${target} && git commit -m x`);
  assert.equal(r1.confidence, "resolved");
  assert.equal(r1.repo, fs.realpathSync(target));

  // plain commit → session repo
  const r2 = await resolveCommitRepo(session, "git commit -m x");
  assert.equal(r2.confidence, "session");
  assert.equal(r2.repo, session);
});

test("commitGateDecision: external repo without gates → allow (S1.1)", async () => {
  // Session project has a REAL failing gate; target repo has none.
  // The commit must be allowed — session gates must not spill over (S1.1 case).
  const session = mkProject({
    "package.json": JSON.stringify({
      scripts: { typecheck: "node -e \"process.exit(1)\"" },
    }),
  });
  const target = mkProject({}); // no package.json → no gates
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: target,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }

  const decision = await commitGateDecision(
    session,
    `cd ${target} && git commit -m x`
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.external, true);
  assert.equal(decision.repo, fs.realpathSync(target));
});

test("commitGateDecision: block reason includes the repo path (S1.1 audit)", async () => {
  const session = mkProject({ "package.json": "{}" });
  const target = mkProject({
    "package.json": JSON.stringify({
      scripts: { typecheck: "node -e \"process.exit(1)\"" },
    }),
  });
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: target,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }

  const decision = await commitGateDecision(session, `cd ${target} && git commit -m x`);
  assert.equal(decision.action, "block");
  assert.ok(decision.reason.includes("仓库: "));
  assert.ok(decision.reason.includes(target), "reason names the failing repo");
  assert.ok(decision.reason.includes("typecheck"));
});

test("commitGateDecision: unresolved target falls back to session gating (S1.1 audit)", async () => {
  // cd to a non-git dir (rev-parse fails) → conservative fallback: session gating,
  // targetRepo marked unknown.
  const session = mkProject({
    "package.json": JSON.stringify({
      scripts: { typecheck: "node -e \"process.exit(1)\"" },
    }),
  });
  const noGit = mkProject({});

  const decision = await commitGateDecision(session, `cd ${noGit} && git commit -m x`);
  assert.equal(decision.action, "block"); // session gates apply (conservative)
  assert.equal(decision.confidence, "unresolved");
  assert.equal(decision.targetRepo, "unknown");
  assert.equal(decision.repo, session);
});

test("appendCommitLedger: writes to target repo with targetRepo field (S1.1 audit)", async () => {
  const session = mkProject({});
  const target = mkProject({});
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: target,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }
  const decision = { repo: target, targetRepo: target, action: "allow" };
  const landed = appendCommitLedger(decision, { type: "allow-external" }, session);
  assert.equal(landed.fallback, false);
  const ledger = fs.readFileSync(path.join(target, ".spec-flow-ledger.jsonl"), "utf8");
  const entry = JSON.parse(ledger.trim().split("\n").at(-1));
  assert.equal(entry.type, "allow-external");
  assert.equal(entry.targetRepo, target);
  assert.equal(entry.sessionCwd, session);
  assert.ok(!fs.existsSync(path.join(session, ".spec-flow-ledger.jsonl")));
});

test("appendCommitLedger: unresolved target → session fallback with ledgerFallback (S1.1 audit)", () => {
  const session = mkProject({});
  const decision = { repo: session, targetRepo: "unknown", action: "block" };
  const landed = appendCommitLedger(decision, { type: "bypass" }, session);
  assert.equal(landed.fallback, true);
  const ledger = fs.readFileSync(path.join(session, ".spec-flow-ledger.jsonl"), "utf8");
  const entry = JSON.parse(ledger.trim().split("\n").at(-1));
  assert.equal(entry.targetRepo, "unknown");
  assert.equal(entry.ledgerFallback, true);
});

test("commitGateDecision: external repo WITH gates runs ITS gates (S1.1)", async () => {
  const session = mkProject({ "package.json": "{}" });
  const target = mkProject({
    "package.json": JSON.stringify({
      scripts: { typecheck: "echo target-typecheck-ok" },
    }),
  });
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: target,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }

  const decision = await commitGateDecision(session, `git -C ${target} commit -m x`);
  // gate ran against target repo (its typecheck passes) → allow
  assert.equal(decision.action, "allow");
  assert.equal(decision.repo, fs.realpathSync(target));
  assert.equal(decision.gateResults.typecheck.pass, true);
});

test("commitGateDecision: external repo gates red → block with repo context (S1.1)", async () => {
  const session = mkProject({ "package.json": "{}" });
  const target = mkProject({
    "package.json": JSON.stringify({
      scripts: { typecheck: "node -e \"process.exit(1)\"" },
    }),
  });
  try {
    execSync("git init && git add . && git commit -m init --allow-empty", {
      cwd: target,
      stdio: "pipe",
    });
  } catch {
    return; // skip if git unavailable
  }

  const decision = await commitGateDecision(session, `cd ${target} && git commit -m x`);
  assert.equal(decision.action, "block");
  assert.equal(decision.repo, fs.realpathSync(target));
  assert.ok(decision.reason.includes("typecheck"));
});

// ─── shouldBypass ────────────────────────────────────────────────────────────
test("bypass: -C form recognized (S1.1)", () => {
  assert.equal(shouldBypass("SPECFLOW_BYPASS=1 git -C /tmp/x commit"), true);
  assert.equal(shouldBypass("SPECFLOW_BYPASS=1 cd /tmp/x && git commit"), true);
  assert.equal(shouldBypass("(SPECFLOW_BYPASS=1 git commit)"), true);
  assert.equal(shouldBypass("SPECFLOW_BYPASS=1 git log commit"), false);
  assert.equal(shouldBypass("SPECFLOW_BYPASS=1 git commit -m 'x'"), true);
});

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

async function implE2eFixture(source, evidence = ["e2e-01"]) {
  const dir = mkProject({
    "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
    "tests/e2e/e2e-01.mjs": source,
    "docs/specs/S1.0.md": approvedSpec({ evidence: { e2e: evidence } }),
  });
  gitInit(dir);
  await begin(dir, "S1.0");
  return { dir, output: await impl(dir, "S1.0") };
}

test("impl: e2e with FAIL lines in output is detected as failure", async () => {
  const { output } = await implE2eFixture(
    `console.log("PASS x"); console.error("FAIL y"); process.exit(0);`
  );
  assert.match(output, /❌ FAIL/);
  assert.match(output, /e2e-01: ✗/);
});

test("impl: e2e with all PASS lines passes", async () => {
  const { output } = await implE2eFixture(
    `console.log("PASS a"); console.log("PASS b");`
  );
  assert.match(output, /✅ PASS/);
  assert.match(output, /2 PASS/);
});

test("impl: e2e with non-zero exit is failure", async () => {
  const { output } = await implE2eFixture(
    `console.log("PASS x"); process.exit(1);`
  );
  assert.match(output, /❌ FAIL/);
});

test("impl: missing and path-traversal e2e evidence fail closed", async () => {
  const missing = await implE2eFixture(`console.log("PASS unused")`, ["e2e-missing"]);
  assert.match(missing.output, /File not found/);

  const traversal = await implE2eFixture(`console.log("PASS unused")`, ["../escape"]);
  assert.match(traversal.output, /Invalid e2e evidence id/);
});

test("audit: pass result caches only on unchanged implementation and contract hashes", async () => {
  const { project } = await passingLifecycle();
  const savedBin = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = "/definitely/not/an/auditor";
  try {
    const second = await audit(project, "S1.0");
    assert.match(second, /缓存复用/);
    assert.match(second, /✅ PASS/);
  } finally {
    if (savedBin === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = savedBin;
  }

  const file = path.join(project, "docs/specs/S1.0.md");
  fs.appendFileSync(file, "\nChanged acceptance contract.\n");
  await assert.rejects(audit(project, "S1.0"), /contract changed/);
});

test("audit: fail verdict is not cached and re-runs auditor", async () => {
  const { project } = await implementedLifecycle();
  const counter = path.join(os.tmpdir(), `specflow-audit-count-${process.pid}-${Date.now()}`);
  const auditor = fakeAuditor("fail", [
    { criterion: "c1", status: "fail", evidence: "missing implementation" },
  ]);
  const original = fs.readFileSync(auditor.bin, "utf8");
  fs.writeFileSync(auditor.bin, original.replace("printf", `echo x >> '${counter}'\nprintf`), { mode: 0o755 });
  const savedBin = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = auditor.bin;
  try {
    assert.match(await audit(project, "S1.0"), /❌ FAIL/);
    const second = await audit(project, "S1.0");
    assert.match(second, /❌ FAIL/);
    assert.doesNotMatch(second, /缓存复用/);
    assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 2);
  } finally {
    if (savedBin === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = savedBin;
    auditor.cleanup();
    fs.rmSync(counter, { force: true });
  }
});

// ─── Audit criteria naming ──────────────────────────────────────────────────
test("audit: subprocess failure persists fail/unverifiable criteria", async () => {
  const { project } = await implementedLifecycle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-audit-fail-"));
  const bin = path.join(dir, "auditor");
  fs.writeFileSync(bin, "#!/bin/sh\necho fake auditor failure >&2\nexit 1\n", { mode: 0o755 });
  const savedBin = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = bin;
  try {
    const output = await audit(project, "S1.0");
    assert.match(output, /criteria:/);
    assert.doesNotMatch(output, /findings:/);
    const stored = loadSpecs(project)[0].frontmatter.audit;
    assert.equal(stored.verdict, "fail");
    assert.equal(stored.criteria[0].status, "unverifiable");
  } finally {
    if (savedBin === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = savedBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── buildAuditorArgs ──────────────────────────────────────────────────────
test("buildAuditorArgs: returns @file arg, file contains prompt, cleanup works", () => {
  const { args, cleanup } = buildAuditorArgs("hello");
  assert.deepStrictEqual(args.slice(0, 7), [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ]);
  assert.deepEqual(args.slice(7, 9), ["--thinking", "off"]);
  assert.ok(args[args.length - 1].startsWith("@"));
  const file = args[args.length - 1].slice(1);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, "utf8"), "hello");
  cleanup();
  assert.ok(!fs.existsSync(file));
});

test("buildAuditorArgs: includes --model when model is provided", () => {
  const { args, cleanup } = buildAuditorArgs("hello", "gpt-4");
  assert.deepStrictEqual(args.slice(0, 9), [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--model",
    "gpt-4",
  ]);
  assert.deepEqual(args.slice(9, 11), ["--thinking", "off"]);
  assert.ok(args[args.length - 1].startsWith("@"));
  cleanup();
});

test("buildAuditorArgs: preserves backticks, ${}, $(), double quotes in prompt file", () => {
  const nasty = 'echo `whoami` && ${HOME} && $(cat /etc/passwd) and "quoted"';
  const { args, cleanup } = buildAuditorArgs(nasty);
  const file = args[args.length - 1].slice(1);
  const content = fs.readFileSync(file, "utf8");
  assert.strictEqual(content, nasty);
  assert.ok(content.includes("`whoami`"));
  assert.ok(content.includes("${HOME}"));
  assert.ok(content.includes("$(cat /etc/passwd)"));
  assert.ok(content.includes('"quoted"'));
  cleanup();
});

test("buildAuditorArgs: returns a new array each call (no shared mutation)", () => {
  const { args: a, cleanup: ca } = buildAuditorArgs("x");
  const { args: b, cleanup: cb } = buildAuditorArgs("y");
  a.push("MUTATE");
  assert.ok(!b.includes("MUTATE"));
  ca(); cb();
});

test("buildAuditorArgs: long prompt over argv limit goes to file", () => {
  const { args, cleanup } = buildAuditorArgs("x".repeat(300000));
  const file = args[args.length - 1].slice(1);
  assert.equal(fs.readFileSync(file, "utf8").length, 300000);
  cleanup();
});

// ─── nextStep ──────────────────────────────────────────────────────────────
test("nextStep: impl.at empty → spec_impl", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
workflow_version: 2
review:
  decision: approved
---

- 状态：进行中`,
  });
  const specs = loadSpecs(dir);
  const step = await nextStep(dir, specs[0]);
  assert.equal(step, "下一步：spec_impl S1.0");
});

test("nextStep: missing proposal approval is surfaced before implementation", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
workflow_version: 2
---

- 状态：进行中`,
  });
  const step = await nextStep(dir, loadSpecs(dir)[0]);
  assert.match(step, /恢复 proposal approval/);
});

test("nextStep: impl pass, no audit → spec_audit", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
workflow_version: 2
review:
  decision: approved
impl:
  at: '2026-08-10T00:00:00Z'
  pass: true
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
  const step = await nextStep(dir, specs[0]);
  assert.equal(step, "下一步：spec_audit S1.0");
});

test("nextStep: impl has gate failure → fix impl", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
workflow_version: 2
review:
  decision: approved
impl:
  at: '2026-08-10T00:00:00Z'
  pass: false
  gates:
    typecheck:
      pass: false
      tail: 'error TS2345'
  e2e: {}
---

- 状态：进行中`,
  });
  const specs = loadSpecs(dir);
  const step = await nextStep(dir, specs[0]);
  assert.equal(step, "下一步：修复 impl 问题后重跑 spec_impl S1.0");
});

test("nextStep: audit verdict fail → fix findings", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
workflow_version: 2
review:
  decision: approved
impl:
  at: '2026-08-10T00:00:00Z'
  pass: true
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
  const step = await nextStep(dir, specs[0]);
  assert.equal(step, "下一步：修复审计 findings 后重跑 spec_audit S1.0");
});

test("nextStep: stale audit binding → rerun audit", async () => {
  const { project } = await passingLifecycle();
  const file = path.join(project, "docs/specs/S1.0.md");
  const content = fs.readFileSync(file, "utf8");
  const parsed = parseFrontmatter(content);
  parsed.data.audit.impl_hash = "0".repeat(64);
  fs.writeFileSync(file, writeFrontmatter(content, parsed.data));
  const step = await nextStep(project, loadSpecs(project)[0]);
  assert.equal(step, "下一步：重跑 spec_audit S1.0（证据绑定已过期）");
});

test("nextStep: all bound evidence green → spec_done", async () => {
  const { project } = await passingLifecycle();
  const step = await nextStep(project, loadSpecs(project)[0]);
  assert.equal(step, "下一步：spec_done S1.0");
});

test("nextStep: board stays record-only; done owns live snapshot validation", async () => {
  const { project, repo } = await passingLifecycle({ externalRepo: true });
  assert.equal(await nextStep(project, loadSpecs(project)[0]), "下一步：spec_done S1.0");
  fs.writeFileSync(path.join(repo, "external-change.txt"), "changed\n");
  assert.equal(
    await nextStep(project, loadSpecs(project)[0]),
    "下一步：spec_done S1.0"
  );
  await assert.rejects(done(project, "S1.0"), /实现快照已变化/);
});

// ─── renderBoard / renderSpecDetail (for /spec command) ───────────────────
test("renderBoard: empty project → empty string", async () => {
  const dir = mkProject({});
  assert.equal(await renderBoard(dir), "");
});

test("renderBoard: shows status, impl/audit/attest, and accurate next step", async () => {
  const { project } = await passingLifecycle({
    externalRepo: true,
    evidence: { human: ["R1", "R2"] },
  });
  attest(project, "S1.0", "R1", "Verified settings save and reload with fixture account qa-17");
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { typecheck: "node -e \"\"" } })
  );
  fs.writeFileSync(path.join(project, "docs/specs/S2.0.md"), "# No frontmatter\n\nBody\n");

  const output = await renderBoard(project);
  assert.ok(output.includes("spec-flow board — 2 个 spec"));
  assert.ok(output.includes("门禁: typecheck"));
  assert.ok(output.includes("• S1.0 [S1.0.md] 进行中"));
  assert.ok(output.includes("impl ✓"));
  assert.ok(output.includes("audit ✓"));
  assert.ok(output.includes("attest 1/2"));
  assert.ok(output.includes("人工核验 R2"));
  assert.ok(output.includes("S2.0.md ⚠️ 未纳管"));
});

test("renderBoard: drift detected on mismatched status line", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
---

- 状态：已完成`,
  });
  const output = await renderBoard(dir);
  assert.ok(output.includes("⚠️漂移"));
});

test("renderSpecDetail: not found → null", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: pending
---

- 状态：待 review`,
  });
  assert.equal(await renderSpecDetail(dir, "NOPE"), null);
});

test("renderSpecDetail: unmanaged → warning line", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `# No frontmatter`,
  });
  assert.ok((await renderSpecDetail(dir, "S1.0")).includes("未纳管"));
});

test("renderSpecDetail: shows review/deps/impl/audit/attest lines", async () => {
  const dir = mkProject({
    "docs/specs/S1.0.md": `---
id: S1.0
status: in-progress
review:
  decision: approved
deps: [S0.9]
impl:
  base_sha: deadbeefcafe
  at: "2026-08-10T12:00:00Z"
  gates:
    typecheck:
      pass: true
      tail: ""
  e2e:
    e2e-01:
      pass: true
      passCount: 2
      failCount: 0
audit:
  verdict: pass
  sha: abc12345
evidence:
  human: [R1]
  e2e: [e2e-01]
  migrations: [001]
attestations:
  R1:
    at: "2026-08-10T13:00:00Z"
    note: "verified"
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
  // Patch the audit sha to the real HEAD so nextStep says spec_done
  let specContent = fs.readFileSync(path.join(dir, "docs/specs/S1.0.md"), "utf8");
  specContent = specContent.replace("abc12345", execSync("git rev-parse HEAD", { cwd: dir, stdio: "pipe" }).toString().trim());
  fs.writeFileSync(path.join(dir, "docs/specs/S1.0.md"), specContent);

  const output = await renderSpecDetail(dir, "S1.0");
  assert.ok(output.includes("[S1.0.md] 进行中"));
  assert.ok(output.includes("review: approved"));
  assert.ok(output.includes("deps: S0.9"));
  assert.ok(output.includes("base_sha: deadbeefcafe"));
  assert.ok(output.includes("gates: typecheck✓"));
  assert.ok(output.includes("e2e: e2e-01✓"));
  assert.ok(output.includes("audit: pass @"), "audit line shows verdict+sha");
  assert.ok(output.includes("attest: R1 ✓"));
  assert.ok(output.includes("evidence.migrations: 001"));
  assert.ok(output.includes("下一步：spec_begin S1.0（迁移到 workflow v2）"));
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

test("runGates: success captures stdout tail for evidence", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-gates-tail-"));
  const res = await runGates(cwd, [{ name: "echo", cmd: "node -e \"console.log('a');console.log('Tests 218 passed')\"" }]);
  assert.equal(res.echo.pass, true);
  assert.match(res.echo.tail, /Tests 218 passed/);
});
