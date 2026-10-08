import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadProjectProfile } from "./project-profile.mjs";
import { gitWorkspace, gitWorktrees, withWorkspaceLock, readReservations } from "./workspace.mjs";
import { begin, impl, audit, checkCI, detectProjectConfig, findSpec, writeFrontmatter,
  allocateSpecId, renderWorktrees, migrateAlloc, commitGateDecision } from "./core.mjs";

const cli = fileURLToPath(new URL("./core.mjs", import.meta.url));
const gateProfile = { version: 1, gates: { mode: "replace", commands: [
  { name: "test", argv: ["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"] },
] }, evidence: { e2e: { dir: "acceptance", extension: ".py", runner: ["python3"] },
  migrations: { dir: "migrations", extensions: [".py", ".sql"] } } };
function git(root, args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function commit(root) { git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]); }
function spec(id, evidence = {}) { return writeFrontmatter("# Feature\n\n- 状态：已批准\n\n## Acceptance\n\n- [ ] works\n", {
  id, status: "approved", review: { decision: "approved" }, evidence: { human: [], ...evidence },
}); }
function fixture(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-python-worktrees-"));
  const root = path.join(base, "main with spaces"); fs.mkdirSync(root);
  const files = { ".gitignore": ".spec-flow-ledger.jsonl\n__pycache__/\n.pytest_cache/\n.sync\n",
    ".spec-flow.json": JSON.stringify(gateProfile), "pyproject.toml": "[project]\nname = 'fixture'\n",
    "value.py": "VALUE = 42\n", "tests/test_value.py": "import unittest\nfrom value import VALUE\nclass ValueTest(unittest.TestCase):\n    def test_value(self): self.assertEqual(VALUE, 42)\n",
    "acceptance/e2e-python.py": "from value import VALUE\nassert VALUE == 42\nprint('PASS Python acceptance')\n",
    "migrations/001_initial.sql": "-- disposable migration evidence\n",
    "specs/1.feature.md": spec(1, { e2e: ["e2e-python"], migrations: [1] }), "specs/2.feature.md": spec(2), ...extra };
  // Script-directory imports do not implicitly include cwd: make runner explicit.
  const config = JSON.parse(files[".spec-flow.json"]);
  if (config.evidence?.e2e) config.evidence.e2e.runner = ["python3", "-c", "import runpy,sys;runpy.run_path(sys.argv[1],run_name='__main__')"];
  files[".spec-flow.json"] = JSON.stringify(config);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  git(root, ["init", "-q"]); commit(root);
  return { base, root, clean: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function child(root, args, env = {}) {
  const proc = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout.on("data", (chunk) => stdout += chunk); proc.stderr.on("data", (chunk) => stderr += chunk);
  const result = new Promise((resolve, reject) => { proc.on("error", reject); proc.on("close", (code) => resolve({ code, stdout, stderr })); });
  return { proc, result };
}
async function waitMarker(root, operation) {
  for (let n = 0; n < 200; n++) {
    if (fs.existsSync(path.join(root, ".sync"))) return;
    if (operation.proc.exitCode !== null) throw new Error("Gate exited before synchronization");
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error("Gate did not start");
}
function slowFixture() {
  return fixture({ ".spec-flow.json": JSON.stringify({version:1,gates:{mode:"replace",commands:[{name:"test",argv:["python3","gate.py"]}]}}),
    "gate.py": "import os,time\nif os.getenv('DELAY'):\n    open('.sync','w').write('started')\n    time.sleep(1.5)\nprint('verified')\n" });
}

test("Python: minimal profile, real unittest/E2E, custom migration evidence, failing gate", async () => {
  const f = fixture();
  try {
    const profile = loadProjectProfile(f.root);
    assert.equal(profile.lifecycle.approval.mode, "decision");
    assert.deepEqual(detectProjectConfig(f.root).gates.map((gate) => gate.name), ["test"]);
    assert.equal(migrateAlloc(f.root), "002");
    await begin(f.root, "1"); assert.match(await impl(f.root, "1"), /✅ PASS/);
    assert.equal(findSpec(f.root, "1").frontmatter.impl.e2e["e2e-python"].pass, true);
    assert.equal((await checkCI(f.root, { runProjectGates: false, live: true })).pass, true);
    fs.writeFileSync(path.join(f.root, "value.py"), "VALUE = 0\n");
    assert.equal((await checkCI(f.root, { runProjectGates: false, live: true })).pass, false);
    assert.match(await impl(f.root, "1"), /❌ FAIL/);
    assert.equal(findSpec(f.root, "1").frontmatter.impl.gates.test.pass, false);
  } finally { f.clean(); }
});

test("generic schema rejects ambiguous gates, unsafe argv, unknown fields and evidence paths", () => {
  const f = fixture();
  try {
    const commands = gateProfile.gates.commands;
    const invalid = [
      { gates: { mode: "replace", commands: [], npmScripts: ["test"] } },
      { gates: { mode: "replace", commands: [] } },
      { gates: { mode: "replace", commands: [...commands, ...commands] } },
      { gates: { mode: "replace", commands: [{ name: "constructor", argv: ["python3"] }] } },
      ...[[], ["/bin/sh"], ["../python"], ["python3\n"], ["-python"]].map((argv) => ({ gates: { mode: "replace", commands: [{ name: "test", argv }] } })),
      { gates: { mode: "replace", commands: [{ name: "test", argv: ["python3"], shell: true }] } },
      { evidence: { e2e: { dir: "../outside", extension: ".py", runner: ["python3"] } } },
      { evidence: { e2e: { dir: "tests", extension: "py", runner: ["python3"] } } },
      { evidence: { migrations: { dir: "/tmp", extensions: [".py"] } } },
      { evidence: { migrations: { dir: "migrations", extensions: [".py", ".py"] } } },
      { evidence: { surprise: true } },
    ];
    for (const value of invalid) {
      fs.writeFileSync(path.join(f.root, ".spec-flow.json"), JSON.stringify({ version: 1, ...value }));
      assert.throws(() => loadProjectProfile(f.root), undefined, JSON.stringify(value));
    }
  } finally { f.clean(); }
});

test("argv metacharacters remain literal, not shell instructions", async () => {
  const f = fixture({ "specs/1.feature.md": spec(1), ".spec-flow.json": JSON.stringify({version:1,gates:{mode:"replace",commands:[
    {name:"literal",argv:["python3","-c","import sys; assert sys.argv[1] == '; touch injected'", "; touch injected"]},
  ]}}) });
  try { assert.equal((await checkCI(f.root)).pass, true); assert.equal(fs.existsSync(path.join(f.root, "injected")), false); }
  finally { f.clean(); }
});

test("Python discovery is conservative, venv-aware, and no-gate impl cannot pass", async () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.root, ".spec-flow.json"));
    assert.equal(detectProjectConfig(f.root).gates.length, 0);
    // Remove custom evidence declarations; this case concerns the gate, not JS fallback evidence.
    fs.writeFileSync(path.join(f.root, "specs/1.feature.md"), spec(1));
    await begin(f.root, "1"); assert.match(await impl(f.root, "1"), /No project gates/);
    assert.equal(findSpec(f.root, "1").frontmatter.impl.pass, false);
    assert.equal((await checkCI(f.root)).pass, false);
    assert.equal((await commitGateDecision(f.root, "git commit -m no-gates")).action, "block");
    fs.writeFileSync(path.join(f.root, "pyproject.toml"), "[project]\nname='fixture'\n[tool.pytest.ini_options]\n");
    assert.equal(detectProjectConfig(f.root).gates[0].name, "pytest");
    fs.writeFileSync(path.join(f.root, "pytest.ini"), "[pytest]\n");
    assert.equal(detectProjectConfig(f.root).gates[0].file, "python3");
    fs.mkdirSync(path.join(f.root, ".venv/bin"), { recursive: true });
    fs.symlinkSync("/usr/bin/python3", path.join(f.root, ".venv/bin/python"));
    assert.equal(detectProjectConfig(f.root).gates[0].file, path.join(f.root, ".venv/bin/python"));
  } finally { f.clean(); }
});

test("missing executable is a failing configured gate, not default fallback", async () => {
  const f = fixture({ ".spec-flow.json": JSON.stringify({version:1,gates:{mode:"replace",commands:[{name:"test",argv:["specflow-missing-interpreter"]}]}}) });
  try { const result = await commitGateDecision(f.root, "git commit -m missing"); assert.equal(result.action, "block"); assert.match(result.reason, /ENOENT/); }
  finally { f.clean(); }
});

test("linked/detached/spaced worktrees keep local evidence and expose live freshness", async () => {
  const f = fixture();
  try {
    const a = path.join(f.base, "agent A"); const b = path.join(f.base, "agent B");
    git(f.root, ["worktree", "add", "-qb", "agent-a", a]);
    git(f.root, ["worktree", "add", "-q", "--detach", b]);
    assert.equal(gitWorkspace(a).commonDir, gitWorkspace(f.root).commonDir);
    assert.notEqual(gitWorkspace(a).gitDir, gitWorkspace(f.root).gitDir);
    assert.equal(gitWorktrees(a).length, 3);
    await begin(a, "1"); assert.match(await impl(a, "1"), /✅ PASS/);
    assert.equal(findSpec(f.root, "1").frontmatter.status, "approved");
    fs.writeFileSync(path.join(b, "value.py"), "VALUE = 0\n");
    assert.equal((await checkCI(a, { runProjectGates: false, live: true })).pass, true);
    assert.match(await renderWorktrees(a), /live fresh/);
    commit(a); git(f.root, ["merge", "--ff-only", "agent-a"]);
    assert.equal((await checkCI(f.root, { runProjectGates: false, live: true })).pass, true);
    fs.writeFileSync(path.join(f.root, "integrated.txt"), "another merged feature\n"); commit(f.root);
    assert.equal((await checkCI(f.root, { runProjectGates: false, live: true })).pass, false);
    assert.equal((await checkCI(f.root, { runProjectGates: false })).pass, true, "historical CI deliberately differs from live mode");
    await assert.rejects(audit(f.root, "1"), /implementation changed after spec_impl/);
    assert.match(await renderWorktrees(a), /live STALE/);
    assert.equal((await checkCI(a, { runProjectGates: false, live: true })).pass, true);
  } finally { f.clean(); }
});

test("shared Spec allocator reserves unique IDs across competing processes/prefixes", async () => {
  const f = fixture({ "specs/50.taken.md": spec(50), "specs/S1.8.taken.md": spec("S1.8") });
  try {
    const peer = path.join(f.base, "peer"); git(f.root, ["worktree", "add", "-qb", "peer", peer]);
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => child(n % 2 ? peer : f.root, ["spec-alloc"]).result));
    assert.ok(results.every((result) => result.code === 0), JSON.stringify(results));
    const ids = results.map((result) => result.stdout.trim());
    assert.equal(new Set(ids).size, 6); assert.ok(ids.every((id) => Number(id) > 50));
    assert.equal(await allocateSpecId(peer, "S1."), "S1.9");
    git(f.root, ["worktree", "remove", peer]);
    assert.equal(await allocateSpecId(f.root, "S1."), "S1.10", "removed worktree reservations are never reused");
    assert.ok(readReservations(f.root).ids.includes("S1.9"));
    fs.writeFileSync(path.join(f.root, "specs/invalid.md"), "---\ninvalid: [\n---\n");
    await assert.rejects(allocateSpecId(f.root), /malformed\/unmanaged/);
  } finally { f.clean(); }
});

test("common-dir locks reject overlapping same-ID lifecycle, independent worktrees proceed", async () => {
  const f = slowFixture(); let running;
  try {
    const peer = path.join(f.base, "peer"); git(f.root, ["worktree", "add", "-qb", "peer", peer]);
    // No E2E declaration in this race fixture: configured generic gate only.
    fs.writeFileSync(path.join(f.root, "specs/1.feature.md"), spec(1));
    await begin(f.root, "1"); await begin(peer, "2");
    running = child(f.root, ["impl", "1"], { DELAY: "1" }); await waitMarker(f.root, running);
    await assert.rejects(impl(peer, "1"), /Spec Flow busy/);
    assert.match(await impl(peer, "2"), /✅ PASS/);
    assert.equal((await running.result).code, 0);
    assert.equal(findSpec(f.root, "1").frontmatter.impl.pass, true);
    assert.throws(() => withWorkspaceLock(peer, "sample", () => withWorkspaceLock(f.root, "sample", () => {})), /busy/);
    assert.equal(withWorkspaceLock(f.root, "sample", () => "released"), "released");
  } finally { running?.proc.kill(); if (running) await running.result; f.clean(); }
});

test("cancelled lifecycle releases the cross-process lock and leaves pending nonpass evidence", async () => {
  const f = slowFixture(); const controller = new AbortController();
  const previous = process.env.DELAY;
  try {
    fs.writeFileSync(path.join(f.root, "specs/1.feature.md"), spec(1));
    await begin(f.root, "1"); process.env.DELAY = "1";
    const operation = impl(f.root, "1", { signal: controller.signal });
    const rejected = assert.rejects(operation, { name: "AbortError" });
    await waitMarker(f.root, { proc: { exitCode: null } }); controller.abort(); await rejected;
    assert.equal(findSpec(f.root, "1").frontmatter.impl.pass, false);
    assert.equal(withWorkspaceLock(f.root, "spec:1", () => "released"), "released");
  } finally {
    controller.abort();
    if (previous === undefined) delete process.env.DELAY; else process.env.DELAY = previous;
    f.clean();
  }
});

test("allocator fails closed on unavailable worktree inventory", async () => {
  const f = fixture();
  try {
    const peer = path.join(f.base, "peer"); git(f.root, ["worktree", "add", "-qb", "peer", peer]);
    fs.renameSync(peer, peer + "-moved");
    await assert.rejects(allocateSpecId(f.root));
    assert.equal(readReservations(f.root).ids.length, 0);
  } finally { f.clean(); }
});

test("mid-gate code changes fail impl, mid-gate spec edits are preserved", async () => {
  for (const changeContract of [false, true]) {
    const f = slowFixture(); let running;
    try {
      fs.writeFileSync(path.join(f.root, "specs/1.feature.md"), spec(1));
      await begin(f.root, "1"); running = child(f.root, ["impl", "1"], { DELAY: "1" });
      await waitMarker(f.root, running);
      fs.appendFileSync(path.join(f.root, changeContract ? "specs/1.feature.md" : "value.py"), changeContract ? "\nUser added a concurrent requirement\n" : "# changed during gate\n");
      const result = await running.result;
      if (changeContract) {
        assert.notEqual(result.code, 0); assert.match(result.stderr, /refusing to overwrite/);
        assert.match(findSpec(f.root, "1").content, /User added a concurrent requirement/);
        assert.equal(findSpec(f.root, "1").frontmatter.impl.at, null);
      } else {
        assert.match(result.stdout, /changed during gates/);
        assert.equal(findSpec(f.root, "1").frontmatter.impl.pass, false);
      }
      assert.equal(withWorkspaceLock(f.root, "spec:1", () => "released"), "released");
    } finally { running?.proc.kill(); if (running) await running.result; f.clean(); }
  }
});
