#!/usr/bin/env node
// Produces a local candidate and consumes it outside the checkout, offline.
// No publish, push, tag, provider, global install, or lifecycle state changes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { engineIdentity } from "../../packages/core/src/core.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const core = path.join(root, "packages/core");
const manifest = JSON.parse(fs.readFileSync(path.join(core, "package.json")));
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output), "Provide an absolute local artifact directory");
fs.mkdirSync(output, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-installed-candidate-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (file, args, cwd = sandbox, env = process.env) =>
  execFileSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"))).private, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "packages/pi/package.json"))).private,
    true,
  );
  assert.equal(manifest.private, undefined);
  const [packed] = JSON.parse(
    run(
      npm,
      ["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", output],
      core,
    ),
  );
  const tarball = path.join(output, packed.filename);
  const tarBytes = fs.readFileSync(tarball);
  const unpacked = path.join(sandbox, "unpacked");
  fs.mkdirSync(unpacked);
  run("tar", ["-xzf", tarball, "-C", unpacked]);
  const files = packed.files.map(({ path: name, size, mode }) => {
    assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
    assert.doesNotMatch(name, /(^|\/)(node_modules|docs|tests?|\.git)(\/|$)/);
    const bytes = fs.readFileSync(path.join(unpacked, "package", name));
    assert.deepEqual(
      bytes,
      fs.readFileSync(path.join(core, name)),
      `Tarball differs from source: ${name}`,
    );
    return { path: name, bytes: size, mode, sha256: hash(bytes) };
  });
  const consumer = path.join(sandbox, "consumer outside source");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "offline-candidate-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
    }),
  );
  const install = run(
    npm,
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer,
  );
  const installed = path.join(consumer, "node_modules/@nightink/spec-flow-core");
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  assert.notEqual(fs.realpathSync(installed), fs.realpathSync(core));
  const imported = JSON.parse(
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from 'node:assert/strict';
    const manifest = (await import('@nightink/spec-flow-core/package.json', {with:{type:'json'}})).default;
    const core = await import('@nightink/spec-flow-core');
    for (const name of ['board','prepareAudit','captureEvidence','engineIdentity','inspectBoard','checkCI']) assert.equal(typeof core[name], 'function', name);
    for (const key of Object.keys(manifest.exports)) {
      if (key === './package.json') continue;
      await import('@nightink/spec-flow-core' + (key === '.' ? '' : key.slice(1)));
    }
    console.log(JSON.stringify({exports: Object.keys(manifest.exports), engine: core.engineIdentity()}));
  `,
      ],
      consumer,
    ),
  );
  const bin = path.join(consumer, "node_modules/.bin/spec-flow");
  const identity = JSON.parse(run(bin, ["identity"], consumer));
  assert.equal(identity.version, manifest.version);
  assert.equal(identity.source_sha256, engineIdentity().source_sha256);
  assert.equal(imported.engine.source_sha256, identity.source_sha256);
  run("git", ["init", "-q"], consumer);
  assert.match(run(bin, ["board"], consumer), /no specs found/);
  const dependencies = JSON.parse(run(npm, ["ls", "--omit=dev", "--all", "--json"], consumer));
  const dependencyVersions = {};
  const collectDependencies = (node) => {
    for (const [name, value] of Object.entries(node.dependencies || {})) {
      dependencyVersions[name] = value.version;
      collectDependencies(value);
    }
  };
  collectDependencies(dependencies);
  // Execute the Action's installation and check steps verbatim, offline in a copy.
  // This does not claim a hosted GitHub runner was exercised.
  const actionRoot = path.join(sandbox, "action source");
  fs.mkdirSync(actionRoot);
  for (const file of ["package.json", "package-lock.json", "action.yml"])
    fs.copyFileSync(path.join(root, file), path.join(actionRoot, file));
  for (const name of ["core", "pi"])
    fs.cpSync(path.join(root, "packages", name), path.join(actionRoot, "packages", name), {
      recursive: true,
      filter: (file) => !file.split(path.sep).includes("node_modules"),
    });
  const action = yaml.load(fs.readFileSync(path.join(actionRoot, "action.yml"), "utf8"));
  run("bash", ["-e", "-c", action.runs.steps[0].run], consumer, {
    ...process.env,
    ACTION_ROOT: actionRoot,
    npm_config_offline: "true",
  });
  fs.writeFileSync(
    path.join(consumer, ".spec-flow.json"),
    JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [
          {
            name: "release-fixture",
            argv: [
              "node",
              "-e",
              "require('node:fs').appendFileSync('.git/action-calls', 'gate\\n')",
            ],
          },
        ],
      },
    }),
  );
  let actionGateCalls = 0;
  for (const purpose of ["strict", "change"]) {
    run("bash", ["-e", "-c", action.runs.steps[1].run], consumer, {
      ...process.env,
      SPECFLOW_CLI: path.join(actionRoot, "packages/core/src/core.mjs"),
      SPECFLOW_CHECK_PURPOSE: purpose,
    });
    assert.equal(
      fs.readFileSync(path.join(consumer, ".git/action-calls"), "utf8"),
      "gate\n".repeat(++actionGateCalls),
    );
  }
  const verification = {
    version: 1,
    status: "local-candidate-not-published-not-independent-PASS",
    package: manifest.name,
    packageVersion: manifest.version,
    sourceBase: run("git", ["rev-parse", "HEAD"], root).trim(),
    sourceBoundary:
      "Includes working-tree changes. Match per-file hashes and core source fingerprint; base is not a claim that changes were committed at packaging time.",
    node: process.version,
    npm: run(npm, ["--version"], root).trim(),
    platform: `${process.platform}/${process.arch}`,
    archive: {
      filename: packed.filename,
      bytes: tarBytes.length,
      sha256: hash(tarBytes),
      integrity: packed.integrity,
      shasum: packed.shasum,
      files,
    },
    engine: {
      package: identity.package,
      version: identity.version,
      source_sha256: identity.source_sha256,
    },
    acceptance: {
      offline: true,
      installScripts: false,
      outsideSource: true,
      symlinkedPackage: false,
      binIdentity: true,
      binBoard: true,
      exports: imported.exports,
      installSummary: install.trim(),
      dependencyVersions,
      actionEquivalent: {
        lockedInstall: true,
        installScripts: false,
        offline: true,
        strict: true,
        change: true,
        hostedRunner: false,
      },
    },
    boundaries: [
      "No registry/hosted Action/provider acceptance",
      "Private root/Pi adapter are not npm targets",
      "No push/publish/tag/lifecycle PASS",
    ],
  };
  const report = path.join(output, "manifest.json");
  fs.writeFileSync(report, `${JSON.stringify(verification, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        pass: true,
        tarball,
        manifest: report,
        sha256: hash(tarBytes),
        integrity: packed.integrity,
        exports: imported.exports.length,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
