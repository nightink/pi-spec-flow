// spec-flow index.ts — pi extension adapter
// Thin wrapper: registerTool ×6 + tool_call intercept + session_start summary

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  board,
  begin,
  impl,
  audit,
  attest,
  done,
  migrateAlloc,
  checkCI,
  loadSpecs,
  runGates,
  detectProjectConfig,
  parseFrontmatter,
  shouldBypass,
  nextStep,
} from "./core.mjs";

export default function (pi: ExtensionAPI) {
  // ─── Register tools ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "spec_board",
    label: "Spec Board",
    description: "Show all specs with status and drift detection",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const output = board(ctx.cwd);
        return { content: [{ type: "text", text: output }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_begin",
    label: "Spec Begin",
    description: "Start a spec (set status=in-progress, record base_sha)",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID (e.g., S3.13)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const output = begin(ctx.cwd, params.id);
        return { content: [{ type: "text", text: output }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_impl",
    label: "Spec Impl",
    description: "Run gates and e2e for a spec, record results",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const output = impl(ctx.cwd, params.id);
        return { content: [{ type: "text", text: output }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_audit",
    label: "Spec Audit",
    description: "Independent LLM audit of spec vs diff",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const output = await audit(ctx.cwd, params.id);
        return { content: [{ type: "text", text: output }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_attest",
    label: "Spec Attest",
    description: "Register human verification for a spec",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
      item: Type.String({ description: "Human evidence item (e.g., R1)" }),
      note: Type.String({
        description: "Verification note (≥20 chars, describe path and sample)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const output = attest(ctx.cwd, params.id, params.item, params.note);
        return { content: [{ type: "text", text: output }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_done",
    label: "Spec Done",
    description: "Finalize a spec (check impl+audit+human, set status=done)",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const output = done(ctx.cwd, params.id);
        return { content: [{ type: "text", text: output }], details: {} };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ─── tool_call intercept: git commit → gate check ────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as any).command || "";

    // Match git commit (with optional env vars like SPECFLOW_BYPASS=1)
    const commitMatch = /(^|[;&|]\s*)(?:\S+=\S+\s+)*git\s+commit/.exec(command);
    if (!commitMatch) return;

    // Check bypass — only match env prefix, not substrings in messages
    const hasBypass = shouldBypass(command);

    // Run gates (prefer cache)
    const config = detectProjectConfig(ctx.cwd);
    if (config.gates.length === 0) return; // no gates, allow

    const gateResults = runGates(ctx.cwd, config.gates);
    const allPass = Object.values(gateResults).every((r) => r.pass);

    if (allPass) return; // gates green, allow

    // Gates red
    if (hasBypass) {
      ctx.ui.notify(
        "⚠️ spec-flow: SPECFLOW_BYPASS=1 detected, allowing commit despite gate failures",
        "warning"
      );
      // Log bypass to ledger
      const { appendLedger } = await import("./core.mjs");
      appendLedger(ctx.cwd, {
        type: "bypass",
        gates: gateResults,
        command: command.slice(0, 200),
      });
      return; // allow
    }

    // Block
    const failedGates = Object.entries(gateResults)
      .filter(([_, v]) => !v.pass)
      .map(([name, v]) => `${name}:\n${v.tail}`);

    return {
      block: true,
      reason: `spec-flow: 门禁未通过，禁止 commit\n\n${failedGates.join("\n\n")}`,
    };
  });

  // ─── session_start: notify active specs ──────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    try {
      const specs = loadSpecs(ctx.cwd);
      const active = specs.filter(
        (s) => s.hasFrontmatter && s.frontmatter?.status === "in-progress"
      );
      if (active.length === 0) return; // silent

      const lines = [`📋 spec-flow: ${active.length} 个进行中 spec`];
      for (const spec of active) {
        const fm = spec.frontmatter!;
        const id = fm.id || spec.file;
        const baseSha = fm.impl?.base_sha?.slice(0, 8) || "?";
        const suggestion = nextStep(ctx.cwd, spec);
        lines.push(`  • ${id} (base=${baseSha}) — ${suggestion}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    } catch {
      // silent on error
    }
  });
}
