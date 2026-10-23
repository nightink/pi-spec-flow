import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { deliveryFixture } from "../../../tests/helpers/delivery-fixture.mjs";
import { checkCI, done, prepareAudit } from "../src/core.mjs";
import { reviewInputs } from "../src/review-coverage.mjs";
import { review, reviewOutputInfo } from "../src/review-engine.mjs";

test("CLI audit accepts an explicit existing budget without hiding FAIL", async (t) => {
  const f = deliveryFixture(t);
  await f.implement();
  await f.grant();
  const result = f.cli("audit", "S1", "--budget", "fixture");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /category=product-fail/);
  assert.equal(f.spec().frontmatter.audit.review.state, "completed");
});

test("change check preserves failed audit and permits repairs, not closure", async (t) => {
  const f = deliveryFixture(t);
  await f.implement();
  await f.grant();
  const run = f.cli("audit", "S1");
  assert.equal(run.status, 1);
  const before = fs.readFileSync(f.spec().path);
  assert.equal((await checkCI(f.root, { runProjectGates: false })).pass, false);
  const change = await checkCI(f.root, { runProjectGates: false, forChange: true });
  assert.equal(change.pass, true, change.output);
  assert.match(change.output, /change|修复提交/);
  assert.deepEqual(fs.readFileSync(f.spec().path), before);
  await assert.rejects(done(f.root, "S1"), /未完成/);
  fs.appendFileSync(f.spec().path, "\nContract changed during repair.\n");
  assert.equal((await checkCI(f.root, { runProjectGates: false, forChange: true })).pass, true);
});

test("context ignored source error identifies path and reason", async (t) => {
  const f = deliveryFixture(t, { context_files: ["evidence/run.log"] });
  f.write("evidence/run.log", "ordinary ignored file\n");
  await f.implement();
  await assert.rejects(prepareAudit(f.root, "S1"), (error) => {
    assert.equal(error.diagnostic.path, "evidence/run.log");
    assert.equal(error.diagnostic.reason, "ignored");
    return true;
  });
});

test("context UTF-8 error uses byte offset, not UTF-16 character offset", async (t) => {
  const f = deliveryFixture(t, { context_files: ["evidence/a.txt"] });
  f.write("evidence/a.txt", "中文\uFFFDbad");
  await f.implement();
  await assert.rejects(prepareAudit(f.root, "S1"), (error) => {
    assert.equal(error.diagnostic.path, "evidence/a.txt");
    assert.equal(error.diagnostic.byteOffset, 6);
    return true;
  });
});

test("approved context policy supports >20 files and >128 KiB without truncation", async (t) => {
  const files = Array.from({ length: 21 }, (_, i) => `context/${i}.txt`);
  const f = deliveryFixture(t, {
    context_files: files,
    context_limits: { max_files: 21, max_file_bytes: 10000, max_total_bytes: 210000 },
  });
  for (const file of files) f.write(file, "x".repeat(10000));
  const prepared = await review(f.root, { mode: "proposal", id: "S1", maxBytes: 1048576 });
  assert.equal(prepared.modelInvoked, false);
  assert.equal(prepared.receipt.bindings.context_limits.max_files, 21);
  assert.equal(
    (await review(f.root, { action: "status", jobId: prepared.jobId })).state,
    "prepared",
  );
});

test("context count diagnosis reports actual and limits", () => {
  assert.throws(
    () =>
      reviewInputs({
        review_inputs: { context_files: Array.from({ length: 21 }, (_, i) => `${i}.txt`) },
      }),
    (error) => {
      assert.equal(error.diagnostic.actual, 21);
      assert.equal(error.diagnostic.limit, 20);
      return true;
    },
  );
});

test("zero typed criteria is distinct from missing criteria; observations are not PASS", () => {
  const raw = {
    verdict: "fail",
    criteria: [{ criterion: "real entry", status: "fail", evidence: "candidate finding" }],
    scope_deviations: [],
    findings: [],
    issues: ["candidate contradiction"],
  };
  const job = { result_protocol_version: 3, prompt_version: 9, prior_findings: [] };
  const info = reviewOutputInfo(raw, job);
  assert.equal(info.category, "protocol-error");
  assert.equal(info.rawCounts.criteria, 1);
  assert.equal(info.rawCounts.untypedCriteria, 1);
  assert.equal(info.rawCounts.issues, 1);
  assert.ok(info.observations.every((item) => item.verified === false));
  assert.equal(reviewOutputInfo({ ...raw, criteria: [] }, job).code, "REVIEW_OUTPUT_NO_CRITERIA");
});
