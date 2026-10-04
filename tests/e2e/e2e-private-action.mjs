#!/usr/bin/env node
/** Exercise the private Action's CLI/verify boundary locally, without GitHub or network. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const source = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-private-action-e2e-"));
const action = path.join(root, "action");
const project = path.join(root, "caller");
fs.mkdirSync(action);
fs.mkdirSync(path.join(project, "specs"), { recursive: true });
function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
try {
  // The real Action installs its locked dependencies in its own checkout. Tests
  // reuse this repository's *already installed* deps to stay offline; this still
  // runs the copied CLI from outside both source and caller, never a Pi global path.
  for (const name of ["core.mjs", "project-profile.mjs", "workspace.mjs"]) {
    fs.copyFileSync(path.join(source, name), path.join(action, name));
  }
  fs.symlinkSync(path.join(source, "node_modules"), path.join(action, "node_modules"), "dir");
  const cli = path.join(action, "core.mjs");
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    type: "module", scripts: { verify: "node verify.mjs" },
  }));
  fs.writeFileSync(path.join(project, ".spec-flow.json"), JSON.stringify({
    version: 1,
    lifecycle: {
      preReview: ["draft"], startable: ["approved"], active: "in-progress", done: "done",
      ignored: ["archived"], dependenciesField: "depends_on", updatedField: "updated",
      bodyStatusLine: false, legacyActive: "error", externalActiveIds: [],
      approval: { reviewersField: "reviewers", reviewedAtField: "reviewed_at",
        minimumReviewers: 1, placeholderReviewers: [] },
    },
    gates: { mode: "replace", npmScripts: ["verify"] },
    validation: {
      requiredFields: ["id", "title", "kind", "status", "created", "updated", "author", "depends_on"],
      kindField: "kind", allowedKinds: ["spec"], numericFileId: true,
      checkDoneCheckboxes: true, forbidAddendumFilename: true, dependencyIntegrity: true,
    },
  }));
  const specPath = path.join(project, "specs", "0.example.md");
  const validSpec = "---\nid: 0\ntitle: Example\nkind: spec\nstatus: done\ncreated: '2026-09-26'\nupdated: '2026-09-26'\nauthor: agent\ndepends_on: []\n---\n\n- [x] accepted\n";
  fs.writeFileSync(specPath, validSpec);
  fs.writeFileSync(path.join(project, "verify.mjs"), `import fs from 'node:fs';import {execFileSync} from 'node:child_process';fs.appendFileSync('gate-marker','verify\\n');execFileSync(process.execPath,[process.env.SPECFLOW_CLI,'check','--ci','--contracts-only'],{stdio:'inherit'});console.log('VERDICT: PASS');\n`);
  const env = { ...process.env, SPECFLOW_CLI: cli };
  const check = run(process.execPath, [cli, "check", "--ci", "--contracts-only"], project, env);
  assert(check.includes("项目门禁未运行"), `contracts-only must disclose omitted gates: ${check}`);
  assert(!fs.existsSync(path.join(project, "gate-marker")), "contracts-only ran the gate");
  assert(run(process.execPath, [cli, "verify"], project, env).includes("check --ci 通过"), "configured Action verify did not finish");
  assert(fs.readFileSync(path.join(project, "gate-marker"), "utf8") === "verify\n", "recursive verify detected");
  console.log("PASS private Action-equivalent subprocess chain invokes caller verify once");
  fs.unlinkSync(path.join(project, ".spec-flow.json"));
  fs.unlinkSync(path.join(project, "gate-marker"));
  assert(run(process.execPath, [cli, "verify"], project, env).includes("check --ci 通过"), "no-profile verify fallback failed");
  assert(fs.readFileSync(path.join(project, "gate-marker"), "utf8") === "verify\n", "no-profile verify entrypoint lost or repeated");
  console.log("PASS private Action preserves unconfigured verify-only callers");
  // Restore the configured metadata rules for the negative document path.
  fs.writeFileSync(path.join(project, ".spec-flow.json"), JSON.stringify({version:1, gates:{mode:"replace",npmScripts:["verify"]},
    validation:{requiredFields:["id","title","kind","status"],kindField:"kind",allowedKinds:["spec"],numericFileId:true,checkDoneCheckboxes:true,forbidAddendumFilename:true,dependencyIntegrity:false}}));

  fs.writeFileSync(specPath, validSpec.replace("- [x]", "- [ ]"));
  let rejected = false;
  try { run(process.execPath, [cli, "check", "--ci", "--contracts-only"], project, env); }
  catch { rejected = true; }
  assert(rejected, "invalid done checkbox was accepted");
  fs.unlinkSync(path.join(project, "gate-marker"));
  // Exercise the actual composite Action entrypoint, not only its standalone
  // contracts-only helper: a bad document must stop before the caller gate.
  rejected = false;
  try { run(process.execPath, [cli, "verify"], project, env); }
  catch { rejected = true; }
  assert(rejected, "Action verify accepted an invalid caller Spec");
  assert(!fs.existsSync(path.join(project, "gate-marker")), "invalid contracts executed caller gate");
  console.log("PASS private Action-equivalent chain fails closed before gates on invalid caller Spec");

  fs.writeFileSync(specPath, validSpec);
  const profilePath = path.join(project, ".spec-flow.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  fs.writeFileSync(profilePath, JSON.stringify({ ...profile, validation: { ...profile.validation, unknown: true } }));
  rejected = false;
  try { run(process.execPath, [cli, "verify"], project, env); }
  catch { rejected = true; }
  assert(rejected, "Action verify accepted an unknown validation key");
  assert(!fs.existsSync(path.join(project, "gate-marker")), "invalid profile executed caller gate");
  console.log("PASS private Action-equivalent chain rejects malformed profile before gates");

  fs.writeFileSync(profilePath, JSON.stringify(profile));
  fs.writeFileSync(path.join(project, "verify.mjs"), "import fs from 'node:fs';fs.appendFileSync('gate-marker','failed-verify\\n');process.exit(7);\n");
  rejected = false;
  try { run(process.execPath, [cli, "verify"], project, env); }
  catch { rejected = true; }
  assert(rejected, "Action verify ignored failed caller product gate");
  assert(fs.readFileSync(path.join(project, "gate-marker"), "utf8") === "failed-verify\n", "failed gate entrypoint repeated or never ran");
  console.log("PASS private Action-equivalent chain propagates failed caller gate exactly once");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
