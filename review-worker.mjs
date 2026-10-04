// Detached single-shot executor: UI/daemon loss cannot silently lose a result.
import fs from "node:fs";
import path from "node:path";
import { loadJob, saveJob, readPrivate, digest } from "./review-storage.mjs";
import { normalizeReviewResult, scanReviewPacket, decodeAuditorResponse } from "./review-engine.mjs";
import { buildAuditorArgs, runSpawn } from "./core.mjs";

const [cwd, id] = process.argv.slice(2);
const { dir } = loadJob(cwd, id);
let job = loadJob(cwd, id).job;
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort());
function persist() {
  // Respect the caller's cancellation instead of replacing it with a late PASS.
  const current = loadJob(cwd, id).job;
  if (current.state === "cancelled") { job.state = "cancelled"; job.result = null; }
  saveJob(dir, job);
}
try {
  if (job.state !== "running") throw new Error("Worker has no claimed review job");
  job.worker_pid = process.pid;
  const packet = readPrivate(path.join(dir, "packet.md"), 512 * 1024);
  if (digest(packet) !== job.packet_sha256 || scanReviewPacket(packet).findings.length) throw new Error("Sealed packet changed before child execution");
  const { args, cleanup } = buildAuditorArgs(packet, job.execution.model, job.execution.thinking);
  let response;
  const outputFds = { stdout: fs.openSync(path.join(dir, "stdout.txt"), "wx", 0o600),
    stderr: fs.openSync(path.join(dir, "stderr.txt"), "wx", 0o600) };
  try {
    const childInput = fs.readFileSync(args.at(-1).slice(1));
    if (digest(childInput) !== job.packet_sha256) throw new Error("Child input differs from scanned packet");
    job.child_input_sha256 = digest(childInput); job.model_invoked = true; persist();
    const env = { ...process.env, NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1" };
    for (const name of ["PI_SESSION_FILE", "PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[name];
    response = await runSpawn(job.execution.bin, args, { cwd, env, signal: controller.signal,
      timeout: job.execution.timeout, maxBuffer: 32 * 1024 * 1024,
      onOutput: (stream, bytes) => fs.writeSync(outputFds[stream], bytes) });
  } finally { cleanup(); for (const fd of Object.values(outputFds)) fs.closeSync(fd); }
  job.raw_sha256 = digest(fs.readFileSync(path.join(dir, "stdout.txt"))); job.output_truncated = response.tooBig;
  job.output_scan = scanReviewPacket(response.stdout);
  if (job.output_scan.findings.length) throw new Error("Auditor output contains sensitive pattern; retained privately, not returned");
  if (response.tooBig || response.code !== 0) throw new Error(`Auditor execution failed (code=${response.code}, truncated=${response.tooBig})`);
  const { raw, effectiveModel, usage } = decodeAuditorResponse(response.stdout);
  job.effective_model = effectiveModel; job.usage = usage;
  job.raw_verdict = raw.verdict ?? null;
  job.result = normalizeReviewResult(raw, job); job.state = "completed";
} catch (error) {
  job.state = controller.signal.aborted ? "cancelled" : "failed";
  job.error = error.message;
  if (fs.existsSync(path.join(dir, "stdout.txt"))) job.raw_sha256 = digest(fs.readFileSync(path.join(dir, "stdout.txt")));
  job.result = null;
} finally {
  job.completed = new Date().toISOString(); persist();
}
