// Versioned private coordination, separate from legacy recovery jobs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { coordinationDirectory, withWorkspaceLock } from "./workspace.mjs";

export const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export function privateDir(parent, name) {
  const dir = path.join(parent, name);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe review directory");
  fs.chmodSync(dir, 0o700);
  return dir;
}
export function reviewStore(cwd) { return privateDir(coordinationDirectory(cwd), "review-v1"); }
export function atomicPrivate(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function readPrivateBytes(file, max = 8 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe/oversize review artifact");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
export function readPrivate(file, max) { return readPrivateBytes(file, max).toString("utf8"); }
export function jobDirectory(cwd, id) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid review job ID");
  const jobs = privateDir(reviewStore(cwd), "jobs");
  const dir = path.join(jobs, id), stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe review job");
  return dir;
}
export function loadJob(cwd, id) {
  const dir = jobDirectory(cwd, id);
  const job = JSON.parse(readPrivate(path.join(dir, "job.json")));
  if (job.version !== 1 || job.id !== id || !["proposal", "committed", "incremental", "working-tree-audit"].includes(job.mode) ||
      !["prepared", "running", "completed", "failed", "cancelled", "skipped"].includes(job.state)) throw new Error("Unsupported review job");
  return { dir, job };
}
export function saveJob(dir, job) { atomicPrivate(path.join(dir, "job.json"), job); }
function budgetPath(cwd, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id)) throw new Error("Invalid delivery-cycle budget ID");
  return path.join(privateDir(reviewStore(cwd), "budgets"), `${id}.json`);
}
export function authorizeReviewBudget(cwd, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["id", "calls", "used", "note"].includes(key))) throw new Error("Invalid budget authorization fields");
  const { id, calls, used = 0, note } = input;
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > 100 || !Number.isSafeInteger(used) || used < 0 || used > calls ||
      typeof note !== "string" || note.trim().length < 20 || note.length > 4000) throw new Error("Budget requires explicit finite calls, used count and user-authorization note");
  const file = budgetPath(cwd, id);
  return withWorkspaceLock(cwd, `review-budget:${id}`, () => {
    if (fs.existsSync(file)) throw new Error("Review grant already exists; no reset/increase. Use a separately authorized cycle ID.");
    const budget = { version: 1, id, calls, used, note: note.trim(), at: new Date().toISOString(), reservations: [] };
    fs.writeFileSync(file, JSON.stringify(budget, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return budget;
  });
}
export function reserveReviewCall(cwd, id, jobId) {
  const file = budgetPath(cwd, id);
  return withWorkspaceLock(cwd, `review-budget:${id}`, () => {
    const budget = JSON.parse(readPrivate(file, 1024 * 1024));
    if (budget.version !== 1 || budget.id !== id || !Number.isSafeInteger(budget.calls) || !Number.isSafeInteger(budget.used) ||
        budget.used < 0 || budget.used > budget.calls || !Array.isArray(budget.reservations)) throw new Error("Malformed review budget");
    if (budget.reservations.some((item) => item.job === jobId)) throw new Error("Review job already charged; cannot respawn");
    if (budget.used >= budget.calls) throw new Error("Review budget exhausted; new explicit authorization required");
    budget.used++;
    const call = { job: jobId, ordinal: budget.used, reserved: new Date().toISOString() };
    budget.reservations.push(call); atomicPrivate(file, budget);
    return { id, ordinal: call.ordinal, limit: budget.calls };
  });
}
