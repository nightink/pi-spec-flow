// Deterministic coverage/provenance tests, not evidence of model comprehension.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  attest,
  audit,
  begin,
  checkCI,
  done,
  findSpec,
  impl,
  parseFrontmatter,
  writeFrontmatter,
} from "../src/core.mjs";
import * as engine from "../src/review-engine.mjs";
import { digest, loadJob, reviewStore, saveJob } from "../src/review-storage.mjs";

const BODY = `# Observable refresh\n\n## Outcome\n\n- The user refresh control updates the visible value.\n\n## Design\n\n- Entry must call the refresh helper, not just implement it.\n- Duration is the sum of individual session spans, including parallel sessions.\n\n## Executable acceptance\n\n- [ ] [A1] A helper returns the new value.\n- [ ] [A2] Clicking the actual entry updates the visible value.\n\n## Review 与决策\n\n| ID | Severity | Finding | Disposition |\n|---|---|---|---|\n| F1 | major | Refresh entry is disconnected | Written into Design |\n\nA withdrawal would require an explicit recorded approval, not a new model opinion.\n`;
function indexed(content = BODY) {
  const index = engine.buildReviewIndex(content);
  return {
    mode: "working-tree-audit",
    result_protocol_version: 3,
    prompt_version: engine.REVIEW_PROMPT_VERSION,
    coverage_index: index,
    bindings: { review_index_sha256: digest(JSON.stringify(index)) },
    prior_findings: [],
  };
}
function response(job) {
  const acceptance = job.coverage_index.units
    .filter((u) => u.kind === "acceptance")
    .map((u) => u.id);
  return {
    verdict: "pass",
    criteria: [
      {
        id: "C1",
        kind: "product",
        criterion: "synthetic protocol assertion only",
        status: "pass",
        evidence: "Fixed synthetic fixture, not semantic evaluation",
      },
    ],
    scope_deviations: [],
    findings: [],
    previous_closure: [],
    out_of_scope: [],
    coverage: job.coverage_index.units.map((u) => ({
      id: u.id,
      disposition: "covered",
      acceptance_ids: acceptance,
      criterion_ids: ["C1"],
      evidence: "Synthetic mapping only; not a semantic claim",
    })),
  };
}
function fixture(t, body = BODY, metadata = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-coverage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs/specs"), { recursive: true });
  const spec = writeFrontmatter(body, {
    id: "S1",
    status: "approved",
    review: { decision: "approved" },
    ...metadata,
  });
  fs.writeFileSync(path.join(root, "docs/specs/S1.md"), spec);
  fs.writeFileSync(
    path.join(root, "entry.js"),
    "export function refresh() { return 'already connected'; }\n",
  );
  fs.writeFileSync(path.join(root, "helper.js"), "export const value = 1;\n");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "coverage-fixture");
  git("config", "user.email", "fixture@example.invalid");
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const base = commit();
  fs.writeFileSync(path.join(root, "helper.js"), "export const value = 2;\n");
  const head = commit();
  return { root, git, base, head, spec, commit };
}
function data(prepared) {
  const packet = fs.readFileSync(prepared.packetPath, "utf8"),
    start = packet.indexOf("\n\n{") + 2;
  return JSON.parse(packet.slice(start, packet.indexOf("\n\nReturn only strict JSON:", start)));
}

test("coverage: legacy v2 arbitrary nonempty criteria remain byte-equivalent, not relabelled as exhaustive", () => {
  const raw = {
    verdict: "pass",
    criteria: [{ criterion: "helper", status: "pass", evidence: "helper only" }],
    scope_deviations: [],
  };
  assert.deepEqual(
    engine.normalizeReviewResult(raw, { result_protocol_version: 2, mode: "working-tree-audit" }),
    { ...raw, findings: [], previous_closure: [], out_of_scope: [] },
  );
});

test("coverage: coverage-marked jobs cannot downgrade protocol before charging, in worker, or in cached status", async (t) => {
  const f = fixture(t),
    prepared = await engine.review(f.root, { mode: "proposal", id: "S1" });
  const { dir, job } = loadJob(f.root, prepared.jobId),
    packet = fs.readFileSync(path.join(dir, "packet.md"), "utf8");
  const raw = {
    verdict: "pass",
    criteria: [
      {
        criterion: "legacy helper only",
        status: "pass",
        evidence: "Synthetic downgrade attack, not a provider result",
      },
    ],
    scope_deviations: [],
  };
  engine.authorizeReviewBudget(f.root, {
    id: "fixture",
    calls: 1,
    note: "Disposable regression grant; no provider authorization or execution.",
  });
  const budget = path.join(reviewStore(f.root), "budgets/fixture.json"),
    before = fs.readFileSync(budget);
  for (const change of [
    (j) => {
      delete j.result_protocol_version;
    },
    (j) => {
      j.result_protocol_version = 1;
    },
    (j) => {
      j.result_protocol_version = 2;
    },
    (j) => {
      j.result_protocol_version = null;
    },
    (j) => {
      j.result_protocol_version = "3";
    },
    (j) => {
      delete j.prompt_version;
    },
    (j) => {
      j.prompt_version = 5;
    },
  ]) {
    const altered = structuredClone(job);
    change(altered);
    saveJob(dir, altered);
    assert.throws(() => engine.normalizeReviewResult(raw, altered), /Coverage-marked.*protocol/);
    assert.throws(
      () => engine.assertReviewIndexBinding(packet, altered, f.root),
      /Coverage-marked.*protocol/,
    );
    assert.throws(() => engine.reviewStatus(f.root, job.id), /Coverage-marked.*protocol/);
    await assert.rejects(
      engine.runPreparedReview(f.root, job.id, { budgetId: "fixture" }),
      /Coverage-marked.*protocol/,
    );
    assert.deepEqual(fs.readFileSync(budget), before);
  }
  // Even removing all job-side markers cannot reinterpret its still-v3 packet.
  const stripped = structuredClone(job);
  delete stripped.result_protocol_version;
  delete stripped.prompt_version;
  delete stripped.coverage_index;
  for (const key of ["review_index_sha256", "source_context_sha256", "review_history_sha256"])
    delete stripped.bindings[key];
  saveJob(dir, stripped);
  assert.throws(() => engine.reviewStatus(f.root, job.id), /Coverage-marked.*protocol/);
  await assert.rejects(
    engine.runPreparedReview(f.root, job.id, { budgetId: "fixture" }),
    /Coverage-marked.*protocol/,
  );
  assert.deepEqual(fs.readFileSync(budget), before);
  const completed = {
    ...structuredClone(job),
    state: "completed",
    child_input_sha256: job.packet_sha256,
    raw_sha256: digest(JSON.stringify(raw)),
    result: engine.normalizeReviewResult(raw, { mode: job.mode }),
  };
  delete completed.result_protocol_version;
  fs.writeFileSync(path.join(dir, "stdout.txt"), JSON.stringify(raw));
  saveJob(dir, completed);
  assert.throws(() => engine.reviewStatus(f.root, job.id), /Coverage-marked.*protocol/);
  // A worker that sees corruption after claim fails before constructing a child.
  fs.unlinkSync(path.join(dir, "stdout.txt"));
  const marker = path.join(f.root, "unexpected-child"),
    fake = path.join(f.root, "never-run.mjs");
  fs.writeFileSync(
    fake,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'unexpected');console.log(${JSON.stringify(JSON.stringify(raw))});`,
  );
  const running = {
    ...structuredClone(job),
    state: "running",
    model_invoked: false,
    execution: {
      bin: process.execPath,
      prefixArgs: [fake],
      model: "",
      thinking: "off",
      timeout: 5000,
    },
  };
  delete running.result_protocol_version;
  saveJob(dir, running);
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../src/review-worker.mjs", import.meta.url)), f.root, job.id],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)) },
  );
  const stopped = loadJob(f.root, job.id).job;
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.model_invoked, false);
  assert.match(stopped.error, /Coverage-marked.*protocol/);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readFileSync(budget), before);
});

test("coverage: closure ID namespace is explicit and author table or current finding IDs never enroll as prior", async (t) => {
  const f = fixture(t),
    prepared = await engine.review(f.root, { mode: "proposal", id: "S1" });
  const packet = fs.readFileSync(prepared.packetPath, "utf8");
  assert.ok(
    packet.includes("Allowed previous_closure IDs from review_metadata.prior_findings: []"),
  );
  assert.ok(packet.includes("If this list is empty, previous_closure MUST be []"));
  assert.ok(packet.includes('"previous_closure":[]'));
  const job = indexed(),
    raw = response(job);
  assert.ok(
    job.coverage_index.units.some((u) => u.kind === "review-finding" && u.text.includes("F1")),
  );
  for (const id of ["F1", "APR-1", "invented-prior"]) {
    const altered = structuredClone(raw);
    altered.findings = [
      {
        id,
        classification: "suggestion",
        blocking: false,
        file: "entry.js",
        line: 1,
        evidence: "Synthetic current observation, not an inherited report",
      },
    ];
    altered.previous_closure = [
      {
        id,
        status: "fixed",
        evidence: "Synthetic unsupported enrollment; must not authorize closure",
      },
    ];
    assert.equal(engine.reviewOutputInfo(altered, job).category, "protocol-error");
  }
  assert.equal(engine.reviewOutputInfo(raw, job).category, "pass");
});

test("coverage: index inventories design outside checkboxes, preserves location, ignores YAML and fenced fake acceptance", () => {
  const content = writeFrontmatter(`${BODY}\n\`\`\`md\n- [ ] not a real acceptance\n\`\`\`\n`, {
    id: "S1",
    audit: { verdict: "pass" },
  });
  const job = indexed(content),
    index = job.coverage_index;
  assert.deepEqual(index, engine.buildReviewIndex(content));
  assert.equal(index.version, 1);
  assert.equal(index.units.filter((u) => u.kind === "acceptance").length, 2);
  assert.equal(index.units.filter((u) => u.kind === "review-finding").length, 1);
  assert.ok(index.units.some((u) => u.text.includes("Entry must call")));
  for (const unit of index.units) {
    assert.ok(unit.line > 0 && unit.end_line >= unit.line);
    assert.equal(digest(unit.text), unit.sha256);
    assert.ok(!unit.text.includes("verdict: pass"));
  }
  assert.notEqual(
    JSON.stringify(index),
    JSON.stringify(
      engine.buildReviewIndex(content.replace("actual entry", "actual entry and keyboard path")),
    ),
  );
  assert.throws(
    () =>
      engine.buildReviewIndex(
        Array.from({ length: 401 }, (_, i) => `- obligation ${i}`).join("\n"),
      ),
    /limit|400/,
  );
});

test("coverage: omitted, duplicate, unknown IDs and dangling criterion/acceptance refs cannot PASS", () => {
  const job = indexed(),
    raw = response(job);
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "pass");
  for (const mutate of [
    (r) => r.coverage.pop(),
    (r) => r.coverage.push(r.coverage[0]),
    (r) => {
      r.coverage[0].id = "not-in-sealed-index";
    },
    (r) => {
      r.coverage[0].criterion_ids = ["unknown"];
    },
    (r) => {
      r.coverage[0].acceptance_ids = ["unknown"];
    },
    (r) => {
      r.criteria[0].id = "";
    },
    (r) => {
      delete r.coverage;
    },
  ]) {
    const altered = structuredClone(raw);
    mutate(altered);
    const result = engine.normalizeReviewResult(altered, job);
    assert.equal(result.verdict, "fail");
    assert.equal(engine.reviewOutputInfo(altered, job, result).category, "protocol-error");
  }
});

test("coverage: missing acceptance is a gap, not a fabricated product defect; major/context escape is rejected", () => {
  const job = indexed(),
    raw = response(job);
  const entry = raw.coverage.find((c) =>
    job.coverage_index.units.find((u) => u.id === c.id).text.includes("Entry must call"),
  );
  entry.disposition = "gap";
  entry.acceptance_ids = [];
  entry.criterion_ids = [];
  entry.evidence = "No executable acceptance covers actual entry wiring";
  const result = engine.normalizeReviewResult(raw, job);
  assert.equal(result.verdict, "fail");
  assert.equal(engine.reviewOutputInfo(raw, job, result).category, "coverage-gap");
  assert.ok(
    result.criteria.some(
      (c) => c.criterion === "Review coverage completeness" && c.status === "unverifiable",
    ),
  );
  const major = response(job),
    row = major.coverage.find(
      (c) => job.coverage_index.units.find((u) => u.id === c.id).kind === "review-finding",
    );
  row.disposition = "context";
  row.acceptance_ids = [];
  row.criterion_ids = [];
  assert.equal(engine.normalizeReviewResult(major, job).verdict, "fail");
});

test("coverage: mixed product failure and coverage gap preserve both layers, never wash the static failure into gap", () => {
  const job = indexed(),
    raw = response(job);
  raw.verdict = "fail";
  raw.criteria[0].status = "fail";
  raw.criteria[0].evidence = "Prescribed synthetic static wiring failure, not a model discovery";
  raw.coverage[0].disposition = "gap";
  const result = engine.normalizeReviewResult(raw, job),
    info = engine.reviewOutputInfo(raw, job, result);
  assert.equal(result.verdict, "fail");
  assert.equal(info.category, "product-fail");
  assert.equal(result.coverage_summary.gap_units, 1);
  assert.match(info.message, /两层都须处理/);
  raw.criteria[0].status = "pass";
  assert.equal(engine.reviewOutputInfo(raw, job).category, "coverage-gap");
});

test("coverage: prompt 7 types evidence failures without laundering independently failing product criteria", () => {
  const job = { ...indexed(), prompt_version: 7 },
    raw = response(job);
  raw.criteria[0].kind = "product";
  raw.criteria.push({
    id: "C2",
    kind: "evidence",
    criterion: "Required caller context is supplied",
    status: "fail",
    evidence: "Prescribed missing caller evidence, not a static product defect",
  });
  raw.verdict = "fail";
  Object.assign(raw.coverage[0], {
    disposition: "gap",
    acceptance_ids: [],
    criterion_ids: ["C2"],
    evidence: "Caller context is absent; no disconnection is established",
  });
  assert.equal(engine.reviewOutputInfo(raw, job).category, "coverage-gap");
  assert.equal(engine.reviewOutputInfo(raw, job).productCriteria, 1);
  assert.equal(engine.reviewOutputInfo(raw, job).evidenceCriteria, 1);
  assert.equal(engine.normalizeReviewResult(raw, job).criteria[1].kind, "evidence");
  raw.criteria[0].status = "fail";
  assert.equal(engine.reviewOutputInfo(raw, job).category, "product-fail");
  raw.criteria[0].status = "pass";
  const noType = structuredClone(raw);
  delete noType.criteria[1].kind;
  assert.equal(engine.reviewOutputInfo(noType, job).category, "protocol-error");
  const noGap = structuredClone(raw);
  noGap.coverage[0].disposition = "context";
  noGap.coverage[0].criterion_ids = [];
  assert.equal(engine.reviewOutputInfo(noGap, job).category, "protocol-error");
  const invalidType = structuredClone(raw);
  invalidType.criteria[1].kind = "arbitrary";
  assert.equal(engine.reviewOutputInfo(invalidType, job).category, "protocol-error");
  raw.findings.push({
    id: "F1",
    classification: "incomplete-fix",
    file: "entry.js",
    line: 1,
    blocking: true,
    evidence: "Prescribed independent static failure",
  });
  assert.equal(engine.reviewOutputInfo(raw, job).category, "product-fail");
});

test("coverage: retained prompt 6 criteria without kind are not reclassified or supplemented", () => {
  const job = { ...indexed(), prompt_version: 6 },
    raw = response(job);
  delete raw.criteria[0].kind;
  raw.criteria[0].status = "fail";
  raw.verdict = "fail";
  raw.coverage[0].disposition = "gap";
  const result = engine.normalizeReviewResult(raw, job);
  assert.equal(Object.hasOwn(result.criteria[0], "kind"), false);
  assert.equal(engine.reviewOutputInfo(raw, job).category, "product-fail");
  raw.criteria[0].kind = "evidence";
  const invalidOldShape = engine.normalizeReviewResult(raw, job);
  assert.equal(Object.hasOwn(invalidOldShape.criteria[0], "kind"), false);
  assert.equal(
    invalidOldShape.criteria.at(-1).evidence,
    "Invalid/oversize v3 criterion fields; no truncating approval",
  );
  assert.equal(engine.reviewOutputInfo(raw, job).category, "protocol-error");
});

test("coverage: explicit withdrawal/rejection requires a distinct decision and static evidence; parallel sums have no invented cap", () => {
  const job = indexed(),
    raw = response(job);
  const major = raw.coverage.find(
    (c) => job.coverage_index.units.find((u) => u.id === c.id).kind === "review-finding",
  );
  major.disposition = "withdrawn";
  major.acceptance_ids = [];
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "fail");
  major.decision_ids = [job.coverage_index.units.find((u) => u.text.startsWith("A withdrawal")).id];
  // Mechanics validates the reference, NOT whether the cited approval is genuine.
  const decision = raw.coverage.find((row) => row.id === major.decision_ids[0]);
  Object.assign(decision, {
    disposition: "context",
    acceptance_ids: [],
    criterion_ids: [],
    evidence: "Pure decision record; its authenticity remains a semantic question",
  });
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "pass");
  major.decision_ids = ["APR-1"];
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "fail");
  major.decision_ids = [major.id];
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "fail");
});

test("coverage: runtime residuals need recorded-evidence criteria and visible reasons; context absence is a gap", () => {
  const job = indexed(),
    raw = response(job),
    row = raw.coverage.find(
      (c) => job.coverage_index.units.find((u) => u.id === c.id).kind === "acceptance",
    );
  row.disposition = "deferred";
  row.reason = "runtime";
  raw.out_of_scope = [`[${row.id}] actual runtime deferred; only recorded evidence reviewed`];
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "pass");
  row.criterion_ids = [];
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "fail");
  row.criterion_ids = ["C1"];
  raw.out_of_scope = [];
  assert.equal(engine.normalizeReviewResult(raw, job).verdict, "fail");
});

test("coverage: prepare seals unchanged caller source from selected head, not dirty files, without a provider", async (t) => {
  const f = fixture(t, BODY, {
    review_inputs: { context_files: ["entry.js"], proposal_reviews: [] },
  });
  fs.writeFileSync(path.join(f.root, "entry.js"), "DIRTY MUST NOT BE SENT\n");
  const prepared = await engine.review(f.root, {
      id: "S1",
      base: f.base,
      head: f.head,
      allowDirty: true,
    }),
    packet = data(prepared);
  assert.equal(prepared.receipt.result_protocol_version, 3);
  assert.equal(prepared.receipt.prompt_version, 9);
  assert.equal(packet.source_context[0].path, "entry.js");
  assert.match(packet.source_context[0].content, /already connected/);
  assert.doesNotMatch(packet.source_context[0].content, /DIRTY/);
  assert.equal(packet.source_context[0].sha256, digest(packet.source_context[0].content));
  assert.deepEqual(packet.review_index, prepared.receipt.coverage_index);
  assert.equal(
    prepared.receipt.bindings.review_index_sha256,
    digest(JSON.stringify(packet.review_index)),
  );
  assert.equal(prepared.modelInvoked, false);
});

test("coverage: unsafe context, symlinks and oversize sources reject before grant/spawn", async (t) => {
  const f = fixture(t);
  const cases = ["../outside.js", "/etc/passwd", ".git/config", ".env", "linked.js", "huge.js"];
  fs.symlinkSync("entry.js", path.join(f.root, "linked.js"));
  fs.writeFileSync(path.join(f.root, "huge.js"), "x".repeat(65537));
  for (const file of cases) {
    fs.writeFileSync(
      path.join(f.root, "docs/specs/S1.md"),
      writeFrontmatter(BODY, { id: "S1", review_inputs: { context_files: [file] } }),
    );
    await assert.rejects(
      engine.review(f.root, { mode: "proposal", id: "S1" }),
      /context|source|path|symlink|limit|Unsafe/i,
    );
  }
  assert.equal(fs.existsSync(path.join(reviewStore(f.root), "budgets")), false);
});

test("coverage: tampered index cannot change sealed interpretation before spend", async (t) => {
  const f = fixture(t),
    prepared = await engine.review(f.root, { id: "S1", base: f.base, head: f.head });
  engine.authorizeReviewBudget(f.root, {
    id: "mechanical",
    calls: 1,
    note: "Disposable negative preflight only, no executable or provider should start.",
  });
  const { dir, job } = loadJob(f.root, prepared.jobId);
  assert.ok(job.coverage_index);
  job.coverage_index.units.pop();
  saveJob(dir, job);
  await assert.rejects(
    engine.runPreparedReview(f.root, prepared.jobId, { budgetId: "mechanical" }),
    /index|coverage|packet/i,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(reviewStore(f.root), "budgets/mechanical.json"))).used,
    0,
  );
});

test("coverage: v3 file/note diagnostics never construct a downgraded coverage job", () => {
  for (const prompt of [6, 7, 8, 9])
    for (const status of ["pass", "fail"]) {
      const job = { ...indexed(), prompt_version: prompt },
        raw = response(job);
      if (prompt === 6) delete raw.criteria[0].kind;
      raw.verdict = status;
      raw.criteria[0].status = status;
      raw.scope_deviations = [
        { file: "outside.txt", note: "Synthetic nonblocking observation, not execution evidence" },
      ];
      const before = JSON.stringify(raw),
        normalized = engine.normalizeReviewResult(raw, job);
      const info = engine.reviewOutputInfo(raw, job, normalized);
      assert.equal(info.category, normalized.verdict === "pass" ? "pass" : "product-fail");
      assert.equal(info.compatibilityApplied, true);
      assert.equal(info.repairable, false);
      assert.equal(JSON.stringify(raw), before);
      const invalid = structuredClone(raw);
      invalid.scope_deviations[0].unknown = "must not be discarded";
      assert.equal(engine.reviewOutputInfo(invalid, job).category, "protocol-error");
      assert.throws(
        () => engine.normalizeReviewResult(raw, { ...job, result_protocol_version: 2 }),
        /Coverage-marked/,
      );
    }
});

test("coverage: v3 file/note completed status and free cache preserve raw output and budget", async (t) => {
  const f = fixture(t),
    prepared = await engine.review(f.root, { mode: "proposal", id: "S1" }),
    raw = response(prepared.receipt);
  raw.scope_deviations = [
    {
      file: "outside.txt",
      note: "Synthetic compatible scope observation; no model or runtime claim",
    },
  ];
  const count = fakeExecutor(t, f, raw),
    completed = await engine.runPreparedReview(f.root, prepared.jobId, { budgetId: "synthetic" });
  assert.equal(completed.state, "completed");
  assert.equal(completed.outputInfo.compatibilityApplied, true);
  const { dir } = loadJob(f.root, prepared.jobId),
    stdout = fs.readFileSync(path.join(dir, "stdout.txt"));
  const budget = path.join(reviewStore(f.root), "budgets/synthetic.json"),
    bytes = fs.readFileSync(budget);
  assert.equal(
    engine.reviewStatus(f.root, prepared.jobId).outputInfo.category,
    completed.outputInfo.category,
  );
  const cached = await engine.runPreparedReview(f.root, prepared.jobId, {
    budgetId: "missing-must-still-be-free",
  });
  assert.equal(cached.outputInfo.category, completed.outputInfo.category);
  assert.deepEqual(fs.readFileSync(budget), bytes);
  assert.deepEqual(fs.readFileSync(path.join(dir, "stdout.txt")), stdout);
  assert.equal(fs.readFileSync(count, "utf8"), "call\n");
});

function fakeExecutor(t, f, raw, calls = 1) {
  const bin = path.join(f.root, ".git", "synthetic-review.mjs"),
    count = path.join(f.root, ".git", "synthetic-calls");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nimport fs from 'node:fs';import {mechanicalCoverage} from ${JSON.stringify(new URL("../../../tests/helpers/review-fixture.mjs", import.meta.url).href)};fs.appendFileSync(${JSON.stringify(count)},'call\\n');console.log(JSON.stringify(mechanicalCoverage(${JSON.stringify(raw)},fs.readFileSync(process.argv.at(-1).slice(1),'utf8'))));\n`,
    { mode: 0o700 },
  );
  const old = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = bin;
  t.after(() => {
    if (old === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = old;
  });
  engine.authorizeReviewBudget(f.root, {
    id: "synthetic",
    calls,
    note: "Disposable fake executor only; no real model/provider or delivery authorization.",
  });
  return count;
}

test("coverage: malformed/oversize/unknown output remains protocol error without throwing or lossy approval", () => {
  const job = indexed();
  for (const mutate of [
    (r) => {
      r.criteria = {};
    },
    (r) => {
      r.out_of_scope = {};
    },
    (r) => {
      r.coverage = {};
    },
    (r) => {
      r.previous_closure = {};
    },
    (r) => {
      r.criteria[0].evidence = "x".repeat(10001);
    },
    (r) => {
      r.criteria[0].blocking = true;
    },
    (r) => {
      r.unrecognized_semantics = true;
    },
  ]) {
    const raw = response(job);
    mutate(raw);
    const result = engine.normalizeReviewResult(raw, job);
    assert.equal(result.verdict, "fail");
    assert.equal(engine.reviewOutputInfo(raw, job, result).category, "protocol-error");
  }
});

test("coverage: sealed inventory cannot be author-trimmed or contain lossy binary caller data", async (t) => {
  const f = fixture(t),
    index = engine.buildReviewIndex(BODY);
  index.units.pop();
  await assert.rejects(
    engine.sealReview(f.root, {
      mode: "proposal",
      contract: BODY,
      review_index: index,
      bindings: {},
    }),
    /complete deterministic/,
  );
  fs.writeFileSync(path.join(f.root, "entry.js"), Buffer.from([0xff, 0x00, 0x01]));
  const spec = writeFrontmatter(BODY, { id: "S1", review_inputs: { context_files: ["entry.js"] } });
  fs.writeFileSync(path.join(f.root, "docs/specs/S1.md"), spec);
  await assert.rejects(engine.review(f.root, { mode: "proposal", id: "S1" }), /UTF-8|binary/);
});

test("coverage: original proposal blockers are source-bound, inherited by full audit and acceptance-linked", async (t) => {
  const f = fixture(t),
    count = fakeExecutor(t, f, {
      verdict: "fail",
      criteria: [{ criterion: "plan feasibility", status: "pass", evidence: "synthetic fixture" }],
      scope_deviations: [],
      findings: [
        {
          id: "F1",
          classification: "incomplete-fix",
          blocking: true,
          file: "entry.js",
          line: 1,
          evidence: "Synthetic proposal requests actual caller wiring",
        },
      ],
    });
  const proposal = await engine.review(f.root, { mode: "proposal", id: "S1" });
  const complete = await engine.runPreparedReview(f.root, proposal.jobId, {
    budgetId: "synthetic",
  });
  assert.equal(complete.outputInfo.category, "product-fail");
  const specPath = path.join(f.root, "docs/specs/S1.md"),
    fm = parseFrontmatter(f.spec).data;
  fm.review_inputs = { context_files: ["entry.js"], proposal_reviews: [proposal.jobId] };
  fs.writeFileSync(specPath, writeFrontmatter(f.spec, fm));
  const spec = findSpec(f.root, "S1");
  const prepared = await engine.prepareWorkingAudit(f.root, {
    spec,
    content: spec.content,
    profile: spec.profile,
    bindings: {},
    diff: "synthetic declared diff",
    impl: {},
  });
  assert.equal(prepared.receipt.prior_findings.length, 1);
  const packet = data(prepared),
    prior = prepared.receipt.prior_findings[0];
  assert.equal(packet.review_history[0].job_id, proposal.jobId);
  assert.equal(packet.review_history[0].packet_sha256, complete.receipt.packet_sha256);
  assert.equal(
    packet.source_context[0].content,
    fs.readFileSync(path.join(f.root, "entry.js"), "utf8"),
  );
  const raw = response(prepared.receipt);
  assert.equal(engine.normalizeReviewResult(raw, prepared.receipt).verdict, "fail");
  raw.previous_closure = [
    { id: prior, status: "fixed", evidence: "Synthetic closure and acceptance mapping only" },
  ];
  assert.equal(engine.normalizeReviewResult(raw, prepared.receipt).verdict, "pass");
  const closure = raw.coverage.find(
    (c) => prepared.receipt.coverage_index.units.find((u) => u.id === c.id).prior_finding_id,
  );
  closure.acceptance_ids = [];
  assert.equal(engine.normalizeReviewResult(raw, prepared.receipt).verdict, "fail");
  fs.writeFileSync(
    path.join(f.root, "docs/specs/S2.md"),
    writeFrontmatter(BODY, { id: "S2", review_inputs: fm.review_inputs }),
  );
  await assert.rejects(engine.review(f.root, { mode: "proposal", id: "S2" }), /same-Spec/);
  const forged = structuredClone(packet),
    inherited = forged.review_index.units.find((u) => u.prior_finding_id);
  inherited.text = "Author summary replaces original blocker";
  inherited.sha256 = digest(inherited.text);
  await assert.rejects(
    engine.sealReview(f.root, forged, { prior_findings: prepared.receipt.prior_findings }),
    /complete deterministic/,
  );
  const omittedContext = structuredClone(packet);
  omittedContext.source_context = [];
  await assert.rejects(
    engine.sealReview(f.root, omittedContext, { prior_findings: prepared.receipt.prior_findings }),
    /context source inventory/,
  );
  fs.appendFileSync(path.join(loadJob(f.root, proposal.jobId).dir, "stdout.txt"), "tamper");
  await assert.rejects(
    engine.prepareWorkingAudit(f.root, {
      spec,
      content: spec.content,
      profile: spec.profile,
      bindings: {},
      diff: "synthetic",
      impl: {},
    }),
    /changed/,
  );
  assert.throws(() => engine.reviewStatus(f.root, prepared.jobId), /index\/context\/history/);
  await assert.rejects(
    engine.runPreparedReview(f.root, prepared.jobId, { budgetId: "synthetic" }),
    /index\/context\/history/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(reviewStore(f.root), "budgets/synthetic.json"))).used,
    1,
  );
  assert.equal(fs.readFileSync(count, "utf8"), "call\n");
});

test("coverage: proposal evidence gaps are inherited as gaps to resolve, never relabelled as proven bugs", async (t) => {
  const f = fixture(t),
    proposal = await engine.review(f.root, { mode: "proposal", id: "S1" });
  const raw = response(proposal.receipt);
  raw.verdict = "fail";
  const row = raw.coverage.find(
    (item) => item.id === proposal.receipt.coverage_index.acceptance_ids[1],
  );
  row.disposition = "gap";
  row.acceptance_ids = [];
  row.criterion_ids = [];
  row.evidence = "Synthetic missing caller evidence, not a confirmed defect";
  fakeExecutor(t, f, raw);
  assert.equal(
    (await engine.runPreparedReview(f.root, proposal.jobId, { budgetId: "synthetic" })).outputInfo
      .category,
    "coverage-gap",
  );
  const fm = parseFrontmatter(f.spec).data;
  fm.review_inputs = { proposal_reviews: [proposal.jobId] };
  fs.writeFileSync(path.join(f.root, "docs/specs/S1.md"), writeFrontmatter(f.spec, fm));
  const inherited = await engine.review(f.root, { mode: "proposal", id: "S1" });
  assert.equal(inherited.receipt.prior_findings.length, 1);
  const unit = inherited.receipt.coverage_index.units.find((item) => item.prior_finding_id);
  assert.match(unit.text, /NOT a confirmed product defect/);
  assert.match(unit.original_id, /^coverage:/);
  assert.equal(
    engine.normalizeReviewResult(response(inherited.receipt), inherited.receipt).verdict,
    "fail",
  );
});

test("coverage: v3 lifecycle persists accounting; cache/attest/done/CI reject altered or missing retained evidence", async (t) => {
  const f = fixture(t, BODY, { evidence: { e2e: [], migrations: [], human: ["R1"] } });
  fs.writeFileSync(
    path.join(f.root, "package.json"),
    JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }),
  );
  await begin(f.root, "S1");
  fs.writeFileSync(path.join(f.root, "helper.js"), "export const value = 3;\n");
  await impl(f.root, "S1");
  const count = fakeExecutor(t, f, {
    verdict: "pass",
    criteria: [
      {
        criterion: "synthetic lifecycle only",
        status: "pass",
        evidence: "fixed fixture, not real semantic review",
      },
    ],
    scope_deviations: [],
  });
  assert.match(await audit(f.root, "S1", { budgetId: "synthetic" }), /✅ PASS/);
  const spec = findSpec(f.root, "S1"),
    record = spec.frontmatter.audit,
    before = spec.content;
  assert.equal(record.review.result_protocol_version, 3);
  assert.equal(record.coverage.semantic_guarantee, false);
  assert.equal(record.coverage.source_units, record.coverage.accounted_units);
  assert.match(await audit(f.root, "S1", { budgetId: "missing" }), /缓存复用/);
  const downgraded = structuredClone(spec.frontmatter);
  downgraded.audit.prompt_version = 5;
  delete downgraded.audit.review.result_protocol_version;
  const altered = writeFrontmatter(before, downgraded);
  fs.writeFileSync(spec.path, altered);
  assert.throws(
    () =>
      attest(
        f.root,
        "S1",
        "R1",
        "Synthetic downgrade regression: must not bypass retained v3 coverage",
      ),
    /v3|覆盖对账/,
  );
  assert.equal(fs.readFileSync(spec.path, "utf8"), altered);
  assert.equal((await checkCI(f.root, { runProjectGates: false })).pass, false);
  await assert.rejects(done(f.root, "S1"), /v3|覆盖对账/);
  fs.writeFileSync(spec.path, before);
  record.coverage.covered_units--;
  fs.writeFileSync(spec.path, writeFrontmatter(before, spec.frontmatter));
  assert.match(await audit(f.root, "S1"), /coverage evidence mismatch/);
  assert.throws(
    () =>
      attest(
        f.root,
        "S1",
        "R1",
        "Synthetic fixture verification path, not actual product sign-off",
      ),
    /覆盖对账/,
  );
  await assert.rejects(done(f.root, "S1"), /覆盖对账/);
  fs.writeFileSync(spec.path, before);
  const dir = loadJob(f.root, record.review.job_id).dir,
    backup = `${dir}.backup`;
  fs.renameSync(dir, backup);
  try {
    assert.match(await audit(f.root, "S1"), /requires the retained review job/);
    assert.throws(
      () =>
        attest(
          f.root,
          "S1",
          "R1",
          "Synthetic fixture verification path, not actual product sign-off",
        ),
      /requires the retained review job/,
    );
    assert.equal((await checkCI(f.root, { runProjectGates: false })).pass, false);
    await assert.rejects(done(f.root, "S1"), /人工核验|retained/);
  } finally {
    fs.renameSync(backup, dir);
  }
  assert.match(
    attest(
      f.root,
      "S1",
      "R1",
      "Synthetic fixture-only registration path and sample, not a real product attestation",
    ),
    /已登记/,
  );
  assert.match(await done(f.root, "S1"), /已完成/);
  assert.equal(fs.readFileSync(count, "utf8"), "call\n");
});
