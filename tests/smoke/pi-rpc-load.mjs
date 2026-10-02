// Real Pi RPC acceptance without a model call. Keep stdin open until both the
// extension notification and correlated response arrive; prompt acceptance/EOF
// alone cannot prove completion of an async worktree inventory.
import { spawn } from "node:child_process";

const child = spawn(process.env.SPECFLOW_PI_BIN || "pi", [
  "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files",
], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
const messages = [];
let buffer = "", outputBytes = 0, failure = null;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  outputBytes += Buffer.byteLength(chunk);
  if (outputBytes > 16 * 1024 * 1024) { failure = new Error("Pi RPC smoke exceeded output budget"); child.kill(); return; }
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
    if (line) {
      try { messages.push(JSON.parse(line)); }
      catch { failure = new Error("Pi RPC emitted invalid JSONL"); }
    }
  }
});
// Drain diagnostics without printing credential-bearing provider/environment output.
child.stderr.on("data", () => {});
child.on("error", (error) => failure = error);
const closed = new Promise((resolve) => child.on("close", resolve));
async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode) throw new Error("Pi RPC host exited before acceptance completed");
    if (Date.now() - started > 60000) throw new Error("Pi RPC smoke timed out waiting for command completion");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function send(message) { child.stdin.write(JSON.stringify(message) + "\n"); }
function response(id) { return messages.find((message) => message.type === "response" && message.id === id); }
function notification(fragment) {
  return messages.some((message) => message.type === "extension_ui_request" && message.method === "notify" && message.message?.includes(fragment));
}
try {
  send({ id: "commands", type: "get_commands" }); await waitFor(() => response("commands"));
  if (!response("commands").data?.commands?.some((command) => command.name === "spec" && command.source === "extension")) {
    throw new Error("real Pi host did not discover /spec");
  }
  console.log("PASS real Pi host discovered the /spec extension command");
  for (const [id, message, fragment] of [["spec", "/spec", "spec-flow board"], ["worktrees", "/spec worktrees", "spec-flow worktrees"]]) {
    send({ id, type: "prompt", message });
    await waitFor(() => response(id) && notification(fragment));
    if (response(id).success !== true) throw new Error(`${message} RPC command failed`);
    console.log(`PASS ${message} rendered through real Pi without a model call`);
  }
  if (messages.some((message) => message.type === "agent_start")) throw new Error("Smoke unexpectedly invoked a model");
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGTERM"), 1000);
  await closed; clearTimeout(timer);
}
