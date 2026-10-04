#!/usr/bin/env node
// Offline product-boundary acceptance: copied Action CLI, real Python, linked
// Git worktree, branch-local lifecycle. No pip, provider, or production data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-worktrees-python-e2e-"));
function run(file, args, cwd, env = process.env) {
  return execFileSync(file, args, { cwd, env, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
}
function check(value, message) { if (!value) throw new Error(message); }
try {
  const action = path.join(base, "action"); const project = path.join(base, "main"); const peer = path.join(base, "agent with spaces");
  fs.mkdirSync(action); fs.mkdirSync(path.join(project, "specs"), { recursive: true });
  for (const name of ["core.mjs", "project-profile.mjs", "workspace.mjs", "review-execution.mjs"]) fs.copyFileSync(path.join(source, name), path.join(action, name));
  fs.symlinkSync(path.join(source, "node_modules"), path.join(action, "node_modules"), "dir");
  const cli = path.join(action, "core.mjs"); const env = { ...process.env, SPECFLOW_CLI: cli, PYTHONDONTWRITEBYTECODE: "1" };
  fs.mkdirSync(path.join(project, "tests")); fs.mkdirSync(path.join(project, "acceptance"));
  fs.writeFileSync(path.join(project, ".gitignore"), ".spec-flow-ledger.jsonl\n.gatecount\n__pycache__/\n");
  fs.writeFileSync(path.join(project, ".spec-flow.json"), JSON.stringify({version:1,
    gates:{mode:"replace",commands:[{name:"verify",argv:["python3","verify.py"]}]},
    evidence:{e2e:{dir:"acceptance",extension:".py",runner:["python3"]}}}));
  fs.writeFileSync(path.join(project, "tests/test_example.py"), "import unittest\nclass Example(unittest.TestCase):\n    def test_example(self): self.assertEqual(2 + 2, 4)\n");
  fs.writeFileSync(path.join(project, "verify.py"), "import os,subprocess\nwith open('.gatecount','a') as f: f.write('verify\\n')\nsubprocess.run(['node',os.environ['SPECFLOW_CLI'],'check','--ci','--contracts-only'],check=True)\nsubprocess.run(['python3','-m','unittest','discover','-s','tests'],check=True)\n");
  fs.writeFileSync(path.join(project, "acceptance/e2e-python.py"), "assert 2 + 2 == 4\nprint('PASS real Python acceptance')\n");
  fs.writeFileSync(path.join(project, "specs/1.feature.md"), "---\nid: 1\nstatus: approved\nreview:\n  decision: approved\nevidence:\n  e2e: [e2e-python]\n  human: []\n---\n\n# Feature\n\n- 状态：已批准\n\n- [ ] portable gates\n");
  run("git", ["init", "-q"], project); run("git", ["add", "."], project);
  run("git", ["-c","user.name=specflow","-c","user.email=specflow@example.invalid","commit","-qm","fixture"], project);
  check(run(process.execPath, [cli, "verify"], project, env).includes("check --ci 通过"), "copied Python Action path failed");
  check(fs.readFileSync(path.join(project, ".gatecount"), "utf8") === "verify\n", "caller verify did not run exactly once");
  console.log("PASS copied Action CLI invokes package.json-free Python verify exactly once without recursion");
  run("git", ["worktree","add","-qb","agent",peer], project);
  check(run(process.execPath,[cli,"spec-alloc"],peer,env).trim() === "2", "shared Spec allocator missed existing ID");
  run(process.execPath,[cli,"begin","1"],peer,env);
  check(run(process.execPath,[cli,"impl","1"],peer,env).includes("✅ PASS"), "Python worktree impl failed");
  check(fs.readFileSync(path.join(project,"specs/1.feature.md"),"utf8").includes("status: approved"), "peer lifecycle altered main contract");
  check(run(process.execPath,[cli,"check","--ci","--contracts-only","--live"],peer,env).includes("通过"), "bound Python worktree evidence not fresh");
  fs.writeFileSync(path.join(project,"other-task.txt"),"main's concurrent task\n");
  check(run(process.execPath,[cli,"check","--ci","--contracts-only","--live"],peer,env).includes("通过"), "main changes contaminated peer evidence");
  check(run(process.execPath,[cli,"worktrees"],peer,env).includes("live fresh"), "worktree board omitted freshness");
  console.log("PASS real linked worktree has isolated Python lifecycle, E2E and live evidence despite concurrent main edits");
} finally { fs.rmSync(base, { recursive: true, force: true }); }
