import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import yaml from "js-yaml";

test("private cross-repository Action is composite, installs pinned deps, and runs caller verify", () => {
  const action = yaml.load(fs.readFileSync(new URL("./action.yml", import.meta.url), "utf8"));
  assert.equal(action.runs.using, "composite");
  const [install, verify] = action.runs.steps;
  assert.match(install.run, /cd "\$ACTION_ROOT" && npm ci/);
  assert.match(install.run, /--ignore-scripts/);
  assert.doesNotMatch(install.run, /\$\{\{\s*secrets\./);
  assert.equal(verify.env.SPECFLOW_CLI, "${{ github.action_path }}/core.mjs");
  assert.equal(verify.run, 'node "$SPECFLOW_CLI" verify');
  assert.doesNotMatch(verify.run, /npm run verify/);
  assert.doesNotMatch(JSON.stringify(action), /secrets\.|actions\/checkout|git push|npm publish|deploy/i);
  assert.ok(fs.existsSync(new URL("./package-lock.json", import.meta.url)));
});

test("self CI statically selects supported Node, Python and the entire authoritative gate", () => {
  // A local YAML/command contract check is not evidence of a successful hosted
  // run. In particular it cannot diagnose a zero-job startup_failure remotely.
  const workflow = yaml.load(fs.readFileSync(new URL("./.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const steps = workflow.jobs.verify.steps;
  const node = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  const python = steps.find((step) => step.uses?.startsWith("actions/setup-python@"));
  assert.equal(node.with["node-version"], "22.19.0");
  assert.equal(python.with["python-version"], "3.11");
  assert.deepEqual(steps.filter((step) => step.run).map((step) => step.run), ["npm ci", "npm run check", "npm audit --omit=dev"]);
  const profile = JSON.parse(fs.readFileSync(new URL("./.spec-flow.json", import.meta.url), "utf8"));
  assert.deepEqual(profile.gates, { mode: "replace", npmScripts: ["check"] });
});
