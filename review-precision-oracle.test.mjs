// Parent-owned observations for frozen synthetic cases. NOT model accuracy tests.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReviewIndex } from "./packages/core/src/review-coverage.mjs";
import { digest } from "./packages/core/src/review-storage.mjs";

const root = new URL("./tests/fixtures/review-precision/", import.meta.url);
const scenarios = JSON.parse(fs.readFileSync(new URL("scenarios.json", root), "utf8"));
const oracle = JSON.parse(fs.readFileSync(new URL("oracle.json", root), "utf8"));
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));

test("precision oracle: frozen inputs and hidden expected classifications have separate hashes; no provider", () => {
  for (const file of ["scenarios.json", "oracle.json"])
    assert.equal(digest(fs.readFileSync(new URL(file, root))), manifest.sha256[file]);
  assert.equal(scenarios.cases.length, 13);
  assert.deepEqual(scenarios.cases.map((c) => c.id).sort(), Object.keys(oracle.cases).sort());
  assert.equal(new Set(scenarios.cases.map((c) => c.id)).size, 13);
  for (const item of scenarios.cases) {
    assert.equal(Object.hasOwn(item, "category"), false);
    assert.ok(["pass", "product-fail", "coverage-gap"].includes(oracle.cases[item.id].category));
    const body = `# ${item.id}\n\n## Design\n\n- ${item.design}\n\n## Executable acceptance\n\n${item.acceptance.map((text, i) => `- [ ] [A${i + 1}] ${text}`).join("\n")}\n`;
    const index = buildReviewIndex(body);
    assert.equal(index.acceptance_ids.length, item.acceptance.length);
    assert.ok(index.units.some((u) => u.text.includes(item.design)));
    for (const file of item.context_files) assert.ok(Object.hasOwn(item.files, file));
  }
});

test("precision probe: nineteen frozen contrasts prepare production prompts without oracle, labels, execution or provider", (t) => {
  const extra = JSON.parse(fs.readFileSync(new URL("dispositions.json", root), "utf8"));
  const plan = JSON.parse(fs.readFileSync(new URL("probe-plan.json", root), "utf8"));
  const all = [...scenarios.cases, ...extra.cases];
  assert.equal(extra.cases.length, 6);
  for (const [file, hash] of Object.entries(manifest.probe_sha256))
    assert.equal(digest(fs.readFileSync(new URL(file, root))), hash);
  assert.deepEqual(all.map((item) => item.id).sort(), Object.keys(plan.accepted_categories).sort());
  assert.equal(extra.cases.filter((item) => item.harness_approval).length, 1);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-blind-prepare-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.DASHSCOPE_API_KEY;
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./tests/probes/review-precision.mjs", import.meta.url)),
      "prepare",
      tmp,
    ],
    { env },
  );
  const packet = fs.readFileSync(path.join(tmp, "packet.md"), "utf8");
  for (const item of all)
    assert.equal(packet.includes(item.id), false, "diagnostic labels must not reach model");
  assert.equal(packet.includes("accepted_categories"), false);
  assert.equal(packet.includes("required_semantic_checks"), false);
  const local = JSON.parse(fs.readFileSync(path.join(tmp, "local-map.json"), "utf8"));
  assert.equal(local.length, 19);
  assert.equal(new Set(local.map((item) => item.id)).size, 19);
  assert.ok(local.every((item) => item.job.state === "prepared" && !item.job.model_invoked));
  const frozen = JSON.parse(fs.readFileSync(path.join(tmp, "frozen-inputs.json"), "utf8"));
  assert.equal(digest(packet), frozen.packet_sha256);
  assert.equal(frozen.plan_sha256, digest(fs.readFileSync(new URL("probe-plan.json", root))));
});

for (const item of scenarios.cases) {
  const expected = oracle.cases[item.id].execute;
  if (!expected) continue;
  test(`precision oracle observation (not reviewer verdict): ${item.id}`, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-oracle-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    for (const [file, source] of Object.entries(item.files)) {
      assert.equal(path.basename(file), file);
      fs.writeFileSync(path.join(tmp, file), source);
    }
    // These are trusted repository-owned fixture modules, never packet-supplied
    // code in production. Product context collection does not import/execute.
    const module = await import(pathToFileURL(path.join(tmp, expected.file)).href);
    assert.deepEqual(module[expected.export](...expected.args), expected.observed);
  });
}
