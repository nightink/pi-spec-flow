// S1.3 real CLI acceptance: discover project/docs spec directories in singular/plural forms.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSpecs, writeFrontmatter } from "../../core.mjs";

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

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function spec(id) {
  return writeFrontmatter(
    `# ${id}\n\n- 状态：已批准\n\n## 验收标准\n\n- discovery works\n`,
    {
      id,
      status: "approved",
      review: { decision: "approved" },
      evidence: { human: [] },
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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-discovery-e2e-"));
try {
  const project = path.join(sandbox, "project");
  fs.mkdirSync(project, { recursive: true });
  write(project, "docs/specs/S1.md", spec("S1"));
  write(project, "docs/spec/S2.md", spec("S2"));
  write(project, "specs/S3.md", spec("S3"));
  write(project, "spec/S4.md", spec("S4"));
  write(project, "specs/nested/S5.md", spec("S5"));
  init(project);

  const board = cli(project, "board");
  check(board.status === 0, "CLI board scans all supported directories");
  check(
    ["S1", "S2", "S3", "S4"].every((id) => board.stdout.includes(id)),
    "board merges singular/plural docs and project directories"
  );
  check(!board.stdout.includes("S5"), "discovery does not recurse into nested directories");

  const paths = loadSpecs(project).map((item) => item.relativePath);
  check(
    JSON.stringify(paths) ===
      JSON.stringify(["docs/spec/S2.md", "docs/specs/S1.md", "spec/S4.md", "specs/S3.md"]),
    "discovery order is deterministic"
  );

  const began = cli(project, "begin", "S3");
  check(
    began.status === 0 && /workflow: v2/.test(began.stdout),
    "CLI lifecycle resolves a project-level specs file"
  );
  check(
    loadSpecs(project).find((item) => item.frontmatter?.id === "S3")?.frontmatter?.workflow_version === 2,
    "project-level spec receives normal lifecycle writeback"
  );
} catch (error) {
  failures++;
  console.log(`FAIL e2e unexpected error: ${error?.stack || error}`);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
