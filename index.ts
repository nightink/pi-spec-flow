// spec-flow index.ts — pi extension adapter (thin wrapper over core.mjs)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORE = join(__dirname, "core.mjs");

function runCore(args: string, cwd: string): string {
  try {
    return execSync(`node ${CORE} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 300000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    }).trim();
  } catch (err: any) {
    const out = (err.stdout || "") + (err.stderr || "");
    return out || err.message;
  }
}

export default function (pi: ExtensionAPI) {
  // ─── Tools ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "spec_board",
    label: "Spec Board",
    description: "Show all specs with status, drift detection, and evidence validation",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const out = runCore("board", ctx.cwd);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "spec_begin",
    label: "Spec Begin",
    description: "Start a spec (requires approved review + deps done). Sets status=in-progress, records base_sha.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID, e.g. S3.13" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out = runCore(`begin ${params.id}`, ctx.cwd);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "spec_impl",
    label: "Spec Impl",
    description: "Run gates + e2e for a spec. Records impl{at,gates,e2e} on success.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out = runCore(`impl ${params.id}`, ctx.cwd);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "spec_audit",
    label: "Spec Audit",
    description: "Independent LLM audit of spec vs diff. Writes audit{at,sha,verdict,findings}.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out = runCore(`audit ${params.id}`, ctx.cwd);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "spec_attest",
    label: "Spec Attest",
    description: "Register human verification for a spec evidence item. Note must be ≥20 chars with audit trail.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
      item: Type.String({ description: "Evidence item identifier, e.g. R1" }),
      note: Type.String({ description: "Verification note (≥20 chars): what you checked, sample, method" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out = runCore(`attest ${params.id} ${params.item} ${params.note}`, ctx.cwd);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "spec_done",
    label: "Spec Done",
    description: "Final gate: checks impl pass + audit pass + sha fresh + human attested. Sets status=done.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out = runCore(`done ${params.id}`, ctx.cwd);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  // ─── Commit interception ─────────────────────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: string };
    if (!input.command) return;

    // Check for git commit
    if (!/(^|[;&|]\s*)git\s+commit/.test(input.command)) return;

    // Check for bypass
    if (input.command.includes("SPECFLOW_BYPASS=1")) {
      ctx.ui.notify("spec-flow: commit bypassed via SPECFLOW_BYPASS=1", "warning");
      // Log bypass to ledger
      const ledgerPath = join(ctx.cwd, ".spec-flow-ledger.jsonl");
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        ledgerPath,
        JSON.stringify({ event: "bypass", ts: new Date().toISOString(), command: input.command }) + "\n"
      );
      return; // allow
    }

    // Run gates (prefer cache)
    const gateOut = runCore("check --ci", ctx.cwd);
    let parsed: { ok: boolean; issues?: string[] };
    try {
      parsed = JSON.parse(gateOut);
    } catch {
      parsed = { ok: false, issues: [`Failed to parse gate output: ${gateOut.slice(0, 200)}`] };
    }

    if (!parsed.ok) {
      const failedGates = (parsed.issues || [])
        .filter((i) => i.startsWith("GATE "))
        .map((i) => i.split("\n")[0])
        .join("; ");
      const tail = (parsed.issues || []).join("\n").split("\n").slice(-10).join("\n");
      return {
        block: true,
        reason: `spec-flow: gates red — ${failedGates}\n\nLast output:\n${tail}`,
      };
    }
  });

  // ─── Session start summary ───────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const out = runCore("board", ctx.cwd);
    let rows: Array<{ id: string; status: string }>;
    try {
      rows = JSON.parse(out);
    } catch {
      return; // silent
    }

    const inProgress = rows.filter((r) => r.status === "进行中");
    if (inProgress.length === 0) return; // silent

    const summary = inProgress
      .map((r) => `  • ${r.id}: ${r.status}`)
      .join("\n");
    ctx.ui.notify(`spec-flow: ${inProgress.length} spec(s) in progress:\n${summary}`, "info");
  });
}
