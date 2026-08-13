// spec-flow index.ts — pi extension adapter
// Thin wrapper: registerTool ×6 + tool_call intercept + session_start summary
// All long-running work (gates, e2e, pi audit subprocess) is async — the
// event loop stays free so the TUI never freezes while waiting.

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
  parseFrontmatter,
  commitGateDecision,
  appendCommitLedger,
  isCommitCommand,
  nextStep,
  renderBoard,
  renderSpecDetail,
} from "./core.mjs";

// Track latest session cwd — command completions have no ctx
let lastCwd = process.cwd();

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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const output = await begin(ctx.cwd, params.id, { signal });
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const output = await impl(ctx.cwd, params.id, {
          signal,
          onGate: (name) =>
            ctx.ui.notify(`⏳ spec-flow: 门禁 ${name} 运行中…`, "info"),
        });
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
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        ctx.ui.notify(
          "🔍 spec-flow: 独立审计运行中（可 Esc 中断，输入会排队到结束后处理）…",
          "info"
        );
        // Heartbeat: keep the tool view alive so it never looks frozen
        const started = Date.now();
        const heartbeat = setInterval(() => {
          const secs = Math.round((Date.now() - started) / 1000);
          onUpdate?.({
            content: [{ type: "text", text: `⏳ 审计运行中 ${secs}s…（Esc 可中断）` }],
          });
        }, 5000);
        try {
          const output = await audit(ctx.cwd, params.id, {
            signal,
            onProgress: (text) =>
              onUpdate?.({ content: [{ type: "text", text }] }),
          });
          return { content: [{ type: "text", text: output }], details: {} };
        } finally {
          clearInterval(heartbeat);
        }
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const output = await done(ctx.cwd, params.id, { signal });
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

  // ─── /spec command: project spec board ───────────────────────────────────
  pi.registerCommand("spec", {
    description: "spec-flow: 当前项目 spec 看板（/spec board；/spec <id> 看单个详情）",
    getArgumentCompletions: (prefix: string) => {
      try {
        const ids = loadSpecs(lastCwd).map((s) => ({
          value: s.frontmatter?.id || s.file,
          label: s.frontmatter?.id ? s.file : undefined,
        }));
        const items = [
          { value: "board", label: "看板" },
          ...ids,
        ].filter((i) => i.value.startsWith(prefix));
        return items.length > 0 ? items : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      try {
        const arg = args.trim();
        const text =
          arg && arg !== "board"
            ? await renderSpecDetail(ctx.cwd, arg, ctx.signal)
            : await renderBoard(ctx.cwd, ctx.signal);
        if (text === null) {
          ctx.ui.notify(`spec-flow: 未找到 spec ${arg}`, "warning");
        } else if (text === "") {
          ctx.ui.notify("spec-flow: 当前项目无 docs/specs/ 目录", "warning");
        } else {
          ctx.ui.notify(text, "info");
        }
      } catch (e: any) {
        ctx.ui.notify(`spec-flow: ${e.message}`, "error");
      }
    },
  });

  // ─── tool_call intercept: git commit → gate check ────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as any).command || "";

    // Quick exit: not a git commit command (avoid unnecessary gate IO)
    if (!isCommitCommand(command)) return;

    // IO: resolve the ACTUAL target repo (cd / git -C), then run ITS gates
    // (async — TUI stays responsive while waiting)
    const decision = await commitGateDecision(ctx.cwd, command, {
      signal: ctx.signal,
      onGate: (name: string) =>
        ctx.ui.notify(`⏳ spec-flow: 门禁 ${name} 运行中…`, "info"),
    });

    // Ledger write helper: write to the target repo, fall back to session cwd.
    // targetRepo is "unknown" when the target could not be resolved (S1.1).
    const writeLedger = (event: any) => {
      appendCommitLedger(decision, event, ctx.cwd);
    };

    if (decision.action === "allow") {
      // External repo with no gates → record, then allow silently
      if (decision.external) {
        writeLedger({
          type: "allow-external",
          command: command.slice(0, 200),
        });
      }
      return;
    }

    if (decision.action === "bypass") {
      ctx.ui.notify(
        "⚠️ spec-flow: SPECFLOW_BYPASS=1 detected, allowing commit despite gate failures",
        "warning"
      );
      writeLedger({
        type: "bypass",
        gates: decision.gateResults,
        command: command.slice(0, 200),
      });
      return;
    }

    // block — reason already includes failed gate names + tail summaries
    return { block: true, reason: decision.reason };
  });

  // ─── session_start: notify active specs ──────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    lastCwd = ctx.cwd;
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
        const suggestion = await nextStep(ctx.cwd, spec, ctx.signal);
        lines.push(`  • ${id} (base=${baseSha}) — ${suggestion}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    } catch {
      // silent on error
    }
  });
}

