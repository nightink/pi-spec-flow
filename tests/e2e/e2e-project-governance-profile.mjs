// S1.4 real CLI acceptance: an opt-in project profile preserves example-app-shaped
// governance while binding lifecycle evidence to the configured verify gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, writeFrontmatter } from "../../core.mjs";

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

function profile() {
  return {
    version: 1,
    lifecycle: {
      preReview: ["draft", "in-review"],
      startable: ["approved"],
      active: "in-progress",
      done: "done",
      ignored: ["archived"],
      dependenciesField: "depends_on",
      updatedField: "updated",
      bodyStatusLine: false,
      legacyActive: "external-warning",
      externalActiveIds: [3],
      approval: {
        reviewersField: "reviewers",
        reviewedAtField: "reviewed_at",
        minimumReviewers: 1,
        placeholderReviewers: ["pending"],
      },
    },
    gates: { mode: "replace", npmScripts: ["verify"] },
  };
}

function spec(id, { status = "approved", reviewers = ["parent"], reviewedAt = "2026-09-21", deps = [] } = {}) {
  return writeFrontmatter(
    `# ${id}. Profile acceptance\n\n## 验收标准\n\n- configured workflow closes\n`,
    {
      id,
      title: `Profile acceptance ${id}`,
      kind: "spec",
      status,
      created: "2026-09-21",
      updated: "2026-09-21",
      author: "agent",
      reviewers,
      reviewed_at: reviewedAt,
      depends_on: deps,
      supersedes: [],
      evidence: { human: [] },
    }
  );
}

function init(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=profile-e2e", "-c", "user.email=spec-flow@example.invalid", "commit", "-qm", "init"],
    { cwd: root }
  );
}

function cli(root, args, env = {}) {
  return spawnSync(process.execPath, [core, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-profile-e2e-"));
try {
  const root = path.join(sandbox, "project");
  fs.mkdirSync(root, { recursive: true });
  const marker = path.join(sandbox, "gates.log");
  write(
    root,
    "package.json",
    JSON.stringify({
      scripts: {
        verify: "node verify.mjs",
        typecheck: "node typecheck.mjs",
        test: "node test.mjs",
      },
    })
  );
  write(root, ".spec-flow.json", JSON.stringify(profile(), null, 2));
  write(root, "verify.mjs", `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(marker)}, "verify\\n"); console.log("verify ok");\n`);
  write(root, "typecheck.mjs", `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(marker)}, "typecheck\\n");\n`);
  write(root, "test.mjs", `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(marker)}, "test\\n");\n`);
  write(root, "specs/1.dependency.md", spec(1, { status: "done" }));
  write(root, "specs/2.delivery.md", spec(2, { deps: [1] }));
  write(root, "specs/3.legacy-active.md", spec(3, { status: "in-progress" }));
  write(root, "specs/4.draft.md", spec(4, { status: "draft", reviewers: ["pending"], reviewedAt: null }));
  write(root, "specs/5.archived.md", spec(5, { status: "archived", reviewers: ["pending"], reviewedAt: null }));
  init(root);

  const board = cli(root, ["board"]);
  check(
    board.status === 0 && /2 \[2\.delivery\.md\]: 已批准/.test(board.stdout),
    "numeric ID and dot-prefixed filename are discovered by the real CLI"
  );

  const initialCI = cli(root, ["check", "--ci"]);
  check(
    initialCI.status === 0 && /external legacy active spec/.test(initialCI.stdout),
    "configured legacy active specs remain under external project governance"
  );

  const begun = cli(root, ["begin", "2"]);
  let content = fs.readFileSync(path.join(root, "specs/2.delivery.md"), "utf8");
  let parsed = parseFrontmatter(content);
  check(
    begun.status === 0 &&
      parsed.data.status === "in-progress" &&
      parsed.data.depends_on[0] === 1 &&
      !/^- 状态：/m.test(content),
    "begin preserves example-app-shaped fields and does not inject a body status line"
  );

  write(root, "implementation.txt", "configured implementation\n");
  const implemented = cli(root, ["impl", "2"]);
  const gateLines = fs.readFileSync(marker, "utf8").trim().split("\n");
  check(
    implemented.status === 0 && /✅ PASS/.test(implemented.stdout) && gateLines.every((line) => line === "verify"),
    "impl runs only the configured authoritative verify npm script"
  );

  // Review metadata is lifecycle evidence, not contract text; changing it must
  // not invalidate the implementation binding.
  content = fs.readFileSync(path.join(root, "specs/2.delivery.md"), "utf8");
  parsed = parseFrontmatter(content);
  parsed.data.reviewers = ["parent", "implementation-reviewer"];
  parsed.data.reviewed_at = "2026-09-22";
  parsed.data.updated = "2026-09-22";
  fs.writeFileSync(path.join(root, "specs/2.delivery.md"), writeFrontmatter(content, parsed.data));

  const argsFile = path.join(sandbox, "auditor-args.json");
  const auditor = write(
    sandbox,
    "fake-auditor.mjs",
    `#!/usr/bin/env node\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({verdict:"pass",criteria:[{criterion:"configured lifecycle",status:"pass",evidence:"implementation.txt"}],scope_deviations:[]}));\n`,
    { mode: 0o755 }
  );
  const audited = cli(root, ["audit", "2"], { SPECFLOW_AUDIT_BIN: auditor });
  check(
    audited.status === 0 && /✅ PASS/.test(audited.stdout),
    "audit remains bound after review-only metadata updates"
  );
  check(
    JSON.parse(fs.readFileSync(argsFile, "utf8")).includes("--no-tools"),
    "profile audit keeps the isolated no-tools subprocess boundary"
  );

  const closed = cli(root, ["done", "2"]);
  content = fs.readFileSync(path.join(root, "specs/2.delivery.md"), "utf8");
  parsed = parseFrontmatter(content);
  check(
    closed.status === 0 &&
      parsed.data.status === "done" &&
      parsed.data.reviewers.includes("implementation-reviewer") &&
      parsed.data.depends_on[0] === 1 &&
      !/^- 状态：/m.test(content),
    "done preserves project metadata and writes the configured terminal status"
  );

  // A second target proves that the profile file itself is snapshot-bound.
  write(root, "specs/6.binding.md", spec(6));
  execFileSync("git", ["add", "specs/6.binding.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=profile-e2e", "-c", "user.email=spec-flow@example.invalid", "commit", "-qm", "add binding spec"],
    { cwd: root }
  );
  check(cli(root, ["begin", "6"]).status === 0, "second configured spec begins");
  write(root, "binding.txt", "bound\n");
  check(cli(root, ["impl", "6"]).status === 0, "second configured spec records impl evidence");
  const changedProfile = profile();
  changedProfile.lifecycle.approval.placeholderReviewers.push("todo");
  write(root, ".spec-flow.json", JSON.stringify(changedProfile, null, 2));
  const stale = cli(root, ["audit", "6"], { SPECFLOW_AUDIT_BIN: auditor });
  check(
    stale.status !== 0 && /implementation changed after spec_impl/.test(stale.stderr),
    "profile changes invalidate previously recorded implementation evidence"
  );

  // Invalid profile input must fail rather than silently fall back to defaults.
  const invalid = path.join(sandbox, "invalid");
  fs.mkdirSync(invalid, { recursive: true });
  write(invalid, "package.json", JSON.stringify({ scripts: { verify: "node verify.mjs" } }));
  write(invalid, ".spec-flow.json", JSON.stringify({ ...profile(), unknown: true }));
  write(invalid, "specs/1.md", spec(1));
  const invalidBoard = cli(invalid, ["board"]);
  check(
    invalidBoard.status !== 0 && /unknown key/.test(invalidBoard.stderr),
    "invalid profile fails closed at the CLI boundary"
  );
} catch (error) {
  failures++;
  console.log(`FAIL unexpected profile E2E error: ${error?.stack || error}`);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
