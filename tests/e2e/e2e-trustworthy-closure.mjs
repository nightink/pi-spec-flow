// S1.2 real CLI/subprocess acceptance: evidence cannot disappear into empty sets,
// the auditor is isolated, and terminal closure is hash/criteria bound.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadSpecs,
  parseFrontmatter,
  writeFrontmatter,
} from "../../core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, "../../core.mjs");
let failures = 0;

function check(condition, label) {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}`);
  }
}

function write(root, relative, content, options) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, options);
  return file;
}

function spec(id, { evidence = {}, scope } = {}) {
  return writeFrontmatter(
    `# ${id}\n\n- 状态：已批准\n\n## 验收标准\n\n- implementation is complete\n`,
    {
      id,
      status: "approved",
      review: { decision: "approved" },
      evidence: { human: [], ...evidence },
      ...(scope ? { scope } : {}),
    }
  );
}

function init(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=spec-flow-e2e",
      "-c",
      "user.email=spec-flow@example.invalid",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: root }
  );
}

function cli(root, ...args) {
  return spawnSync(process.execPath, [core, ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-closure-e2e-"));
try {
  // Scenario 1: invalid/missing E2E plus migration conflict persist as explicit FAIL.
  const evidenceRepo = path.join(sandbox, "evidence");
  fs.mkdirSync(evidenceRepo, { recursive: true });
  const marker = path.join(sandbox, "escape-marker");
  write(
    evidenceRepo,
    "docs/specs/S1.md",
    spec("S1", { evidence: { e2e: ["../escape", "e2e-missing"], migrations: [1] } })
  );
  write(
    evidenceRepo,
    "docs/specs/S2.md",
    spec("S2", { evidence: { migrations: [1] } })
  );
  write(
    evidenceRepo,
    "tests/escape.mjs",
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "executed"); console.log("PASS escaped");\n`
  );
  write(evidenceRepo, "packages/db/src/migrations/001-conflict.ts", "export {};\n");
  init(evidenceRepo);

  check(cli(evidenceRepo, "begin", "S1").status === 0, "CLI begin migrates approved spec to workflow v2");
  const failedImpl = cli(evidenceRepo, "impl", "S1");
  check(
    failedImpl.status === 0 && /❌ FAIL/.test(failedImpl.stdout),
    "CLI impl reports non-passing evidence instead of an empty success"
  );
  const failedRecord = loadSpecs(evidenceRepo).find((item) => item.frontmatter.id === "S1").frontmatter;
  check(
    failedRecord.impl.pass === false &&
      failedRecord.impl.e2e["../escape"].pass === false &&
      failedRecord.impl.e2e["e2e-missing"].pass === false,
    "invalid and missing E2E results are persisted explicitly"
  );
  check(
    failedRecord.impl.migrations.pass === false &&
      failedRecord.impl.migrations.problems[0].conflictWith === "S2",
    "migration conflict is persisted"
  );
  check(!fs.existsSync(marker), "path-traversal E2E was not executed");
  check(cli(evidenceRepo, "done", "S1").status !== 0, "done rejects failed E2E/migration evidence");

  // Scenario 2: real audit child receives isolation flags and complete untracked patch.
  const closureRepo = path.join(sandbox, "closure");
  fs.mkdirSync(closureRepo, { recursive: true });
  write(closureRepo, "docs/specs/S3.md", spec("S3"));
  write(closureRepo, "package.json", JSON.stringify({ scripts: { test: "node -e \"require('node:fs').readFileSync('implementation.txt')\"" } }));
  init(closureRepo);
  check(cli(closureRepo, "begin", "S3").status === 0, "second spec begins");
  write(closureRepo, "implementation.txt", "untracked implementation evidence\n");
  const goodImpl = cli(closureRepo, "impl", "S3");
  check(goodImpl.status === 0 && /✅ PASS/.test(goodImpl.stdout), "clean impl records explicit pass and snapshot");

  const argsFile = path.join(sandbox, "auditor-args.json");
  const promptFile = path.join(sandbox, "auditor-prompt.txt");
  const auditor = write(
    sandbox,
    "fake-auditor.mjs",
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const atFile = args.find((arg) => arg.startsWith("@"));
fs.copyFileSync(atFile.slice(1), ${JSON.stringify(promptFile)});
console.log(JSON.stringify({
  verdict: "pass",
  criteria: [{ criterion: "implementation", status: "pass", evidence: "# untracked: implementation.txt" }],
  scope_deviations: []
}));
`,
    { mode: 0o755 }
  );
  process.env.SPECFLOW_AUDIT_BIN = auditor;
  process.env.SPECFLOW_REVIEW_BUDGET_ID = "mechanical-tests";
  check(cli(closureRepo, "review-budget", "--json", JSON.stringify({ id: "mechanical-tests", calls: 1, note: "Synthetic CLI fake auditor fixture only, not the real delivery's budget." })).status === 0, "fake CLI review has an explicit finite grant");
  const auditResult = cli(closureRepo, "audit", "S3");
  check(auditResult.status === 0 && /✅ PASS/.test(auditResult.stdout), "isolated fake auditor produces bound pass evidence");
  const childArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  check(
    childArgs.includes("--no-tools") && childArgs.includes("--no-session") && childArgs.includes("--no-extensions"),
    "audit subprocess disables tools, session, and extensions"
  );
  check(
    fs.readFileSync(promptFile, "utf8").includes("# untracked: implementation.txt"),
    "audit prompt contains untracked implementation patch without truncation placeholder"
  );

  const specFile = path.join(closureRepo, "docs/specs/S3.md");
  let content = fs.readFileSync(specFile, "utf8");
  let parsed = parseFrontmatter(content);
  parsed.data.audit.criteria[0].status = "fail";
  fs.writeFileSync(specFile, writeFrontmatter(content, parsed.data));
  check(cli(closureRepo, "done", "S3").status !== 0, "done rejects verdict/criteria inconsistency");

  content = fs.readFileSync(specFile, "utf8");
  parsed = parseFrontmatter(content);
  parsed.data.audit.criteria[0].status = "pass";
  fs.writeFileSync(specFile, writeFrontmatter(content, parsed.data));
  write(closureRepo, "dirty-after-audit.txt", "dirty\n");
  check(cli(closureRepo, "done", "S3").status !== 0, "done rejects a changed live implementation snapshot");
  fs.rmSync(path.join(closureRepo, "dirty-after-audit.txt"));

  const closed = cli(closureRepo, "done", "S3");
  check(closed.status === 0 && /已完成/.test(closed.stdout), "unchanged bound record reaches done");
  check(
    loadSpecs(closureRepo).find((item) => item.frontmatter.id === "S3").frontmatter.status === "done",
    "terminal status is persisted"
  );
} catch (error) {
  failures++;
  console.log(`FAIL e2e unexpected error: ${error?.stack || error}`);
} finally {
  delete process.env.SPECFLOW_AUDIT_BIN;
  delete process.env.SPECFLOW_REVIEW_BUDGET_ID;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
