// Parent verification of S2.2 acceptance (A1–A8, A12) on SYNTHETIC fixtures.
// No provider request, no real review grant, no production state. The fake
// "auditor" is a local Node script that emits a mechanical result, so this
// script proves wiring/exit codes/limits, never model judgment quality.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const core = path.join(root, "packages/core/src/core.mjs");
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s22-parent-")));
const bin = path.join(sandbox, "path-without-pi");
fs.mkdirSync(bin);
// Deliberately no `pi` on PATH: only the runtime the lifecycle itself needs.
fs.symlinkSync(process.execPath, path.join(bin, "node"));
fs.symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(bin, "git"));
const env = { ...process.env, PATH: bin, SPECFLOW_REVIEW_BUDGET_ID: "" };
delete env.SPECFLOW_AUDIT_MAX_BYTES;
delete env.SPECFLOW_AUDIT_BIN;
delete env.SPECFLOW_REVIEW_CLI;
delete env.SPECFLOW_PI_CLI;
const results = [];
const record = (id, detail) => results.push({ id, ...detail });

function cli(cwd, args, extra = {}) {
  return spawnSync(process.execPath, [core, ...args], {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 120000,
  });
}
function ok(cwd, args, extra = {}) {
  const out = cli(cwd, args, extra);
  assert.equal(out.status, 0, `expected 0 for ${args.join(" ")}: ${out.stderr}${out.stdout}`);
  return out.stdout;
}
function notOk(cwd, args, extra = {}) {
  const out = cli(cwd, args, extra);
  assert.notEqual(out.status, 0, `expected non-zero for ${args.join(" ")}`);
  return out;
}
function git(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture(name, { acceptance = "- [ ] [A1] behaves\n", gates = 0 } = {}) {
  const cwd = path.join(sandbox, name);
  fs.mkdirSync(path.join(cwd, "docs/specs"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "docs/specs/S1.md"),
    `---\nid: S1\ntitle: 'Acceptance fixture'\nkind: spec\nauthor: agent\nstatus: approved\ncreated: '2026-10-22'\nreview:\n  decision: approved\nevidence:\n  e2e: []\n  migrations: []\n  human: []\n---\n\n- 状态：已批准\n\n# Acceptance fixture\n\n## Acceptance\n\n${acceptance}`,
  );
  fs.writeFileSync(
    path.join(cwd, ".spec-flow.json"),
    JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [{ name: "offline", argv: ["node", "-e", `process.exit(${gates})`] }],
      },
    }),
  );
  fs.writeFileSync(path.join(cwd, "code.txt"), "baseline\n");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "parent-probe"]);
  git(cwd, ["config", "user.email", "parent-probe@example.invalid"]);
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=parent-probe", "commit", "-qm", "base"]);
  return {
    cwd,
    base: git(cwd, ["rev-parse", "HEAD"]),
    write: (text) => fs.writeFileSync(path.join(cwd, "code.txt"), text),
    commit: () => {
      git(cwd, ["add", "."]);
      git(cwd, ["-c", "user.name=parent-probe", "commit", "-qm", "impl"]);
      return git(cwd, ["rev-parse", "HEAD"]);
    },
  };
}
function reviewJson(cwd, input, extra) {
  return JSON.parse(ok(cwd, ["review", "--json", JSON.stringify(input)], extra));
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const ledger = (cwd) => {
  const file = path.join(cwd, ".spec-flow-ledger.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
};

try {
  // ── A5: over-limit diagnostics reconcile and never truncate evidence ──────
  {
    const f = fixture("a5-limit");
    const fake = path.join(sandbox, "fake-auditor.mjs");
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst packet = fs.readFileSync(process.argv.at(-1).slice(1), 'utf8');\nconsole.log(JSON.stringify({ verdict: 'pass', criteria: [{ id: 'C1', kind: 'product', criterion: 'synthetic', status: 'pass', evidence: 'synthetic fixture only' }], scope_deviations: [] }));\n`,
      { mode: 0o700 },
    );
    f.write("implementation for the over-limit probe\n");
    f.commit();
    const prepared = reviewJson(f.cwd, { id: "S1", base: f.base, head: git(f.cwd, ["rev-parse", "HEAD"]), maxBytes: 20000 });
    record("A5-seal-under-limit", { packetBytes: prepared.receipt.packet_bytes, source: prepared.receipt.review_limit.source });
    const overflow = notOk(f.cwd, [
      "review",
      "--json",
      JSON.stringify({ id: "S1", base: f.base, head: git(f.cwd, ["rev-parse", "HEAD"]), maxBytes: 1024 }),
    ]);
    assert.match(overflow.stderr, /REVIEW_PACKET_LIMIT/);
    const diagnostic = JSON.parse(overflow.stderr.slice(overflow.stderr.indexOf("Diagnostic: ") + 12));
    const sum = diagnostic.breakdown.reduce((total, item) => total + item.bytes, 0);
    assert.equal(sum, diagnostic.actualBytes, "breakdown must reconcile to actualBytes");
    assert.equal(diagnostic.limitBytes, 1024);
    assert.equal(diagnostic.source, "argument");
    assert.equal(diagnostic.sizeKnown, true);
    assert.ok(diagnostic.actualBytes > 1024);
    assert.ok(diagnostic.breakdown.some((item) => item.section === "prompt-wrapper"));
    assert.ok(diagnostic.nextActions.some((action) => action.tool === "spec_review"));
    record("A5-complete-packet-diagnostic", {
      actualBytes: diagnostic.actualBytes,
      limitBytes: diagnostic.limitBytes,
      sections: diagnostic.breakdown.length,
      reconciles: true,
    });
    // Explicit `maxBytes` on a non-prepare action is rejected before any spend.
    const jobsBefore = fs.readdirSync(path.join(f.cwd, ".git/spec-flow/review-v1/jobs")).length;
    for (const action of [
      { action: "status", jobId: prepared.jobId, maxBytes: 1024 },
      { action: "run", jobId: prepared.jobId, maxBytes: 1024 },
      { action: "repair", jobId: prepared.jobId, maxBytes: 1024 },
    ]) {
      const out = notOk(f.cwd, ["review", "--json", JSON.stringify(action)]);
      assert.match(out.stderr, /Unknown\/invalid review/);
    }
    assert.equal(
      fs.readdirSync(path.join(f.cwd, ".git/spec-flow/review-v1/jobs")).length,
      jobsBefore,
      "rejected maxBytes must not create a job",
    );
    record("A3-sealed-action-params-rejected", { actions: ["status", "run", "repair"], jobsUnchanged: true });

    // A2/A4: a >512 KiB packet runs end-to-end through a real detached worker
    // only when the sealed/argument limit allows it; default still rejects.
    const big = fixture("a2-big");
    big.write(`// ${"x".repeat(560 * 1024)}\n`);
    const head = big.commit();
    const defaultRejected = notOk(big.cwd, ["review", "--json", JSON.stringify({ id: "S1", base: big.base, head })]);
    assert.match(defaultRejected.stderr, /REVIEW_PACKET_LIMIT/);
    const budget = ok(big.cwd, [
      "review-budget",
      "--json",
      JSON.stringify({ id: "synthetic", calls: 1, note: "Disposable parent probe fake grant; not a real review authorization." }),
    ]);
    assert.match(budget, /synthetic/);
    const large = reviewJson(big.cwd, { id: "S1", base: big.base, head, maxBytes: 4194304 });
    assert.ok(large.receipt.packet_bytes > 524288, `packet ${large.receipt.packet_bytes}`);
    const run = reviewJson(
      big.cwd,
      { action: "run", jobId: large.jobId, budgetId: "synthetic" },
      { SPECFLOW_AUDIT_BIN: fake },
    );
    assert.equal(run.state, "completed", JSON.stringify(run.outputInfo));
    assert.equal(run.receipt.child_input_sha256, run.receipt.packet_sha256);
    assert.equal(run.modelInvoked, true);
    // A3: the sealed limit survives a lowered/invalid environment for free.
    const replay = reviewJson(
      big.cwd,
      { action: "status", jobId: large.jobId },
      { SPECFLOW_AUDIT_MAX_BYTES: "1" },
    );
    assert.equal(replay.receipt.review_limit.maxBytes, 4194304);
    const replayRun = reviewJson(
      big.cwd,
      { action: "run", jobId: large.jobId, budgetId: "synthetic" },
      { SPECFLOW_AUDIT_MAX_BYTES: "not-a-number" },
    );
    assert.equal(replayRun.executionInfo.action, "reuse-result");
    record("A2-A4-large-packet-detached-worker", {
      packetBytes: large.receipt.packet_bytes,
      mode: run.mode,
      childMatchesPacket: true,
      sealedLimitAfterEnvChange: replay.receipt.review_limit.maxBytes,
    });

    // A4: exact UTF-8 boundary — the sealed limit equals the actual bytes.
    // The sealed limit is part of the packet, so measure with a limit that has
    // the same decimal width as the result; otherwise "equal" shifts by the
    // digit-count difference (a real property, not a rounding fudge).
    const exact = fixture("a4-exact");
    exact.write("implementation for the boundary probe\n");
    exact.commit();
    const target = git(exact.cwd, ["rev-parse", "HEAD"]);
    const measureLimit = 10000;
    const probe = notOk(exact.cwd, ["review", "--json", JSON.stringify({ id: "S1", base: exact.base, head: target, maxBytes: measureLimit })]);
    const measured = JSON.parse(probe.stderr.slice(probe.stderr.indexOf("Diagnostic: ") + 12)).actualBytes;
    assert.equal(String(measured).length, String(measureLimit).length);
    assert.ok(measured > measureLimit);
    const atLimit = reviewJson(exact.cwd, { id: "S1", base: exact.base, head: target, maxBytes: measured });
    assert.equal(atLimit.receipt.packet_bytes, measured);
    const oneLess = notOk(exact.cwd, ["review", "--json", JSON.stringify({ id: "S1", base: exact.base, head: target, maxBytes: measured - 1 })]);
    assert.match(oneLess.stderr, /REVIEW_PACKET_LIMIT/);
    const nonAscii = fixture("a4-utf8", { acceptance: "- [ ] [A1] 中文验收：刷新后仍显示“最新”值\n" });
    nonAscii.write("中文实现变更\n");
    nonAscii.commit();
    const utf8Head = git(nonAscii.cwd, ["rev-parse", "HEAD"]);
    const utf8Probe = notOk(nonAscii.cwd, ["review", "--json", JSON.stringify({ id: "S1", base: nonAscii.base, head: utf8Head, maxBytes: measureLimit })]);
    const utf8Measured = JSON.parse(utf8Probe.stderr.slice(utf8Probe.stderr.indexOf("Diagnostic: ") + 12)).actualBytes;
    const utf8AtLimit = reviewJson(nonAscii.cwd, { id: "S1", base: nonAscii.base, head: utf8Head, maxBytes: utf8Measured });
    assert.equal(Buffer.byteLength(fs.readFileSync(utf8AtLimit.packetPath), "utf8"), utf8Measured);
    record("A4-exact-utf8-boundary", { actualBytes: measured, equalPassed: true, oneLessRejected: true, utf8ActualBytes: utf8Measured, utf8BytesReconciled: true });
  }

  // ── A6/A7/A8/A12: lifecycle entries, exit codes, board, worktree family ───
  {
    const f = fixture("a6-lifecycle", { acceptance: "- [ ] [A1] behaves\n- [ ] [A2] verified\n" });
    // spec_audit prepare before begin/impl must fail without a packet.
    const early = notOk(f.cwd, ["audit", "S1", "--prepare"]);
    assert.match(early.stderr, /not in-progress|impl is not explicitly passing/);
    record("A6-prepare-requires-lifecycle", { rejectedBeforeImpl: true });

    ok(f.cwd, ["begin", "S1"]);
    f.write("implemented\n");
    // A7: a failing gate must exit non-zero while still recording the failure.
    const failing = fixture("a7-failing-gate", { gates: 7 });
    ok(failing.cwd, ["begin", "S1"]);
    failing.write("changed\n");
    const failedImpl = notOk(failing.cwd, ["impl", "S1"]);
    assert.match(failedImpl.stdout, /FAIL/);
    assert.match(failedImpl.stdout, /category=impl-fail/);
    record("A7-impl-failing-gate-nonzero", { exitCode: failedImpl.status, category: "impl-fail" });

    const passedImpl = ok(f.cwd, ["impl", "S1"]);
    assert.match(passedImpl, /category=pass|PASS/);
    const specFile = path.join(f.cwd, "docs/specs/S1.md");
    const beforeSpec = fs.readFileSync(specFile);
    const beforeLedger = ledger(f.cwd);
    const prepared = JSON.parse(ok(f.cwd, ["audit", "S1", "--prepare"]));
    assert.match(prepared.jobId, /^[a-f0-9]{32}$/);
    assert.ok(fs.existsSync(prepared.packetPath));
    assert.equal(prepared.modelInvoked, false);
    assert.equal(fs.readFileSync(specFile).equals(beforeSpec), true, "prepare must not write the Spec");
    assert.deepEqual(ledger(f.cwd), beforeLedger, "prepare must not append the ledger");
    const budgets = path.join(f.cwd, ".git/spec-flow/review-v1/budgets");
    assert.equal(fs.existsSync(budgets), false, "prepare must not create a grant");
    record("A6-free-prepare-zero-write", { jobId: prepared.jobId, packetBytes: prepared.receipt.packet_bytes });

    // prepare never accepts a job/budget selector.
    for (const args of [
      ["audit", "S1", "--prepare", "--review-job", prepared.jobId],
      ["audit", "S1", "--prepare", "--max-bytes", "1024", "--review-job", prepared.jobId],
    ]) {
      const out = notOk(f.cwd, args);
      assert.match(out.stderr, /prepare|accepts/);
    }
    record("A6-prepare-parameter-conflicts", { rejected: 2 });

    // A6: implementation drift after prepare is rejected before charging.
    f.write("drifted implementation\n");
    const drift = notOk(f.cwd, [
      "audit",
      "S1",
      "--review-job",
      prepared.jobId,
    ], { SPECFLOW_AUDIT_BIN: path.join(sandbox, "never-runs") });
    assert.match(drift.stdout + drift.stderr, /impl|snapshot|binding|not explicitly passing|rerun/i);
    assert.equal(
      fs.existsSync(path.join(f.cwd, ".git/spec-flow/review-v1/budgets/never.json")),
      false,
    );
    record("A6-pre-count-drift-rejected", { exitCode: drift.status });

    // Restore the impl binding, then prove replay/attach never double-spends.
    ok(f.cwd, ["impl", "S1"]);
    const reprepared = JSON.parse(ok(f.cwd, ["audit", "S1", "--prepare"]));
    ok(f.cwd, [
      "review-budget",
      "--json",
      JSON.stringify({ id: "probe", calls: 1, note: "Disposable parent probe fake grant; not a real review authorization." }),
    ]);
    const fake = path.join(sandbox, "fake-audit.mjs");
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport { mechanicalCoverage } from ${JSON.stringify(pathToFileURL(path.join(root, "tests/helpers/review-fixture.mjs")).href)};\nconst packet = fs.readFileSync(process.argv.at(-1).slice(1), 'utf8');\nconsole.log(JSON.stringify(mechanicalCoverage({ verdict: 'pass', criteria: [{ criterion: 'synthetic static record', status: 'pass', evidence: 'synthetic fixture only' }], scope_deviations: [] }, packet)));\n`,
      { mode: 0o700 },
    );
    const audited = ok(f.cwd, ["audit", "S1", "--review-job", reprepared.jobId], {
      SPECFLOW_AUDIT_BIN: fake,
      SPECFLOW_REVIEW_BUDGET_ID: "probe",
    });
    assert.match(audited, /PASS/);
    const used = JSON.parse(
      fs.readFileSync(path.join(f.cwd, ".git/spec-flow/review-v1/budgets/probe.json"), "utf8"),
    ).used;
    assert.equal(used, 1);
    const replay = ok(f.cwd, ["audit", "S1", "--review-job", reprepared.jobId], {
      SPECFLOW_AUDIT_MAX_BYTES: "1",
      SPECFLOW_AUDIT_BIN: path.join(sandbox, "never-runs"),
    });
    assert.match(replay, /缓存复用/);
    const usedAfter = JSON.parse(
      fs.readFileSync(path.join(f.cwd, ".git/spec-flow/review-v1/budgets/probe.json"), "utf8"),
    ).used;
    assert.equal(usedAfter, 1, "free replay must not charge again");
    record("A6-A7-attach-and-free-replay", { chargedOnce: true, replayCategory: "pass" });

    // A8: board is record-only by default, includes actionable recovery, and
    // live drift points back to impl instead of done.
    const board = JSON.parse(ok(f.cwd, ["board", "--json"]));
    assert.equal(board.freshness, "record-only");
    const entry = board.specs.find((item) => item.id === "S1");
    assert.equal(entry.fresh, null);
    assert.ok(entry.nextActions.length > 0);
    for (const action of entry.nextActions) {
      for (const key of ["tool", "args", "reason", "requiresAuthorization", "requiresHuman"]) {
        assert.ok(Object.hasOwn(action, key), `nextAction missing ${key}`);
      }
    }
    fs.writeFileSync(path.join(f.cwd, "drift.txt"), "post-audit drift\n");
    const live = JSON.parse(ok(f.cwd, ["board", "S1", "--live", "--json"]));
    const liveEntry = live.specs[0];
    assert.equal(live.freshness, "live");
    assert.equal(liveEntry.fresh, false);
    assert.equal(liveEntry.stage, "impl");
    assert.equal(liveEntry.nextActions[0].tool, "spec_impl");
    assert.ok(!liveEntry.nextActions.some((action) => action.tool === "spec_done"));
    const specAfterBoard = fs.readFileSync(specFile);
    assert.equal(specAfterBoard.equals(fs.readFileSync(specFile)), true);
    record("A8-board-record-only-and-live-drift", {
      defaultFreshness: board.freshness,
      liveStage: liveEntry.stage,
      liveAction: liveEntry.nextActions[0].tool,
    });

    // A12: an unverifiable sibling worktree blocks allocation with a structured
    // diagnostic (core + CLI), keeps the family untouched, and still allows a
    // read-only preview.
    const family = fixture("a12-family");
    const member = path.join(sandbox, "a12-member");
    git(family.cwd, ["worktree", "add", "--detach", member]);
    fs.rmSync(path.join(member, ".git"));
    const before = git(family.cwd, ["worktree", "list", "--porcelain", "-z"]);
    for (const args of [
      ["spec-alloc", "--prefix", "S"],
      ["spec-new", "--json", JSON.stringify({ title: "Blocked", prefix: "S" })],
    ]) {
      const out = notOk(family.cwd, args);
      assert.match(out.stderr, /SPECFLOW_WORKTREE_UNAVAILABLE/);
      assert.match(out.stderr, /worktree-inventory/);
      assert.match(out.stderr, /prunable/);
      assert.match(out.stderr, /worktree prune --dry-run/);
      assert.doesNotMatch(out.stderr, /^Error: fatal: not a git repository/m);
    }
    assert.equal(git(family.cwd, ["worktree", "list", "--porcelain", "-z"]), before);
    const preview = JSON.parse(
      ok(family.cwd, ["spec-new", "--json", JSON.stringify({ title: "Preview", prefix: "S", dryRun: true })]),
    );
    assert.equal(preview.dryRun, true);
    record("A12-worktree-diagnostic", { coreAndCli: true, familyUnchanged: true, previewUsable: true });
    git(family.cwd, ["worktree", "prune"]);
  }

  console.log(JSON.stringify({ probe: "parent-acceptance", providerCalls: 0, realGrantsCreated: 0, results }, null, 2));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
