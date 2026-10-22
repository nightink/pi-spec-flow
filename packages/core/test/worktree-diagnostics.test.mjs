import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { allocateSpecId, newSpec, writeFrontmatter } from "../src/core.mjs";
import { gitWorktrees, readReservations } from "../src/workspace.mjs";

const cli = fileURLToPath(new URL("../src/core.mjs", import.meta.url));
function fixture(t, inaccessible) {
  const sandbox = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "specflow-worktree-diagnostic-")),
  );
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, "main checkout"),
    member = path.join(sandbox, "missing member");
  fs.mkdirSync(path.join(root, "specs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "specs", "S1.md"),
    writeFrontmatter("# Existing\n", { id: "S1", status: "draft" }),
  );
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  git("worktree", "add", "--detach", member);
  // Only this test's disposable member is damaged. Never prune the family.
  if (inaccessible) fs.rmSync(member, { recursive: true });
  else fs.rmSync(path.join(member, ".git"));
  return { root, member, git };
}
function assertDiagnostic(error, member) {
  assert.equal(error.code, "SPECFLOW_WORKTREE_UNAVAILABLE");
  assert.equal(error.diagnostic.code, error.code);
  assert.equal(error.diagnostic.category, "configuration-error");
  assert.equal(error.diagnostic.stage, "worktree-inventory");
  assert.equal(error.diagnostic.member.path, member);
  assert.equal(error.diagnostic.member.prunable, true);
  assert.match(error.message, /worktree member/i);
  assert.match(error.message, /current checkout/i);
  assert.notEqual(
    error.message.trim(),
    "fatal: not a git repository (or any of the parent directories): .git",
  );
  assert.ok(error.diagnostic.nextActions.length);
  for (const action of error.diagnostic.nextActions) {
    assert.equal(action.tool, "bash");
    assert.equal(action.requiresAuthorization, false);
    assert.equal(action.requiresHuman, false);
    assert.match(action.args.command, /worktree (list|prune --dry-run)/);
  }
  return true;
}
for (const inaccessible of [false, true]) {
  test(`worktree diagnosis: ${inaccessible ? "missing directory" : "missing git marker"} blocks allocation, not preview; no family mutation`, async (t) => {
    const f = fixture(t, inaccessible);
    const beforeInventory = f.git("worktree", "list", "--porcelain", "-z"),
      beforeSpec = fs.readFileSync(path.join(f.root, "specs", "S1.md")),
      beforeIds = readReservations(f.root).ids;
    assert.throws(
      () => gitWorktrees(f.root),
      (error) => assertDiagnostic(error, f.member),
    );
    await assert.rejects(allocateSpecId(f.root, "S"), (error) => assertDiagnostic(error, f.member));
    await assert.rejects(newSpec(f.root, { title: "Blocked", prefix: "S" }), (error) =>
      assertDiagnostic(error, f.member),
    );
    const preview = await newSpec(f.root, { title: "Preview", prefix: "S", dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.status, "draft");
    for (const args of [
      ["spec-alloc", "--prefix", "S"],
      ["spec-new", "--json", JSON.stringify({ title: "Blocked", prefix: "S" })],
    ]) {
      const response = spawnSync(process.execPath, [cli, ...args], {
        cwd: f.root,
        encoding: "utf8",
        timeout: 10000,
      });
      assert.notEqual(response.status, 0);
      assert.match(response.stderr, /SPECFLOW_WORKTREE_UNAVAILABLE/);
      assert.match(response.stderr, /worktree-inventory/);
      assert.match(response.stderr, /prunable/);
      assert.match(response.stderr, /--dry-run/);
    }
    assert.deepEqual(readReservations(f.root).ids, beforeIds);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "specs", "S1.md")), beforeSpec);
    assert.equal(f.git("worktree", "list", "--porcelain", "-z"), beforeInventory);
    assert.equal(fs.readdirSync(path.join(f.root, "specs")).length, 1);
    assert.equal(fs.existsSync(path.join(f.root, ".spec-flow-ledger.jsonl")), false);
    assert.equal(fs.existsSync(f.member), !inaccessible);
  });
}
