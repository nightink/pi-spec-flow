import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSpecFileStable, findSpec, writeFrontmatter } from "../src/core.mjs";
import { boundedSummary, workflowOutcome } from "../src/workflow-diagnostics.mjs";

const core = fileURLToPath(new URL("../src/core.mjs", import.meta.url));
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specflow-recovery-")));
const bin = path.join(sandbox, "path");
fs.mkdirSync(bin);
fs.symlinkSync(process.execPath, path.join(bin, "node"));
fs.symlinkSync(
  execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
  path.join(bin, "git"),
);
const env = { ...process.env, PATH: bin, SPECFLOW_REVIEW_BUDGET_ID: "" };
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
delete env.SPECFLOW_AUDIT_MAX_BYTES;
function cli(cwd, args) {
  return spawnSync(process.execPath, [core, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
}
function git(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture(name, { acceptance = "- [ ] [A1] behaves\n" } = {}) {
  const cwd = path.join(sandbox, name);
  fs.mkdirSync(path.join(cwd, "docs/specs"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "docs/specs/S1.md"),
    writeFrontmatter(`# Recovery fixture\n\n## Acceptance\n\n${acceptance}`, {
      id: "S1",
      title: "Recovery fixture",
      kind: "spec",
      author: "agent",
      status: "approved",
      created: "2026-10-22",
      review: { decision: "approved" },
      evidence: { e2e: [], migrations: [], human: [] },
    }),
  );
  fs.writeFileSync(
    path.join(cwd, ".spec-flow.json"),
    JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [{ name: "offline", argv: ["node", "-e", "process.exit(0)"] }],
      },
    }),
  );
  fs.writeFileSync(path.join(cwd, "code.txt"), "baseline\n");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "recovery-fixture"]);
  git(cwd, ["config", "user.email", "recovery@example.invalid"]);
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=recovery-fixture", "commit", "-qm", "base"]);
  return {
    cwd,
    base: git(cwd, ["rev-parse", "HEAD"]),
    write: (text) => fs.writeFileSync(path.join(cwd, "code.txt"), text),
    head: () => git(cwd, ["rev-parse", "HEAD"]),
  };
}
function diagnosticOf(result) {
  const text = `${result.stdout}${result.stderr}`;
  const index = text.indexOf("Diagnostic: ");
  assert.ok(index >= 0, `missing machine diagnostic: ${text.slice(0, 400)}`);
  return JSON.parse(text.slice(index + 12).split("\n")[0]);
}
test("F1 regression: a Spec edited after sealing is rejected, never reported prepared/pre-spend", (t) => {
  const f = fixture("contract-drift");
  const spec = findSpec(f.cwd, "S1");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assertSpecFileStable(spec, "S1", digest(spec.content), {
    stage: "packet-preparation",
    code: "AUDIT_CONTRACT_UNSTABLE",
  });
  f.write("impl changed\n");
  fs.writeFileSync(
    path.join(f.cwd, "docs/specs/S1.md"),
    writeFrontmatter("# Recovery fixture\n\n## Acceptance\n\n- [ ] [A1] edited after seal\n", {
      ...spec.frontmatter,
    }),
  );
  assert.throws(
    () =>
      assertSpecFileStable(spec, "S1", digest(spec.content), {
        stage: "packet-preparation",
        code: "AUDIT_CONTRACT_UNSTABLE",
      }),
    (error) => {
      assert.equal(error.diagnostic.code, "AUDIT_CONTRACT_UNSTABLE");
      assert.equal(error.diagnostic.stage, "packet-preparation");
      assert.match(error.message, /changed during packet-preparation/);
      return true;
    },
  );
  t.diagnostic("guard rejects a Spec whose bytes no longer match the sealed contract");
});

test("F2/F3 regression: over-limit recovery actions are executable, not bare prepare/status", () => {
  const f = fixture("recovery-args");
  f.write("committed implementation\n");
  const run = (args) => execFileSync("git", args, { cwd: f.cwd, encoding: "utf8" });
  run(["add", "."]);
  run(["-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-qm", "impl"]);
  const head = f.head();
  const limited = cli(f.cwd, [
    "review",
    "--json",
    JSON.stringify({ id: "S1", base: f.base, head, maxBytes: 1024 }),
  ]);
  assert.notEqual(limited.status, 0);
  const diagnostic = diagnosticOf(limited);
  assert.equal(diagnostic.code, "REVIEW_PACKET_LIMIT");
  const prepareAction = diagnostic.nextActions.find((item) => item.args.action === "prepare");
  assert.equal(prepareAction.args.mode, "committed");
  assert.equal(prepareAction.args.specPath, "docs/specs/S1.md");
  // Either selector is executable by prepare; the action must carry one.
  assert.ok(
    prepareAction.args.id === "S1" || prepareAction.args.specPath,
    JSON.stringify(prepareAction.args),
  );
  assert.ok(prepareAction.args.maxBytes >= diagnostic.actualBytes);
  assert.ok(
    !diagnostic.nextActions.some((item) => item.args.action === "status" && !item.args.jobId),
    "no status action without a retained job id",
  );

  // Full audit: the suggested limit must cover the measured packet exactly.
  assert.equal(cli(f.cwd, ["begin", "S1"]).status, 0);
  f.write("audited working-tree implementation\n");
  const impl = cli(f.cwd, ["impl", "S1"]);
  assert.equal(impl.status, 0, impl.stderr);
  const overflow = cli(f.cwd, ["audit", "S1", "--prepare", "--max-bytes", "1024"]);
  assert.notEqual(overflow.status, 0);
  const auditDiagnostic = diagnosticOf(overflow);
  // A tiny sealed limit stops the Git capture itself: the diagnostic must then
  // report only a provable lower bound, never a fabricated exact size.
  assert.ok(["audit-diff", "seal"].includes(auditDiagnostic.stage), auditDiagnostic.stage);
  if (auditDiagnostic.actualBytes === null) {
    assert.ok(auditDiagnostic.lowerBoundBytes > 1024);
    assert.equal(auditDiagnostic.totalBytesKnown, false);
  } else {
    assert.ok(auditDiagnostic.actualBytes > 1024);
  }
  const auditAction = auditDiagnostic.nextActions.find(
    (item) => item.args.action === "prepare" && item.args.id === "S1",
  );
  assert.ok(auditAction, JSON.stringify(auditDiagnostic.nextActions));
  if (auditDiagnostic.actualBytes != null) {
    // A measured complete packet needs exactly its size to fit.
    assert.ok(
      auditDiagnostic.actualBytes <= auditAction.args.maxBytes,
      "suggested limit must fit the measured packet",
    );
  } else {
    assert.ok(
      auditAction.args.maxBytes > auditDiagnostic.lowerBoundBytes,
      `suggested ${auditAction.args.maxBytes} must exceed the lower bound ${auditDiagnostic.lowerBoundBytes}`,
    );
  }
  assert.equal(auditAction.requiresHuman, true);
});

test("F5 regression: an oversized summary degrades with an explicit marker instead of throwing", () => {
  const huge = "x".repeat(30000);
  const outcome = workflowOutcome({
    operation: "audit",
    specId: "S1",
    pass: false,
    category: "product-fail",
    summary: huge,
    nextActions: [],
  });
  assert.ok(outcome.summary.length <= 20120);
  assert.match(
    outcome.summary,
    /summary truncated \d+ characters; full text in the retained receipt/,
  );
  assert.equal(boundedSummary("short"), "short");
  assert.throws(() => boundedSummary(""), /required/);
});
