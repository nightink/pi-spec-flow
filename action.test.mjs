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
