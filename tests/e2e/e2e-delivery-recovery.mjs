// S21 real CLI + exact Action check step. Isolated fake reviewer, no provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CLI, deliveryFixture } from "../helpers/delivery-fixture.mjs";

const cleanup = [],
  f = deliveryFixture({
    after(fn) {
      cleanup.push(fn);
    },
  });
const action = yaml.load(fs.readFileSync(new URL("../../action.yml", import.meta.url), "utf8"));
const actionCheck = (purpose) =>
  spawnSync("bash", ["-e", "-c", action.runs.steps[1].run], {
    cwd: f.root,
    env: { ...f.env, SPECFLOW_CLI: CLI, SPECFLOW_CHECK_PURPOSE: purpose },
    encoding: "utf8",
    timeout: 60000,
  });
try {
  await f.implement();
  await f.grant();
  assert.equal(f.cli("audit", "S1", "--budget", "fixture").status, 1);
  assert.equal(fs.readFileSync(path.join(f.root, ".git/calls.txt"), "utf8"), "call\n");
  const saved = fs.readFileSync(f.spec().path);
  assert.equal(f.cli("check", "--ci", "--contracts-only").status, 1);
  assert.equal(f.cli("check", "--ci", "--contracts-only", "--for-change").status, 0);
  assert.equal(actionCheck(action.inputs.purpose.default).status, 1);
  const repaired = actionCheck("change");
  assert.equal(repaired.status, 0, repaired.stderr + repaired.stdout);
  assert.match(repaired.stdout, /不是关闭验收/);
  assert.deepEqual(fs.readFileSync(f.spec().path), saved);
  assert.equal(actionCheck("change; touch injected").status, 2);
  assert.equal(fs.existsSync(path.join(f.root, "injected")), false);
  console.log(
    "PASS explicit CLI budget invokes one synthetic worker; default strict and Action change remain distinct",
  );
  f.write("code.txt", "repair in progress\n");
  assert.equal(f.cli("check", "--ci", "--contracts-only", "--live").status, 1);
  assert.equal(f.cli("check", "--ci", "--contracts-only", "--live", "--for-change").status, 0);
  assert.notEqual(f.cli("done", "S1").status, 0);
  console.log("PASS stale repair can be checked but never closed");
  await f.implement();
  f.write(
    ".git/result.json",
    JSON.stringify({
      verdict: "fail",
      criteria: [
        {
          kind: "invalid",
          criterion: "candidate",
          status: "fail",
          evidence: "unverified synthetic observation",
        },
      ],
      issues: ["synthetic issue"],
      scope_deviations: [],
    }),
  );
  const protocol = f.cli("audit", "S1", "--budget", "fixture");
  assert.equal(protocol.status, 1);
  assert.match(protocol.stdout, /category=protocol-error/);
  assert.equal(f.spec().frontmatter.audit.output_info.rawCounts.criteria, 1);
  const history = fs.readFileSync(f.spec().path);
  assert.equal(actionCheck("change").status, 0);
  assert.deepEqual(fs.readFileSync(f.spec().path), history);
  console.log(
    "PASS protocol error remains an error with unverified raw observations while repairs stay reachable",
  );
  const capture = f.cli(
    "capture",
    "S1",
    "--label",
    "red",
    "--expect",
    "fail",
    "--kind",
    "historical-replay",
    "--output",
    "evidence/red.json",
    "--",
    process.execPath,
    "-e",
    "console.error('intentional failure');process.exit(1)",
  );
  assert.equal(capture.status, 0, capture.stderr);
  const receipt = JSON.parse(capture.stdout);
  assert.equal(receipt.expectedMatched, true);
  const observation = JSON.parse(fs.readFileSync(path.join(f.root, receipt.path)));
  assert.equal(observation.exitCode, 1);
  assert.match(observation.provenanceBoundary, /not proof of historical red-first/);
  assert.deepEqual(fs.readFileSync(f.spec().path), history);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, ".git/spec-flow/review-v1/budgets/fixture.json")))
      .used,
    2,
  );
  console.log(
    "PASS CLI capture preserves a real failed process without changing Spec or audit budget or certifying history",
  );
  f.write(
    ".spec-flow.json",
    JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [{ name: "product-fail", argv: ["node", "-e", "process.exit(7)"] }],
      },
    }),
  );
  assert.equal(actionCheck("change").status, 1);
  console.log(
    "PASS exact Action change script still rejects a real product gate failure; hosted execution not claimed",
  );
} finally {
  for (const clean of cleanup) clean();
}
