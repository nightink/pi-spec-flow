// Local acceptance smoke: load the real installed Pi host without invoking a model.
import { spawnSync } from "node:child_process";

const input = [
  JSON.stringify({ id: "commands", type: "get_commands" }),
  JSON.stringify({ id: "spec", type: "prompt", message: "/spec" }),
  "",
].join("\n");

const result = spawnSync(
  process.env.SPECFLOW_PI_BIN || "pi",
  [
    "--mode",
    "rpc",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ],
  {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  }
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`pi RPC exited ${result.status}: ${(result.stderr || "").slice(0, 1000)}`);
}

const messages = result.stdout
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const commands = messages.find(
  (message) => message.type === "response" && message.id === "commands"
);
const specCommand = commands?.data?.commands?.find(
  (command) => command.name === "spec" && command.source === "extension"
);
const boardNotification = messages.find(
  (message) =>
    message.type === "extension_ui_request" &&
    message.method === "notify" &&
    typeof message.message === "string" &&
    message.message.includes("spec-flow board")
);
const promptResponse = messages.find(
  (message) => message.type === "response" && message.id === "spec"
);

if (!specCommand) throw new Error("real Pi host did not discover the /spec extension command");
if (!boardNotification) throw new Error("/spec did not render the spec-flow board through Pi UI");
if (promptResponse?.success !== true) throw new Error("/spec RPC command did not succeed");

console.log("PASS real Pi host discovered the /spec extension command");
console.log("PASS /spec rendered the board without a model call");
