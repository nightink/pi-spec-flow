// Git common-dir coordination only; no project code runs here.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function gitWorkspace(cwd) {
  const root = fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const commonDir = fs.realpathSync(
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
  const gitDir = fs.realpathSync(git(root, ["rev-parse", "--absolute-git-dir"]).trim());
  return { root, commonDir, gitDir };
}

export function gitWorktrees(cwd) {
  const { commonDir } = gitWorkspace(cwd);
  const records = git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter(Boolean);
  return records.map((record) => {
    const fields = Object.fromEntries(
      record
        .split("\0")
        .filter(Boolean)
        .map((field) => {
          const space = field.indexOf(" ");
          return space < 0 ? [field, true] : [field.slice(0, space), field.slice(space + 1)];
        }),
    );
    if (!fields.worktree || fields.bare)
      throw new Error("Unsupported/malformed Git worktree inventory");
    try {
      const workspace = gitWorkspace(fields.worktree);
      if (workspace.commonDir !== commonDir)
        throw new Error("Worktree has a different Git common directory");
      return { ...workspace, branch: fields.branch || "(detached)", head: fields.HEAD };
    } catch (cause) {
      const prunable = Object.hasOwn(fields, "prunable");
      const error = new Error(
        `Cannot verify registered worktree member ${JSON.stringify(fields.worktree)} (prunable=${prunable}); the current checkout was verified. Inspect the family before allocating IDs; no member was skipped or removed.`,
        { cause },
      );
      error.code = "SPECFLOW_WORKTREE_UNAVAILABLE";
      error.diagnostic = {
        code: error.code,
        category: "configuration-error",
        stage: "worktree-inventory",
        member: {
          path: fields.worktree,
          prunable,
          reason: typeof fields.prunable === "string" ? fields.prunable : null,
        },
        message: error.message,
        nextActions: [
          {
            tool: "bash",
            args: { command: "git worktree list --porcelain" },
            reason: "Read the registered family and locate the unavailable member.",
            requiresAuthorization: false,
            requiresHuman: false,
          },
          {
            tool: "bash",
            args: { command: "git worktree prune --dry-run --verbose" },
            reason:
              "Preview stale registrations only; actual cleanup requires owner authorization.",
            requiresAuthorization: false,
            requiresHuman: false,
          },
        ],
      };
      throw error;
    }
  });
}

function privateDirectory(parent, name) {
  const dir = path.join(parent, name);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error(`Unsafe Spec Flow coordination directory: ${dir}`);
  }
  return dir;
}

export function coordinationDirectory(cwd) {
  return privateDirectory(gitWorkspace(cwd).commonDir, "spec-flow");
}

// Fail-fast locks cover both CLI processes and different Pi sessions. No stale
// PID guessing: never steal a lock; SIGKILL requires explicit owner verification.
export function withWorkspaceLock(cwd, key, fn) {
  const dir = privateDirectory(coordinationDirectory(cwd), "locks");
  const file = path.join(dir, `${crypto.createHash("sha256").update(key).digest("hex")}.lock`);
  const owner = {
    pid: process.pid,
    host: os.hostname(),
    root: gitWorkspace(cwd).root,
    at: new Date().toISOString(),
    key,
    token: crypto.randomBytes(16).toString("hex"),
  };
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let description = "unknown owner";
    try {
      description = fs.readFileSync(file, "utf8").slice(0, 1000);
    } catch {
      // Unreadable owner metadata keeps the generic description above.
    }
    const busy = new Error(
      `Spec Flow busy (${key}); retry after owner finishes: ${description}\nLock: ${file}. Never remove an active owner's lock.`,
    );
    busy.code = "SPECFLOW_BUSY";
    throw busy;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    throw error;
  }
  fs.closeSync(fd);
  const release = () => {
    // Do not remove an externally replaced lock.
    if (JSON.parse(fs.readFileSync(file, "utf8")).token !== owner.token) {
      throw new Error(`Spec Flow lock ownership changed: ${file}`);
    }
    fs.unlinkSync(file);
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function")
      return Promise.resolve(result).finally(release);
    release();
    return result;
  } catch (error) {
    if (fs.existsSync(file)) release();
    throw error;
  }
}

export function readReservations(cwd) {
  const file = path.join(coordinationDirectory(cwd), "ids.json");
  if (!fs.existsSync(file)) return { file, ids: [] };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    throw new Error("Unsafe Spec ID reservation file");
  }
  const ids = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error("Malformed Spec ID reservations");
  }
  return { file, ids };
}
