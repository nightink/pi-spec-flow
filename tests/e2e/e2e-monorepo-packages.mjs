#!/usr/bin/env node
// Offline package-boundary acceptance: workspace links, the spec-flow bin and
// npm pack contents. No registry access, publish, provider or project install.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const coreDir = path.join(root, "packages", "core");
const piDir = path.join(root, "packages", "pi");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-monorepo-packages-"));
const fixture = path.join(sandbox, "fixture project");
const coreLink = path.join(root, "node_modules", "@nightink", "spec-flow-core");
const bin = path.join(root, "node_modules", ".bin", "spec-flow");

function real(file) {
  return fs.realpathSync(file);
}

try {
  fs.mkdirSync(fixture, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: fixture });

  // A1: npm workspaces link the core package and expose its bin offline.
  assert.ok(fs.existsSync(coreLink), "workspace link missing; run npm install");
  assert.equal(real(coreLink), real(coreDir));
  assert.ok(fs.existsSync(bin), "workspace bin missing; run npm install");
  const linked = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import('@nightink/spec-flow-core').then((m) => { if (typeof m.board !== 'function') process.exit(2); })",
    ],
    { cwd: piDir, encoding: "utf8" },
  );
  assert.equal(linked.status, 0, linked.stderr);
  const viaBin = spawnSync(bin, ["board"], { cwd: fixture, encoding: "utf8" });
  assert.equal(viaBin.status, 0, viaBin.stderr);
  assert.match(viaBin.stdout, /no specs found/);
  console.log("PASS workspace link, package-name import from packages/pi and spec-flow bin board");

  // A2: source CLI still runs and npm pack ships only the published surface.
  const source = spawnSync(process.execPath, [path.join(coreDir, "src", "core.mjs"), "board"], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.equal(source.status, 0, source.stderr);
  assert.match(source.stdout, /no specs found/);
  const packed = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: coreDir, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout);
  assert.equal(manifest.name, "@nightink/spec-flow-core");
  const files = new Set(manifest.files.map((entry) => entry.path));
  for (const required of [
    "package.json",
    "README.md",
    "src/core.mjs",
    "src/review-executor.mjs",
    "src/executors/pi-cli.mjs",
    "src/review-worker.mjs",
    "templates/spec-v2.md",
  ]) {
    assert.ok(files.has(required), `packed tarball misses ${required}`);
  }
  for (const entry of files) {
    assert.doesNotMatch(entry, /(^|\/)(node_modules|docs|tests?|\.git)(\/|$)/);
    assert.doesNotMatch(entry, /\.test\./);
    assert.doesNotMatch(entry, /^index\.ts$/);
  }
  const coreManifest = JSON.parse(fs.readFileSync(path.join(coreDir, "package.json"), "utf8"));
  assert.equal(coreManifest.private, undefined);
  assert.deepEqual(coreManifest.bin, { "spec-flow": "./src/core.mjs" });
  assert.equal(coreManifest.dependencies["@earendil-works/pi-coding-agent"], undefined);
  assert.equal(coreManifest.dependencies.typebox, undefined);
  assert.equal(coreManifest.publishConfig.access, "public");
  console.log("PASS source CLI, npm pack surface and publish-ready core metadata");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
