// Static package-boundary contract for the monorepo split. These assertions are
// bound by the normal check gate; real-host runtime loading is recorded by the
// opt-in smoke suite and remains a runtime fact.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

test("root is a private workspace whose pi manifest points at packages/pi", () => {
  const manifest = json("package.json");
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.workspaces, ["packages/*"]);
  assert.deepEqual(manifest.pi.extensions, ["./packages/pi/index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./packages/pi/skills"]);
  for (const entry of [...manifest.pi.extensions, ...manifest.pi.skills]) {
    assert.ok(fs.existsSync(path.join(root, entry)), `root pi path missing: ${entry}`);
  }
  assert.ok(fs.existsSync(path.join(root, "packages/pi/skills/autonomous-delivery/SKILL.md")));
  for (const shim of ["core.mjs", "index.ts", "adapter-core.mjs", "skills"]) {
    assert.equal(fs.existsSync(path.join(root, shim)), false, `stale root shim: ${shim}`);
  }
});

test("packages/core is publish-ready and harness-free", () => {
  const manifest = json("packages/core/package.json");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.name, "@nightink/spec-flow-core");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.deepEqual(manifest.bin, { "spec-flow": "./src/core.mjs" });
  assert.deepEqual(manifest.dependencies, { "js-yaml": "^4.3.2" });
  assert.equal(manifest.peerDependencies, undefined);
  for (const target of Object.values(manifest.exports)) {
    assert.ok(fs.existsSync(path.join(root, "packages/core", target)), `missing export: ${target}`);
  }
  assert.ok(manifest.files.includes("src"));
  assert.ok(manifest.files.includes("templates"));
  assert.ok(manifest.files.includes("README.md"));
  assert.ok(read("packages/core/src/core.mjs").startsWith("#!/usr/bin/env node"));
});

test("packages/pi depends on core by semver and keeps host SDKs as optional peers", () => {
  const manifest = json("packages/pi/package.json");
  assert.equal(manifest.dependencies["@nightink/spec-flow-core"], "^0.3.0");
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    typebox: "*",
  });
  assert.deepEqual(manifest.peerDependenciesMeta, {
    "@earendil-works/pi-coding-agent": { optional: true },
    typebox: { optional: true },
  });
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(fs.existsSync(path.join(root, "packages/pi/index.ts")));
});

test("action.yml pins an existing packages/core CLI path", () => {
  const match = read("action.yml").match(
    /SPECFLOW_CLI:\s*\$\{\{\s*github\.action_path\s*\}\}\/(\S+)/,
  );
  assert.ok(match, "action.yml must declare SPECFLOW_CLI with github.action_path");
  assert.equal(match[1], "packages/core/src/core.mjs");
  assert.ok(fs.existsSync(path.join(root, match[1])));
});

test("only the reference executor may own harness SDKs or CLI flags", () => {
  const reference = "packages/core/src/executors/pi-cli.mjs";
  const forbidden = [
    "@earendil-works",
    "typebox",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
    "PI_SESSION_FILE",
    "PI_REASONING_LEVEL",
    "SPECFLOW_PI_CLI",
  ];
  for (const file of filesUnder("packages/core/src")) {
    if (file === reference) continue;
    const content = read(file);
    for (const token of forbidden) {
      assert.equal(content.includes(token), false, `${file} leaks harness token ${token}`);
    }
  }
  assert.ok(fs.existsSync(path.join(root, reference)));
});
