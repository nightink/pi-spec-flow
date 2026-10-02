// S1.2 trust-boundary regression tests
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  audit,
  begin,
  buildAuditDiff,
  checkCI,
  done,
  impl,
  loadSpecs,
  normalizeAuditResult,
  parseFrontmatter,
  repositorySnapshotHash,
  recordConsistencyGaps,
  runGates,
  specContractHash,
  writeFrontmatter,
} from "./core.mjs";

function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-trust-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function gitInit(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=spec-flow",
      "-c",
      "user.email=spec-flow@example.invalid",
      "commit",
      "-qm",
      "init",
      "--allow-empty",
    ],
    { cwd: root }
  );
}

function approvedSpec({ id = "S1", evidence = {}, extra = {} } = {}) {
  return writeFrontmatter(
    `# ${id}\n\n- 状态：已批准\n\n## 验收标准\n\n- required behavior\n`,
    {
      id,
      status: "approved",
      review: { decision: "approved", note: "proposal evidence" },
      evidence: { human: [], ...evidence },
      ...extra,
    }
  );
}

async function begunProject({ evidence = {}, extraSpecs = {}, files = {} } = {}) {
  const root = project({
    "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
    "docs/specs/S1.md": approvedSpec({ evidence }),
    ...extraSpecs,
    ...files,
  });
  gitInit(root);
  await begin(root, "S1");
  return root;
}

function lineCount(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

test("gate cache: default off executes every time; opt-in binds content", async () => {
  const root = project({
    "target.txt": "bad\n",
    "gate.mjs": `import fs from "node:fs";
fs.appendFileSync(process.env.SPECFLOW_TEST_COUNTER, "run\\n");
process.exit(fs.readFileSync("target.txt", "utf8").trim() === "good" ? 0 : 1);\n`,
  });
  gitInit(root);
  const counter = path.join(os.tmpdir(), `specflow-counter-${process.pid}-${Date.now()}`);
  const oldCounter = process.env.SPECFLOW_TEST_COUNTER;
  process.env.SPECFLOW_TEST_COUNTER = counter;
  const gate = [{ name: "probe", file: process.execPath, args: ["gate.mjs"] }];
  try {
    assert.equal((await runGates(root, gate, { cacheTtlMs: 0 })).probe.pass, false);
    assert.equal((await runGates(root, gate, { cacheTtlMs: 0 })).probe.pass, false);
    assert.equal(lineCount(counter), 2, "default-off must execute twice");

    fs.rmSync(counter, { force: true });
    const diagnostics = [];
    assert.equal(
      (await runGates(root, gate, {
        cacheTtlMs: 60_000,
        onDiagnostic: (message) => diagnostics.push(message),
      })).probe.pass,
      false
    );
    assert.equal((await runGates(root, gate, { cacheTtlMs: 60_000 })).probe.pass, false);
    assert.equal(lineCount(counter), 1, "unchanged opt-in fingerprint may hit cache");

    fs.writeFileSync(path.join(root, "target.txt"), "good\n");
    assert.equal((await runGates(root, gate, { cacheTtlMs: 60_000 })).probe.pass, true);
    assert.equal(lineCount(counter), 2, "content change must invalidate cached failure");
    assert.equal(fs.existsSync(path.join(root, ".spec-flow-cache.json")), false);

    if (typeof process.getuid === "function") {
      const cacheDir = path.join(os.tmpdir(), `specflow-${process.getuid()}`);
      assert.equal(fs.statSync(cacheDir).mode & 0o077, 0);
      for (const name of fs.readdirSync(cacheDir).filter((item) => item.startsWith("gates-"))) {
        assert.equal(fs.statSync(path.join(cacheDir, name)).mode & 0o077, 0);
      }
    }
  } finally {
    if (oldCounter === undefined) delete process.env.SPECFLOW_TEST_COUNTER;
    else process.env.SPECFLOW_TEST_COUNTER = oldCounter;
    fs.rmSync(counter, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gate cache: unavailable/null fingerprint is always a miss with diagnostics", async () => {
  const root = project({
    "gate.mjs": `import fs from "node:fs"; fs.appendFileSync(process.env.SPECFLOW_TEST_COUNTER, "run\\n");\n`,
  });
  const counter = path.join(os.tmpdir(), `specflow-null-counter-${process.pid}-${Date.now()}`);
  const oldCounter = process.env.SPECFLOW_TEST_COUNTER;
  process.env.SPECFLOW_TEST_COUNTER = counter;
  const diagnostics = [];
  const gate = [{ name: "probe", file: process.execPath, args: ["gate.mjs"] }];
  try {
    await runGates(root, gate, { cacheTtlMs: 60_000, onDiagnostic: (m) => diagnostics.push(m) });
    await runGates(root, gate, { cacheTtlMs: 60_000, onDiagnostic: (m) => diagnostics.push(m) });
    assert.equal(lineCount(counter), 2);
    assert.ok(diagnostics.some((message) => message.includes("cache disabled")));
  } finally {
    if (oldCounter === undefined) delete process.env.SPECFLOW_TEST_COUNTER;
    else process.env.SPECFLOW_TEST_COUNTER = oldCounter;
    fs.rmSync(counter, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repository snapshot covers working content but excludes spec lifecycle and ledger", async () => {
  const root = project({
    "docs/specs/S1.md": approvedSpec(),
    "tracked.txt": "one\n",
  });
  gitInit(root);
  const specPath = path.join(root, "docs/specs/S1.md");
  const first = await repositorySnapshotHash(root, { excludePaths: [specPath] });

  execFileSync("git", ["rm", "-q", "tracked.txt"], { cwd: root });
  const stagedDeletion = await repositorySnapshotHash(root, { excludePaths: [specPath] });
  assert.notEqual(stagedDeletion.hash, first.hash, "staged tracked deletion invalidates the baseline");
  execFileSync("git", ["reset", "--hard", "-q", "HEAD"], { cwd: root });

  fs.appendFileSync(specPath, "\nworkflow writeback\n");
  fs.writeFileSync(path.join(root, ".spec-flow-ledger.jsonl"), "{}\n");
  const metadataOnly = await repositorySnapshotHash(root, { excludePaths: [specPath] });
  assert.equal(metadataOnly.hash, first.hash);

  fs.writeFileSync(path.join(root, ".spec-flow-cache.json"), "legacy project cache content\n");
  const legacyCacheFile = await repositorySnapshotHash(root, { excludePaths: [specPath] });
  assert.notEqual(legacyCacheFile.hash, first.hash, "only the ledger/spec are excluded by contract");
  fs.rmSync(path.join(root, ".spec-flow-cache.json"));

  fs.writeFileSync(path.join(root, "tracked.txt"), "two\n");
  const tracked = await repositorySnapshotHash(root, { excludePaths: [specPath] });
  assert.notEqual(tracked.hash, first.hash);

  fs.writeFileSync(path.join(root, "untracked.txt"), "new\n");
  const beforeCommit = await repositorySnapshotHash(root, { excludePaths: [specPath] });
  execFileSync("git", ["add", "tracked.txt", "untracked.txt"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=spec-flow", "-c", "user.email=spec-flow@example.invalid", "commit", "-qm", "same-content"],
    { cwd: root }
  );
  const afterCommit = await repositorySnapshotHash(root, { excludePaths: [specPath] });
  assert.equal(afterCommit.hash, beforeCommit.hash, "commit metadata must not invalidate same content");
});

test("snapshot keeps a staged deletion bound after committing identical content", async () => {
  const root = project({ "removed.txt": "previous content\n", "kept.txt": "still here\n" });
  try {
    gitInit(root);
    const baseline = await repositorySnapshotHash(root);
    execFileSync("git", ["rm", "-q", "removed.txt"], { cwd: root });
    const pending = await repositorySnapshotHash(root);
    assert.notEqual(pending.hash, baseline.hash, "deletion must invalidate the old content");
    execFileSync("git", ["-c", "user.name=spec-flow", "-c", "user.email=spec-flow@example.invalid", "commit", "-qm", "remove"], { cwd: root });
    const committed = await repositorySnapshotHash(root);
    assert.equal(committed.hash, pending.hash, "same deleted content set must survive a commit");
    assert.equal(committed.fileCount, pending.fileCount);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot hashes verified gitlink HEAD and fails closed on an untracked nested repository", async () => {
  const source = project({ "module.txt": "v1\n" });
  gitInit(source);
  const root = project({ "root.txt": "root\n" });
  gitInit(root);
  execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "deps/module"],
    { cwd: root }
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=spec-flow", "-c", "user.email=spec-flow@example.invalid", "commit", "-qm", "submodule"],
    { cwd: root }
  );
  const before = await repositorySnapshotHash(root);
  const checkout = path.join(root, "deps/module");
  fs.writeFileSync(path.join(checkout, "module.txt"), "v2\n");
  execFileSync("git", ["add", "."], { cwd: checkout });
  execFileSync(
    "git",
    ["-c", "user.name=spec-flow", "-c", "user.email=spec-flow@example.invalid", "commit", "-qm", "advance"],
    { cwd: checkout }
  );
  const advanced = await repositorySnapshotHash(root);
  assert.notEqual(advanced.hash, before.hash, "working submodule HEAD participates in snapshot");

  execFileSync("git", ["submodule", "deinit", "-f", "deps/module"], {
    cwd: root,
    stdio: "pipe",
  });
  const uninitialized = await repositorySnapshotHash(root);
  assert.equal(uninitialized.hash, before.hash, "uninitialized submodule uses index gitlink");

  execFileSync("git", ["update-index", "--skip-worktree", "deps/module"], { cwd: root });
  fs.rmSync(path.join(root, "deps/module"), { recursive: true, force: true });
  const sparseMissing = await repositorySnapshotHash(root);
  assert.equal(sparseMissing.hash, before.hash, "missing non-deleted submodule uses index gitlink");
  execFileSync("git", ["update-index", "--no-skip-worktree", "deps/module"], { cwd: root });
  const deleted = await repositorySnapshotHash(root);
  assert.notEqual(deleted.hash, before.hash, "actual submodule deletion invalidates its prior identity");

  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  gitInit(nested);
  await assert.rejects(repositorySnapshotHash(root), /not a gitlink/);
});

test("contract hash ignores lifecycle/review evidence/checkmarks but detects contract edits", () => {
  const original = approvedSpec({
    evidence: { e2e: ["e2e-contract"] },
    extra: { scope: ["src/**"] },
  }) + `\n## Checklist\n\n- [ ] implementation\n\n## Review 与决策\n\nold review evidence\n`;
  const parsed = parseFrontmatter(original);
  const lifecycleChanged = writeFrontmatter(
    original
      .replace("- 状态：已批准", "- 状态：已完成")
      .replace("- [ ] implementation", "- [x] implementation")
      .replace("old review evidence", "new review evidence"),
    {
      ...parsed.data,
      status: "done",
      workflow_version: 2,
      review: { decision: "approved", note: "different evidence" },
      impl: { pass: true },
      audit: { verdict: "pass" },
      attestations: { R1: { note: "changed" } },
    }
  );
  assert.equal(specContractHash(lifecycleChanged), specContractHash(original));
  assert.notEqual(
    specContractHash(original.replace("required behavior", "different required behavior")),
    specContractHash(original)
  );
});

test("audit diff includes tracked and untracked changes and rejects injection/oversize", async () => {
  const root = project({ "tracked.txt": "old\n" });
  gitInit(root);
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(root, "tracked.txt"), "tracked-new\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "untracked-new\n");

  const diff = await buildAuditDiff(root, base, null);
  assert.match(diff, /tracked-new/);
  assert.match(diff, /# untracked: untracked\.txt/);
  assert.match(diff, /untracked-new/);

  const marker = path.join(root, "injection-marker");
  await assert.rejects(
    buildAuditDiff(root, `${base};touch ${marker}`, null),
    /Invalid impl\.base_sha/
  );
  assert.equal(fs.existsSync(marker), false);
  await assert.rejects(buildAuditDiff(root, base, "../outside"), /safe repository-relative/);
  await assert.rejects(buildAuditDiff(root, base, null, { maxBytes: 32 }), /exceeds 32 bytes/);
});

test("audit normalization makes empty, malformed, or contradictory pass results fail closed", () => {
  assert.equal(normalizeAuditResult({ verdict: "pass", criteria: [] }).verdict, "fail");
  assert.equal(
    normalizeAuditResult({
      verdict: "pass",
      criteria: [{ criterion: "c", status: "fail", evidence: "missing" }],
    }).verdict,
    "fail"
  );
  const noEvidence = normalizeAuditResult({
    verdict: "pass",
    criteria: [{ criterion: "c", status: "pass" }],
  });
  assert.equal(noEvidence.verdict, "fail");
  assert.equal(noEvidence.criteria[0].status, "unverifiable");
  assert.equal(
    normalizeAuditResult({
      verdict: "pass",
      criteria: [{ criterion: "c", status: "pass", evidence: "diff evidence" }],
    }).verdict,
    "fail",
    "missing scope_deviations is an invalid audit schema"
  );
  assert.equal(
    normalizeAuditResult({
      verdict: "pass",
      criteria: [{ criterion: "c", status: "pass", evidence: "diff evidence" }],
      scope_deviations: "none",
    }).verdict,
    "fail"
  );
});

test("impl persists explicit failure for missing, traversal, and symlink E2E evidence", async () => {
  const missing = await begunProject({ evidence: { e2e: ["e2e-missing"] } });
  assert.match(await impl(missing, "S1"), /❌ FAIL/);
  let record = loadSpecs(missing)[0].frontmatter;
  assert.equal(record.impl.pass, false);
  assert.match(record.impl.e2e["e2e-missing"].tail, /File not found/);
  await assert.rejects(done(missing, "S1"), /impl\.pass/);

  const marker = path.join(os.tmpdir(), `specflow-e2e-marker-${process.pid}-${Date.now()}`);
  const traversal = await begunProject({
    evidence: { e2e: ["../escape"] },
    files: {
      "tests/escape.mjs": `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("PASS escaped");\n`,
    },
  });
  assert.match(await impl(traversal, "S1"), /Invalid e2e evidence id/);
  assert.equal(fs.existsSync(marker), false);

  const linkedTarget = project({
    "outside.mjs": `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("PASS linked");\n`,
  });
  const symlinked = await begunProject({ evidence: { e2e: ["e2e-linked"] } });
  fs.mkdirSync(path.join(symlinked, "tests/e2e"), { recursive: true });
  fs.symlinkSync(path.join(linkedTarget, "outside.mjs"), path.join(symlinked, "tests/e2e/e2e-linked.mjs"));
  const symlinkOutput = await impl(symlinked, "S1");
  assert.match(symlinkOutput, /regular non-symlink/);
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(marker, { force: true });
});

test("impl persists migration missing/conflict evidence and done cannot bypass it", async () => {
  const missing = await begunProject({ evidence: { migrations: [1] } });
  assert.match(await impl(missing, "S1"), /文件缺失/);
  let record = loadSpecs(missing)[0].frontmatter;
  assert.equal(record.impl.migrations.pass, false);
  assert.equal(record.impl.migrations.problems[0].reason, "missing");
  await assert.rejects(done(missing, "S1"), /impl\.pass/);

  const other = approvedSpec({ id: "S2", evidence: { migrations: [1] } });
  const conflict = await begunProject({
    evidence: { migrations: [1] },
    extraSpecs: { "docs/specs/S2.md": other },
    files: { "packages/db/src/migrations/001-conflict.ts": "export {};\n" },
  });
  assert.match(await impl(conflict, "S1"), /与 S2 冲突/);
  record = loadSpecs(conflict).find((spec) => spec.frontmatter.id === "S1").frontmatter;
  assert.deepEqual(record.impl.migrations.checked, ["001"]);
  assert.equal(record.impl.migrations.problems[0].conflictWith, "S2");
});

test("legacy matrix: migrate active work explicitly, reject legacy transitions, warn for done", async () => {
  const legacyActive = project({
    "docs/specs/S1.md": approvedSpec().replace("status: approved", "status: in-progress")
      .replace("- 状态：已批准", "- 状态：进行中"),
  });
  gitInit(legacyActive);
  await assert.rejects(impl(legacyActive, "S1"), /legacy in-progress/);
  assert.equal((await checkCI(legacyActive)).pass, false);
  await begin(legacyActive, "S1");
  let migrated = loadSpecs(legacyActive)[0].frontmatter;
  assert.equal(migrated.workflow_version, 2);
  assert.equal(migrated.impl.pass, false);
  assert.equal(migrated.audit, undefined);

  const legacyDone = project({
    "docs/specs/S9.md": writeFrontmatter("# old\n\n- 状态：已完成\n", {
      id: "S9",
      status: "done",
      evidence: { e2e: ["e2e-no-longer-present"] },
    }),
  });
  const ci = await checkCI(legacyDone);
  assert.equal(ci.pass, true);
  assert.match(ci.output, /legacy done spec/);
  await assert.rejects(begin(legacyDone, "S9"), /cannot be reopened/);
});

test("workflow v2 rejects duplicate begin and audit before explicit passing impl", async () => {
  const root = project({ "docs/specs/S1.md": approvedSpec() });
  gitInit(root);
  await begin(root, "S1");
  await assert.rejects(begin(root, "S1"), /already uses workflow v2/);
  await assert.rejects(audit(root, "S1"), /impl is not explicitly passing/);
});

test("evidence schema rejects scalar/duplicate declarations instead of treating them as empty", async () => {
  const scalar = project({
    "docs/specs/S1.md": approvedSpec().replace("human: []", "human: R1"),
  });
  gitInit(scalar);
  await assert.rejects(begin(scalar, "S1"), /evidence\.human must be an array/);
  assert.equal((await checkCI(scalar)).pass, false);

  const duplicate = project({
    "docs/specs/S1.md": approvedSpec({ evidence: { e2e: ["e2e-a", "e2e-a"] } }),
  });
  gitInit(duplicate);
  await assert.rejects(begin(duplicate, "S1"), /must not contain duplicates/);

  const forged = {
    file: "S1.md",
    content: writeFrontmatter("# forged\n", {
      id: "S1",
      status: "done",
      workflow_version: 2,
      evidence: { migrations: 1 },
      impl: {},
    }),
    frontmatter: {
      id: "S1",
      status: "done",
      workflow_version: 2,
      evidence: { migrations: 1 },
      impl: {},
    },
  };
  assert.ok(recordConsistencyGaps(forged).some((gap) => gap.includes("evidence schema 非法")));
});

test("check --ci strictly validates an executed v2 in-progress record", async () => {
  const root = await begunProject();
  const file = path.join(root, "docs/specs/S1.md");
  const content = fs.readFileSync(file, "utf8");
  const parsed = parseFrontmatter(content);
  parsed.data.impl.at = new Date().toISOString();
  parsed.data.impl.pass = true;
  fs.writeFileSync(file, writeFrontmatter(content, parsed.data));
  const result = await checkCI(root);
  assert.equal(result.pass, false);
  assert.match(result.output, /impl\.snapshot_hash|impl\.required_gates/);
});

test("E2E parent-directory symlink cannot escape the implementation repository", async () => {
  const root = project({ "docs/specs/S1.md": approvedSpec({ evidence: { e2e: ["e2e-parent"] } }) });
  const outside = project({});
  const marker = path.join(outside, "marker");
  fs.mkdirSync(path.join(outside, "e2e"), { recursive: true });
  fs.writeFileSync(
    path.join(outside, "e2e/e2e-parent.mjs"),
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("PASS outside");\n`
  );
  fs.symlinkSync(outside, path.join(root, "tests"));
  gitInit(root);
  await begin(root, "S1");
  await assert.rejects(impl(root, "S1"), /Evidence directory escapes project/);
  assert.equal(fs.existsSync(marker), false);
});

test("audit cache never bypasses base ancestor validation", async () => {
  const root = await begunProject();
  fs.writeFileSync(path.join(root, "implementation.txt"), "implemented\n");
  assert.match(await impl(root, "S1"), /✅ PASS/);

  const auditorDir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-ancestor-auditor-"));
  const auditor = path.join(auditorDir, "auditor");
  fs.writeFileSync(
    auditor,
    `#!/bin/sh\nprintf '%s\\n' '{"verdict":"pass","criteria":[{"criterion":"c","status":"pass","evidence":"implementation.txt diff"}],"scope_deviations":[]}'\n`,
    { mode: 0o755 }
  );
  const oldBin = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = auditor;
  try {
    assert.match(await audit(root, "S1"), /✅ PASS/);
    execFileSync("git", ["checkout", "--orphan", "rewritten"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=spec-flow",
        "-c",
        "user.email=spec-flow@example.invalid",
        "commit",
        "-qm",
        "rewritten",
      ],
      { cwd: root }
    );
    const rerun = await audit(root, "S1");
    assert.match(rerun, /❌ FAIL/);
    assert.doesNotMatch(rerun, /缓存复用/);
    assert.equal(loadSpecs(root)[0].frontmatter.audit.criteria[0].status, "unverifiable");
  } finally {
    if (oldBin === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = oldBin;
    fs.rmSync(auditorDir, { recursive: true, force: true });
  }
});
