import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deliveryFixture } from "../../../tests/helpers/delivery-fixture.mjs";
import { mechanicalCoverage, packetData } from "../../../tests/helpers/review-fixture.mjs";
import {
  captureEvidence,
  checkCI,
  engineIdentity,
  inspectBoard,
  prepareAudit,
  repositorySnapshotHash,
} from "../src/core.mjs";
import { DEFAULT_CONTEXT_LIMITS, resolveContextLimits } from "../src/review-context.mjs";
import { buildReviewIndex } from "../src/review-coverage.mjs";
import { review, reviewOutputInfo, reviewResponseTelemetry } from "../src/review-engine.mjs";
import { digest } from "../src/review-storage.mjs";

const change = { runProjectGates: false, forChange: true };
function privateJob(f, id, file = "job.json") {
  return path.join(f.root, ".git/spec-flow/review-v1/jobs", id, file);
}

test("invalid CLI budgets have zero job, Spec or grant effects", async (t) => {
  const f = deliveryFixture(t);
  await f.implement();
  await f.grant();
  const spec = fs.readFileSync(f.spec().path),
    budgetFile = path.join(f.root, ".git/spec-flow/review-v1/budgets/fixture.json");
  const grant = fs.readFileSync(budgetFile);
  for (const args of [
    ["--budget"],
    ["--budget", ""],
    ["--budget", "bad/id"],
    ["--budget", "fixture", "--budget", "fixture"],
    ["--prepare", "--budget", "fixture"],
    ["--budget", "fixture", "--unknown"],
  ]) {
    const run = f.cli("audit", "S1", ...args);
    assert.notEqual(run.status, 0);
    assert.deepEqual(fs.readFileSync(f.spec().path), spec);
    assert.deepEqual(fs.readFileSync(budgetFile), grant);
  }
  const jobs = path.join(f.root, ".git/spec-flow/review-v1/jobs");
  assert.equal(fs.existsSync(jobs) ? fs.readdirSync(jobs).length : 0, 0);
});

test("change mode still rejects forged PASS, receipt tamper, missing approval, bad contract and done", async (t) => {
  const f = deliveryFixture(t);
  await f.implement();
  await f.grant();
  assert.equal(f.cli("audit", "S1").status, 1);
  const baseline = fs.readFileSync(f.spec().path, "utf8");
  for (const mutate of [
    (fm) => {
      fm.audit.review.result_sha256 = "a".repeat(64);
    },
    (fm) => {
      fm.audit.review.packet_sha256 = "a".repeat(64);
    },
    (fm) => {
      fm.audit.verdict = "pass";
      fm.audit.criteria = [{ criterion: "forged", status: "pass", evidence: "not a review" }];
      delete fm.audit.review;
      delete fm.audit.coverage;
    },
    (fm) => {
      delete fm.review;
    },
    (fm) => {
      fm.evidence.e2e = "invalid";
    },
    (fm) => {
      fm.status = "done";
    },
  ]) {
    f.write("docs/specs/S1.md", baseline);
    f.update(mutate);
    assert.equal((await checkCI(f.root, change)).pass, false);
  }
  f.write("docs/specs/S1.md", baseline);
  const rawFile = privateJob(f, f.spec().frontmatter.audit.review.job_id, "stdout.txt");
  fs.appendFileSync(rawFile, "tamper");
  assert.equal((await checkCI(f.root, change)).pass, false);
});

test("repair checking never masks a real project gate failure", async (t) => {
  const f = deliveryFixture(t);
  await f.implement();
  f.write(
    ".spec-flow.json",
    JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [{ name: "failing-test", argv: ["node", "-e", "process.exit(7)"] }],
      },
    }),
  );
  const result = f.cli("verify", "--for-change");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /failing-test/);
});

test("context current/committed boundaries identify missing, ignored, symlink and directory", async (t) => {
  const f = deliveryFixture(t, { context_files: ["context/new.txt"] });
  f.write("context/new.txt", "not committed\n");
  await f.implement();
  const prepared = await prepareAudit(f.root, "S1");
  assert.equal(prepared.modelInvoked, false);
  assert.ok(fs.readFileSync(prepared.packetPath, "utf8").includes("not committed"));
  // Commit the contract, not its declared context. A committed review cannot fall back to current bytes.
  f.git("add", "docs/specs/S1.md");
  f.git("commit", "-qm", "context declaration only");
  await assert.rejects(
    review(f.root, {
      id: "S1",
      base: f.git("rev-parse", "HEAD~1"),
      head: "HEAD",
      allowDirty: true,
    }),
    (e) => e.diagnostic?.reason === "not-at-head" && e.diagnostic.path === "context/new.txt",
  );
  fs.unlinkSync(path.join(f.root, "context/new.txt"));
  await assert.rejects(
    review(f.root, { mode: "proposal", id: "S1" }),
    (e) => e.diagnostic?.reason === "missing",
  );
  fs.symlinkSync("../code.txt", path.join(f.root, "context/new.txt"));
  await assert.rejects(
    review(f.root, { mode: "proposal", id: "S1" }),
    (e) => e.diagnostic?.reason === "symlink",
  );
  fs.unlinkSync(path.join(f.root, "context/new.txt"));
  fs.mkdirSync(path.join(f.root, "context/new.txt"));
  await assert.rejects(
    review(f.root, { mode: "proposal", id: "S1" }),
    (e) => e.diagnostic?.reason === "nonregular",
  );
  fs.rmSync(path.join(f.root, "context"), { recursive: true });
  fs.symlinkSync("docs", path.join(f.root, "context"));
  f.update((fm) => {
    fm.review_inputs.context_files = ["context/specs/S1.md"];
  });
  await assert.rejects(
    review(f.root, { mode: "proposal", id: "S1" }),
    (e) => e.diagnostic?.reason === "symlink",
  );
});

test("context limits have exact bytes, largest contributors, invalid UTF-8 offset and no source echo", async (t) => {
  const f = deliveryFixture(t, {
    context_files: ["a.txt"],
    context_limits: { max_file_bytes: 10, max_total_bytes: 20 },
  });
  f.write("a.txt", "PRIVATE-BODY");
  await assert.rejects(review(f.root, { mode: "proposal", id: "S1" }), (e) => {
    assert.equal(e.diagnostic.actual, 12);
    assert.equal(e.diagnostic.excess, 2);
    assert.doesNotMatch(JSON.stringify(e.diagnostic), /PRIVATE-BODY/);
    return true;
  });
  f.update((fm) => {
    fm.review_inputs = {
      context_files: ["a.txt", "b.txt", "c.txt"],
      context_limits: { max_file_bytes: 10, max_total_bytes: 20 },
    };
  });
  for (const name of ["a.txt", "b.txt", "c.txt"]) f.write(name, "x".repeat(8));
  await assert.rejects(review(f.root, { mode: "proposal", id: "S1" }), (e) => {
    assert.equal(e.diagnostic.actual, 24);
    assert.equal(e.diagnostic.excess, 4);
    assert.equal(e.diagnostic.largest.length, 3);
    return true;
  });
  f.update((fm) => {
    fm.review_inputs = { context_files: ["a.txt"] };
  });
  f.write(
    "a.txt",
    Buffer.concat([Buffer.from("中文"), Buffer.from([0xff]), Buffer.from("hidden body")]),
  );
  await assert.rejects(review(f.root, { mode: "proposal", id: "S1" }), (e) => {
    assert.equal(e.diagnostic.byteOffset, 6);
    assert.doesNotMatch(JSON.stringify(e.diagnostic), /hidden body/);
    return true;
  });
});

test("context policy validates boundaries, applies to all modes, and is sealed against tampering", async (t) => {
  assert.deepEqual(resolveContextLimits(), DEFAULT_CONTEXT_LIMITS);
  assert.equal(
    resolveContextLimits({ max_files: 100, max_file_bytes: 1048576, max_total_bytes: 8388608 })
      .max_files,
    100,
  );
  for (const policy of [
    null,
    [],
    { unknown: 1 },
    { max_files: 0 },
    { max_files: 101 },
    { max_files: 1.5 },
    { max_file_bytes: 1048577 },
    { max_file_bytes: 10, max_total_bytes: 9 },
    { max_total_bytes: 8388609 },
  ])
    assert.throws(() => resolveContextLimits(policy));
  const f = deliveryFixture(t, {
    context_files: ["large.txt"],
    context_limits: { max_file_bytes: 70000, max_total_bytes: 70000 },
  });
  f.write("large.txt", "x".repeat(70000));
  await f.implement();
  const current = await prepareAudit(f.root, "S1", { maxBytes: 1048576 });
  assert.equal(current.modelInvoked, false);
  const base = f.git("rev-parse", "HEAD");
  f.git("add", ".");
  f.git("commit", "-qm", "context extension");
  const committed = await review(f.root, { id: "S1", base, head: "HEAD", maxBytes: 1048576 });
  const data = packetData(fs.readFileSync(committed.packetPath, "utf8"));
  assert.equal(data.source_context[0].content.length, 70000);
  f.update((fm) => {
    fm.review_inputs.context_limits.max_file_bytes = 1;
  });
  assert.equal(
    (await review(f.root, { action: "status", jobId: committed.jobId })).state,
    "prepared",
  );
  const file = privateJob(f, committed.jobId),
    job = JSON.parse(fs.readFileSync(file));
  job.bindings.context_limits.max_file_bytes++;
  fs.writeFileSync(file, JSON.stringify(job));
  await assert.rejects(
    review(f.root, { action: "status", jobId: committed.jobId }),
    /context|binding|metadata/i,
  );
});

test("330-unit valid synthetic FAIL is mechanical capacity only; telemetry never upgrades it", () => {
  const index = buildReviewIndex(
    [
      "- [ ] [A1] Synthetic acceptance",
      ...Array.from({ length: 329 }, (_, i) => `Source paragraph ${i}`),
    ].join("\n\n"),
  );
  assert.equal(index.units.length, 330);
  const raw = mechanicalCoverage(
    {
      verdict: "fail",
      criteria: [{ criterion: "candidate", status: "fail", evidence: "synthetic only" }],
      scope_deviations: [],
    },
    { review_index: index },
  );
  const job = {
    result_protocol_version: 3,
    prompt_version: 9,
    coverage_index: index,
    bindings: { review_index_sha256: digest(JSON.stringify(index)) },
    mode: "working-tree-audit",
    prior_findings: [],
  };
  const info = reviewOutputInfo(raw, job);
  assert.equal(info.category, "product-fail");
  assert.equal(info.rawCounts.expectedSourceUnits, 330);
  assert.equal(info.rawCounts.coverage, 330);
  assert.equal(raw.verdict, "fail");
  const telemetry = reviewResponseTelemetry(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "length",
        usage: { output: 19 },
        content: [{ type: "text", text: JSON.stringify(raw) }],
      },
    }),
  );
  assert.equal(telemetry.stopReason, "length");
  assert.equal(telemetry.usage.output, 19);
  assert.match(telemetry.decodePath, /pi-jsonl/);
  assert.equal(reviewResponseTelemetry("{}").stopReason, null);
  assert.equal(reviewResponseTelemetry("{}").usage, null);
});

test("failed real workers retain actual stop telemetry and their own engine identity", async (t) => {
  for (const code of [0, 7]) {
    const f = deliveryFixture(t);
    await f.implement();
    await f.grant();
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "length",
        usage: { input: 3, output: 4 },
        content: [{ type: "text", text: "incomplete fixture output" }],
      },
    };
    f.write(
      ".git/fake.mjs",
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(event))});process.exit(${code});\n`,
    );
    const run = f.cli("audit", "S1", "--budget", "fixture");
    assert.equal(run.status, 1, run.stdout);
    const jobId = f.spec().frontmatter.audit.review.job_id;
    const job = JSON.parse(fs.readFileSync(privateJob(f, jobId)));
    assert.equal(job.state, "failed");
    assert.equal(job.worker_engine.version, engineIdentity().version);
    assert.equal(job.worker_engine.source_sha256, engineIdentity().source_sha256);
    assert.deepEqual(job.output_telemetry, {
      decodePath: "pi-jsonl/message_end/parseVerdictJson",
      stopReason: "length",
      usage: { input: 3, output: 4 },
    });
    assert.equal(job.raw_sha256, digest(fs.readFileSync(privateJob(f, jobId, "stdout.txt"))));
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(f.root, ".git/spec-flow/review-v1/budgets/fixture.json")),
      ).used,
      1,
    );
  }
});

test("engine identity is startup-bound, comparable to CLI, and not a hot-reload claim", (t) => {
  const f = deliveryFixture(t),
    actual = JSON.parse(f.cli("identity").stdout),
    identity = engineIdentity();
  assert.equal(actual.source_sha256, identity.source_sha256);
  assert.equal(actual.version, identity.version);
  const source = fileURLToPath(new URL("../src/engine-identity.mjs", import.meta.url));
  f.write("identity/src/engine-identity.mjs", fs.readFileSync(source));
  f.write("identity/src/other.mjs", "export const before=1;\n");
  f.write("identity/package.json", JSON.stringify({ name: "fixture", version: "0.4.0" }));
  const script = `import {engineIdentity} from './identity/src/engine-identity.mjs'; import fs from 'node:fs'; const before=engineIdentity(); fs.appendFileSync('identity/src/other.mjs','//changed'); console.log(JSON.stringify({before,after:engineIdentity()}));`;
  const old = JSON.parse(
    spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: f.root,
      encoding: "utf8",
    }).stdout,
  );
  assert.deepEqual(old.after, old.before);
  const fresh = JSON.parse(
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {engineIdentity} from './identity/src/engine-identity.mjs';console.log(JSON.stringify(engineIdentity()))",
      ],
      { cwd: f.root, encoding: "utf8" },
    ).stdout,
  );
  assert.notEqual(fresh.source_sha256, old.before.source_sha256);
});

test("snapshot drift explains add/delete/content/type/execute mode and tracked ignored artifacts", async (t) => {
  const f = deliveryFixture(t);
  for (const file of ["delete.txt", "modify.txt", "type.txt", "exec.txt"])
    f.write(file, "before\n");
  f.write("dist/tracked.js", "before\n");
  f.git("add", "-f", "dist/tracked.js");
  f.git("add", ".");
  f.git("commit", "-qm", "baseline files");
  await f.implement();
  const baseline = f.spec().frontmatter.impl.snapshot_hash;
  f.write("dist/ignored.js", "ignored\n");
  assert.equal(
    (await repositorySnapshotHash(f.root, { excludePaths: [f.spec().path] })).hash,
    baseline,
  );
  fs.unlinkSync(path.join(f.root, "delete.txt"));
  f.write("added.txt", "new\n");
  f.write("modify.txt", "modified\n");
  fs.chmodSync(path.join(f.root, "exec.txt"), 0o755);
  fs.unlinkSync(path.join(f.root, "type.txt"));
  fs.symlinkSync("code.txt", path.join(f.root, "type.txt"));
  f.write("dist/tracked.js", "tracked changed\n");
  const board = await inspectBoard(f.root, { live: true, id: "S1" }),
    drift = board.specs[0].drift;
  assert.equal(board.specs[0].fresh, false);
  assert.deepEqual(Object.fromEntries(drift.changes.map((item) => [item.path, item.change])), {
    "added.txt": "added",
    "delete.txt": "deleted",
    "dist/tracked.js": "modified",
    "exec.txt": "mode-changed",
    "modify.txt": "modified",
    "type.txt": "type-changed",
  });
  await assert.rejects(prepareAudit(f.root, "S1"), (e) => e.diagnostic.drift.total === 6);
  const reference = f.spec().frontmatter.impl.snapshot_manifest;
  fs.appendFileSync(
    path.join(f.root, ".git/spec-flow/snapshots-v1", `${reference.sha256}.json`),
    "tampered",
  );
  const untrusted = (await inspectBoard(f.root, { live: true, id: "S1" })).specs[0];
  assert.equal(untrusted.fresh, false);
  assert.equal(untrusted.drift.available, false);
  f.update((fm) => {
    delete fm.impl.snapshot_manifest;
  });
  const legacy = (await inspectBoard(f.root, { live: true, id: "S1" })).specs[0];
  assert.equal(legacy.fresh, false);
  assert.match(legacy.drift.reason, /legacy/);
});

test("capture cannot mistake signal termination for an expected test failure", async (t) => {
  const f = deliveryFixture(t);
  const result = await captureEvidence(f.root, {
    id: "S1",
    label: "signal",
    expect: "fail",
    output: "evidence/signal.json",
    argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
  });
  assert.equal(result.expectedMatched, false);
  assert.equal(result.complete, false);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, result.path)));
  assert.equal(record.exitSignal, "SIGTERM");
  assert.equal(record.exitCode, null);
});

test("capture observes and explicitly binds both contract revisions", async (t) => {
  const f = deliveryFixture(t);
  const result = await captureEvidence(f.root, {
    id: "S1",
    label: "contract",
    expect: "pass",
    output: "evidence/contract.json",
    argv: [
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync('docs/specs/S1.md', '\\n- [ ] added contract promise\\n')",
    ],
  });
  assert.equal(result.expectedMatched, false);
  assert.equal(result.stable, false);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, result.path)));
  assert.match(record.contract_sha256_after, /^[a-f0-9]{64}$/);
  assert.notEqual(record.contract_sha256, record.contract_sha256_after);
});

test("capture preserves binary bytes, records spawn errors and refuses replaced output paths", async (t) => {
  const f = deliveryFixture(t);
  const input = {
    id: "S1",
    label: "bytes",
    expect: "pass",
    output: "evidence/bytes.json",
    argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([255,0]))"],
  };
  const binary = await captureEvidence(f.root, input);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, binary.path)));
  assert.equal(record.stdout.encoding, "base64");
  assert.deepEqual(Buffer.from(record.stdout.data, "base64"), Buffer.from([255, 0]));
  assert.equal(record.stdout.sha256, digest(Buffer.from([255, 0])));
  const missing = await captureEvidence(f.root, {
    ...input,
    output: "evidence/missing.json",
    argv: [path.join(f.root, "no-executable")],
  });
  assert.equal(missing.expectedMatched, false);
  assert.equal(missing.complete, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, missing.path))).executionError,
    "ENOENT",
  );
  for (const output of [".GIT/test.json", "NODE_MODULES/test.json", "control\u007f.json"])
    await assert.rejects(captureEvidence(f.root, { ...input, output }), /safe repository-relative/);
  await assert.rejects(
    captureEvidence(f.root, {
      ...input,
      output: "evidence/swapped.json",
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');fs.unlinkSync('evidence/swapped.json');fs.writeFileSync('evidence/swapped.json','replacement')",
      ],
    }),
    /path changed/,
  );
  assert.equal(fs.readFileSync(path.join(f.root, "evidence/swapped.json"), "utf8"), "replacement");
});

test("capture records actual red/green, mismatches and failure boundaries without lifecycle edits", async (t) => {
  const f = deliveryFixture(t);
  await f.implement();
  await f.grant();
  const spec = fs.readFileSync(f.spec().path),
    grantFile = path.join(f.root, ".git/spec-flow/review-v1/budgets/fixture.json"),
    grant = fs.readFileSync(grantFile);
  const cases = [
    ["red", "fail", "console.error('intentional failure');process.exit(1)", {}, true],
    ["green", "pass", "console.log('actual pass')", {}, true],
    ["mismatch", "fail", "process.exit(0)", {}, false],
    ["timeout", "fail", "setTimeout(()=>{},10000)", { timeoutMs: 100 }, false],
    [
      "truncated",
      "fail",
      "console.log('x'.repeat(10000));process.exit(1)",
      { maxOutputBytes: 32 },
      false,
    ],
    ["drift", "pass", "require('node:fs').appendFileSync('code.txt','changed')", {}, false],
  ];
  for (const [label, expect, command, limits, matched] of cases) {
    const result = await captureEvidence(f.root, {
      id: "S1",
      label,
      expect,
      kind: "observation",
      output: `evidence/${label}.json`,
      argv: [process.execPath, "-e", command],
      ...limits,
    });
    assert.equal(result.expectedMatched, matched, label);
    const data = JSON.parse(fs.readFileSync(path.join(f.root, result.path)));
    assert.equal(data.expectedMatched, matched);
    assert.match(data.provenanceBoundary, /not proof of historical red-first/);
    assert.equal(typeof data.stdout.sha256, "string");
  }
  assert.deepEqual(fs.readFileSync(f.spec().path), spec);
  assert.deepEqual(fs.readFileSync(grantFile), grant);
  const input = {
    id: "S1",
    label: "unsafe",
    expect: "pass",
    argv: [process.execPath, "-e", "process.exit(0)"],
  };
  for (const output of [
    "../outside.json",
    "/tmp/outside.json",
    ".git/capture.json",
    "evidence/green.json",
  ])
    await assert.rejects(captureEvidence(f.root, { ...input, output }));
  fs.symlinkSync("evidence", path.join(f.root, "link"));
  await assert.rejects(
    captureEvidence(f.root, { ...input, output: "link/unsafe.json" }),
    /symlink/,
  );
  fs.symlinkSync("green.json", path.join(f.root, "evidence/link.json"));
  await assert.rejects(captureEvidence(f.root, { ...input, output: "evidence/link.json" }));
  const secret = `AKIA${"A".repeat(16)}`;
  await assert.rejects(
    captureEvidence(f.root, {
      ...input,
      output: "evidence/secret.json",
      argv: [process.execPath, "-e", `console.log(${JSON.stringify(secret)})`],
    }),
    /sensitive/,
  );
  assert.equal(fs.existsSync(path.join(f.root, "evidence/secret.json")), false);
});
