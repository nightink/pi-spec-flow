// S2.2 A6–A8 real CLI boundary: free prepare, exit codes, structured
// diagnostics and board staging. Synthetic repos and a prescribed fake auditor
// only — no provider, no real grant, no network.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFrontmatter } from "../../packages/core/src/core.mjs";
import { loadJob, reviewStore } from "../../packages/core/src/review-storage.mjs";

const core = fileURLToPath(new URL("../../packages/core/src/core.mjs", import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-agent-cli-"));
const fakeDir = path.join(sandbox, "fake");
const fakeAuditor = path.join(fakeDir, "fake-auditor.mjs");
const fakeCalls = path.join(fakeDir, "calls");
const fakeResult = path.join(fakeDir, "result.json");
const fixtureModule = new URL("../helpers/review-fixture.mjs", import.meta.url).href;

const baseEnv = {
  ...process.env,
  SPECFLOW_AUDIT_BIN: fakeAuditor,
  SPECFLOW_AUDIT_MAX_BYTES: "",
  SPECFLOW_AUDIT_MODEL: "",
  SPECFLOW_AUDIT_THINKING: "off",
  SPECFLOW_REVIEW_BUDGET_ID: "",
  SPECFLOW_REVIEW_EXECUTOR: "",
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function specContent() {
  return writeFrontmatter("# E2E contract\n\n## Acceptance\n\n- [ ] implementation works\n", {
    id: "S1",
    status: "approved",
    review: { decision: "approved" },
    evidence: { e2e: [], migrations: [], human: [] },
  });
}

function repo(name, { gateExit = 0 } = {}) {
  const root = path.join(sandbox, name);
  fs.mkdirSync(path.join(root, "docs/specs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/specs/S1.md"), specContent());
  fs.writeFileSync(
    path.join(root, ".spec-flow.json"),
    JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [{ name: "offline", argv: ["node", "-e", `process.exit(${gateExit})`] }],
      },
    }),
  );
  fs.writeFileSync(path.join(root, "code.txt"), "baseline\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "agent-cli-fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

function cli(root, args, extra = {}) {
  return spawnSync(process.execPath, [core, ...args], {
    cwd: root,
    env: { ...baseEnv, ...extra },
    encoding: "utf8",
    timeout: 120000,
  });
}

function mustPass(root, args, extra) {
  const result = cli(root, args, extra);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function json(root, args, extra) {
  return JSON.parse(mustPass(root, args, extra));
}

function jobs(root) {
  const dir = path.join(reviewStore(root), "jobs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function budget(root, id) {
  const file = path.join(reviewStore(root), "budgets", `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function granted(root, calls = 3) {
  mustPass(root, [
    "review-budget",
    "--json",
    JSON.stringify({
      id: "e2e",
      calls,
      note: "Disposable S2.2 CLI fixture grant, never a real review authorization.",
    }),
  ]);
}

function useFakeResult(value) {
  fs.writeFileSync(fakeResult, JSON.stringify(value));
}

function state(root) {
  const specPath = path.join(root, "docs/specs/S1.md");
  const ledgerPath = path.join(root, ".spec-flow-ledger.jsonl");
  return {
    spec: fs.readFileSync(specPath),
    ledger: fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : Buffer.alloc(0),
  };
}

try {
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(
    fakeAuditor,
    `#!/usr/bin/env node\nimport fs from 'node:fs';import {mechanicalCoverage} from ${JSON.stringify(fixtureModule)};fs.appendFileSync(${JSON.stringify(fakeCalls)},'call\\n');const raw=JSON.parse(fs.readFileSync(${JSON.stringify(fakeResult)},'utf8'));console.log(JSON.stringify(mechanicalCoverage(raw,fs.readFileSync(process.argv.at(-1).slice(1),'utf8'))));\n`,
    { mode: 0o755 },
  );
  useFakeResult({
    verdict: "pass",
    criteria: [{ criterion: "offline implementation", status: "pass", evidence: "code.txt" }],
    scope_deviations: [],
  });

  // ── A7: real CLI impl exit codes ────────────────────────────────────────
  const failing = repo("failing-impl", { gateExit: 1 });
  mustPass(failing, ["begin", "S1"]);
  fs.writeFileSync(path.join(failing, "code.txt"), "implemented\n");
  const failedImpl = cli(failing, ["impl", "S1"]);
  check(
    failedImpl.status !== 0 && /❌ FAIL/.test(failedImpl.stdout),
    "failing impl gate must exit non-zero with a FAIL record",
  );
  check(
    cli(failing, ["done", "S1"]).status !== 0,
    "done must still reject a failing implementation",
  );

  const passing = repo("passing");
  mustPass(passing, ["begin", "S1"]);
  fs.writeFileSync(path.join(passing, "code.txt"), "implemented\n");
  const passedImpl = mustPass(passing, ["impl", "S1"]);
  check(/✅ PASS/.test(passedImpl), "passing impl gate exits zero with PASS");

  // ── A6: free audit prepare (zero model / zero budget / no lifecycle write) ─
  const beforePrepare = state(passing);
  const beforeJobs = jobs(passing).length;
  const prepared = json(passing, ["audit", "S1", "--prepare"]);
  check(prepared.jobId && /^[a-f0-9]{32}$/.test(prepared.jobId), "prepare returns a jobId");
  check(prepared.prepared === true && prepared.modelInvoked === false, "prepare is free");
  check(prepared.state === "prepared", "prepared job state");
  check(
    typeof prepared.packetPath === "string" && fs.existsSync(prepared.packetPath),
    "packetPath",
  );
  check(prepared.bytes > 0, "prepare reports packet bytes");
  check(
    JSON.stringify(state(passing)) === JSON.stringify(beforePrepare),
    "prepare must not write the Spec or ledger",
  );
  check(budget(passing, "e2e") === null, "prepare must not create or charge a budget");
  check(!fs.existsSync(fakeCalls), "prepare must not invoke the auditor");
  check(jobs(passing).length === beforeJobs + 1, "prepare publishes exactly one private job");
  const preparedJob = loadJob(passing, prepared.jobId).job;
  check(preparedJob.state === "prepared" && preparedJob.model_invoked !== true, "sealed job");

  const explicit = json(passing, ["audit", "S1", "--prepare", "--max-bytes", "1048576"]);
  check(explicit.maxBytes === 1048576, "explicit --max-bytes is forwarded");
  check(
    loadJob(passing, explicit.jobId).job.review_limit.maxBytes === 1048576 &&
      loadJob(passing, explicit.jobId).job.review_limit.source === "argument",
    "explicit limit is sealed into the job with its real source",
  );
  const explicitWins = json(passing, ["audit", "S1", "--prepare", "--max-bytes", "1048576"], {
    SPECFLOW_AUDIT_MAX_BYTES: "4kb",
  });
  check(
    explicitWins.maxBytes === 1048576 &&
      loadJob(passing, explicitWins.jobId).job.review_limit.source === "argument",
    "explicit --max-bytes wins over an invalid environment limit",
  );

  const invalidBefore = jobs(passing).length;
  const invalidState = state(passing);
  for (const value of ["0", "-1", "1.5", "10kb", "1e3", "Infinity", "16777217", " 1024", ""]) {
    const args =
      value === ""
        ? ["audit", "S1", "--prepare", "--max-bytes"]
        : ["audit", "S1", "--prepare", "--max-bytes", value];
    const invalid = cli(passing, args);
    check(invalid.status !== 0, `invalid --max-bytes ${JSON.stringify(value)} must fail`);
    check(
      jobs(passing).length === invalidBefore,
      `invalid --max-bytes ${JSON.stringify(value)} must not prepare`,
    );
  }
  check(
    JSON.stringify(state(passing)) === JSON.stringify(invalidState),
    "invalid parameters must not touch the Spec/ledger",
  );
  check(
    cli(passing, ["audit", "S1", "--max-bytes", "1024"]).status !== 0,
    "--max-bytes is prepare-only",
  );
  check(
    cli(passing, ["audit", "S1", "--prepare", "--review-job", prepared.jobId]).status !== 0,
    "prepare cannot attach an existing job",
  );
  const invalidEnv = cli(passing, ["audit", "S1", "--prepare"], {
    SPECFLOW_AUDIT_MAX_BYTES: "4kb",
  });
  check(
    invalidEnv.status !== 0 &&
      /Diagnostic:/.test(invalidEnv.stderr) &&
      /REVIEW_LIMIT_INVALID/.test(invalidEnv.stderr),
    "CLI keeps the structured limit diagnostic",
  );
  check(jobs(passing).length === invalidBefore, "invalid env must not prepare");

  // ── A6: drift rejects before spend; authorized attach spends once ───────
  granted(passing);
  fs.writeFileSync(path.join(passing, "code.txt"), "changed after impl\n");
  const drift = cli(passing, ["audit", "S1", "--review-job", prepared.jobId]);
  check(drift.status !== 0, "implementation drift must exit non-zero");
  check(/implementation changed after spec_impl/.test(drift.stderr), "drift names the stale stage");
  check(budget(passing, "e2e").used === 0, "drift must not spend budget");
  check(!fs.existsSync(fakeCalls), "drift must not invoke the auditor");

  mustPass(passing, ["impl", "S1"]);
  const rebound = cli(passing, ["audit", "S1", "--review-job", prepared.jobId]);
  check(rebound.status !== 0, "a stale job cannot attach to changed implementation");
  check(
    /binding mismatch|not a full current working-tree audit/.test(rebound.stdout),
    "stale job reports the full-audit binding refusal",
  );
  check(budget(passing, "e2e").used === 0, "binding refusal must not spend budget");

  const audited = mustPass(passing, ["audit", "S1"], { SPECFLOW_REVIEW_BUDGET_ID: "e2e" });
  check(/✅ PASS/.test(audited), "authorized default audit passes");
  check(budget(passing, "e2e").used === 1, "audit spends exactly one call");
  check(fs.readFileSync(fakeCalls, "utf8") === "call\n", "exactly one auditor invocation");
  const cached = mustPass(passing, ["audit", "S1"], { SPECFLOW_REVIEW_BUDGET_ID: "e2e" });
  check(/缓存复用/.test(cached), "cached PASS is free");
  check(budget(passing, "e2e").used === 1, "cache does not charge again");
  check(fs.readFileSync(fakeCalls, "utf8") === "call\n", "cache does not invoke the auditor");
  const doneQuick = mustPass(passing, ["done", "S1"]);
  check(/已完成/.test(doneQuick), "passing evidence closes the Spec");

  // ── A7/A8: protocol error is non-zero and board stages it without retry ─
  const protocol = repo("protocol");
  mustPass(protocol, ["begin", "S1"]);
  fs.writeFileSync(path.join(protocol, "code.txt"), "implemented\n");
  mustPass(protocol, ["impl", "S1"]);
  useFakeResult({
    verdict: "pass",
    criteria: [{ criterion: "malformed scope", status: "pass", evidence: "prescribed fixture" }],
    scope_deviations: [42],
  });
  granted(protocol, 2);
  const protocolAudit = cli(protocol, ["audit", "S1"], { SPECFLOW_REVIEW_BUDGET_ID: "e2e" });
  check(protocolAudit.status !== 0, "protocol error must exit non-zero");
  check(/工具|协议|非产品 FAIL/.test(protocolAudit.stdout), "protocol error is not a product PASS");
  check(budget(protocol, "e2e").used === 1, "protocol execution charged once");

  const protocolBoardBefore = state(protocol);
  const protocolBoard = json(protocol, ["board", "S1", "--json"]);
  check(protocolBoard.freshness === "record-only", "default board is record-only");
  check(protocolBoard.specs[0].stage === "audit-protocol", "board stages protocol error");
  check(
    protocolBoard.specs[0].nextActions[0].tool === "spec_review" &&
      protocolBoard.specs[0].nextActions[0].args.action === "status",
    "protocol next action is a free status read",
  );
  check(
    JSON.stringify(state(protocol)) === JSON.stringify(protocolBoardBefore),
    "board must not write the Spec/ledger",
  );
  const retried = cli(protocol, ["audit", "S1"], { SPECFLOW_REVIEW_BUDGET_ID: "e2e" });
  check(retried.status !== 0, "terminal protocol failure stays non-passing");
  check(budget(protocol, "e2e").used === 1, "board/audit never auto-retries a terminal job");
  check(fs.readFileSync(fakeCalls, "utf8") === "call\ncall\n", "no automatic respawn");
  const boardBefore = state(protocol);

  // ── A8: live freshness routes stale evidence to impl, not done ──────────
  useFakeResult({
    verdict: "pass",
    criteria: [{ criterion: "offline", status: "pass", evidence: "code" }],
    scope_deviations: [],
  });
  fs.writeFileSync(path.join(protocol, "code.txt"), "changed after protocol audit\n");
  const liveBoard = json(protocol, ["board", "S1", "--live", "--json"]);
  check(liveBoard.freshness === "live", "live board reports live freshness");
  check(liveBoard.specs[0].fresh === false, "live board sees the stale implementation");
  check(liveBoard.specs[0].stage === "impl", "stale live evidence routes to impl");
  check(
    liveBoard.specs[0].nextActions[0].tool === "spec_impl" &&
      !liveBoard.specs[0].nextActions.some((action) => action.tool === "spec_done"),
    "stale live board never advertises done",
  );
  const humanBoard = mustPass(protocol, ["board", "S1"]);
  check(/record-only/.test(humanBoard), "human board states record-only explicitly");
  const humanLive = mustPass(protocol, ["board", "S1", "--live"]);
  check(/STALE/.test(humanLive), "human live board marks stale evidence");
  check(
    JSON.stringify(state(protocol)) === JSON.stringify(boardBefore),
    "board inspection never mutates lifecycle",
  );

  // ── A7: real product FAIL exits non-zero ────────────────────────────────
  const product = repo("product");
  mustPass(product, ["begin", "S1"]);
  fs.writeFileSync(path.join(product, "code.txt"), "implemented\n");
  mustPass(product, ["impl", "S1"]);
  useFakeResult({
    verdict: "fail",
    criteria: [{ criterion: "real defect", status: "fail", evidence: "prescribed product FAIL" }],
    scope_deviations: [],
  });
  granted(product, 1);
  const productAudit = cli(product, ["audit", "S1"], { SPECFLOW_REVIEW_BUDGET_ID: "e2e" });
  check(
    productAudit.status !== 0 && /❌ FAIL/.test(productAudit.stdout),
    "product FAIL must exit non-zero",
  );
  check(budget(product, "e2e").used === 1, "product FAIL charged once, no retry");

  // ── A5/A7: over-limit audit is a machine non-pass without a job or spend ─
  const limited = repo("limited");
  mustPass(limited, ["begin", "S1"]);
  fs.writeFileSync(path.join(limited, "code.txt"), "x".repeat(4096));
  mustPass(limited, ["impl", "S1"]);
  granted(limited, 1);
  const callsBeforeLimit = fs.existsSync(fakeCalls)
    ? fs.readFileSync(fakeCalls, "utf8").split("\n").filter(Boolean).length
    : 0;
  const limitedAudit = cli(limited, ["audit", "S1"], {
    SPECFLOW_AUDIT_MAX_BYTES: "1024",
    SPECFLOW_REVIEW_BUDGET_ID: "e2e",
  });
  check(limitedAudit.status !== 0, "over-limit audit must exit non-zero");
  check(/超限/.test(limitedAudit.stdout), "over-limit is labelled as a material limit");
  check(
    /限额: 1024 bytes（来源: environment）/.test(limitedAudit.stdout) &&
      /已知下界/.test(limitedAudit.stdout) &&
      /总量未知/.test(limitedAudit.stdout),
    "over-limit text keeps limit source and an explicit lower bound",
  );
  check(budget(limited, "e2e").used === 0, "over-limit never charges a budget");
  check(jobs(limited).length === 0, "over-limit never creates a review job");
  check(
    (fs.existsSync(fakeCalls) ? fs.readFileSync(fakeCalls, "utf8") : "") ===
      `${Array(callsBeforeLimit).fill("call").join("\n")}${callsBeforeLimit ? "\n" : ""}`,
    "over-limit never invokes the auditor",
  );

  console.log(
    "PASS real CLI free prepare/exit codes/structured diagnostics/board staging over synthetic fixtures",
  );
} catch (error) {
  console.log(`FAIL S2.2 agent workflow E2E: ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
