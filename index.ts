// spec-flow index.ts — pi extension adapter
// Thin wrapper: registerTool ×6 + tool_call intercept + session_start summary
// All long-running work (gates, e2e, pi audit subprocess) is async — the
// event loop stays free so the TUI never freezes while waiting.
// Lifecycle tools (begin/impl/audit/attest/done) resolve the real spec path and
// hold the per-file mutation queue for the whole read-modify-write window;
// failures are thrown — Pi turns a thrown execute() into a real error result.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import {
  board,
  begin,
  impl,
  audit,
  attest,
  done,
  findSpec,
  loadSpecs,
  commitGateDecision,
  appendCommitLedger,
  isCommitCommand,
  nextStep,
  renderBoard,
  renderSpecDetail,
} from "./core.mjs";
import { attestationGate, truncateToolText } from "./adapter-core.mjs";

// Track latest session cwd — command completions have no ctx
let lastCwd = process.cwd();

// Resolve the REAL spec file first, then run the whole read-modify-write window
// under the same per-file queue as built-in edit/write. The returned promise is
// awaited by withFileMutationQueue, so the queue is held until the mutation
// (and its writes) finish. Tool failures propagate to Pi.
async function runSpecMutation<T>(
  cwd: string,
  id: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const spec = findSpec(cwd, id);
  if (!spec) throw new Error(`Spec ${id} not found`);
  return withFileMutationQueue(resolve(spec.path), async () => fn());
}

function toolResult(text: string) {
  return {
    content: [{ type: "text" as const, text: truncateToolText(text) }],
    details: {},
  };
}

export default function (pi: ExtensionAPI) {
  // ─── Register tools ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "spec_board",
    label: "Spec Board",
    description: "Show all specs with status and drift detection",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return toolResult(board(ctx.cwd));
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
      const output = await runSpecMutation(ctx.cwd, params.id, () =>
        begin(ctx.cwd, params.id, { signal })
      );
      return toolResult(output);
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
      const output = await runSpecMutation(ctx.cwd, params.id, () =>
        impl(ctx.cwd, params.id, {
          signal,
          onGate: (name) => {
            if (ctx.hasUI) {
              ctx.ui.notify(`⏳ spec-flow: 门禁 ${name} 运行中…`, "info");
            }
          },
          onDiagnostic: (message: string) => {
            if (ctx.hasUI) ctx.ui.notify(`⚠️ spec-flow: ${message}`, "warning");
          },
        })
      );
      return toolResult(output);
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
      if (ctx.hasUI) {
        ctx.ui.notify(
          "🔍 spec-flow: 独立审计运行中（可 Esc 中断，输入会排队到结束后处理）…",
          "info"
        );
      }
      // Heartbeat: keep the tool view alive so it never looks frozen
      const started = Date.now();
      const heartbeat = setInterval(() => {
        const secs = Math.round((Date.now() - started) / 1000);
        onUpdate?.({
          content: [{ type: "text", text: `⏳ 审计运行中 ${secs}s…（Esc 可中断）` }],
        });
      }, 5000);
      try {
        const output = await runSpecMutation(ctx.cwd, params.id, () =>
          audit(ctx.cwd, params.id, {
            signal,
            onProgress: (text) =>
              onUpdate?.({
                content: [{ type: "text", text: truncateToolText(text) }],
              }),
          })
        );
        return toolResult(output);
      } finally {
        clearInterval(heartbeat);
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Human gate: reject without a real UI; otherwise show item+note and ask.
      // The dialog stays OUTSIDE the mutation queue (a user may take minutes).
      const gate = await attestationGate({
        hasUI: ctx.hasUI,
        confirm: ctx.ui?.confirm?.bind(ctx.ui),
        id: params.id,
        item: params.item,
        note: params.note,
        signal,
      });

      if (gate.reason === "no-ui") {
        throw new Error(
          "spec_attest 需要交互式 UI 用户确认；当前模式无 UI，未写入。" +
            "如需显式登记，请在 CLI 运行：node core.mjs attest <id> <item> <note>"
        );
      }
      if (!gate.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Spec ${params.id}: 用户未确认，人工核验未写入。`,
            },
          ],
          details: { confirmed: false },
        };
      }

      const output = await runSpecMutation(ctx.cwd, params.id, () =>
        attest(ctx.cwd, params.id, params.item, params.note)
      );
      return toolResult(output);
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
      const output = await runSpecMutation(ctx.cwd, params.id, () =>
        done(ctx.cwd, params.id, { signal })
      );
      return toolResult(output);
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
          ctx.ui.notify("spec-flow: 当前项目无支持的 spec/ 目录（docs/spec(s)、spec(s)）", "warning");
        } else {
          ctx.ui.notify(truncateToolText(text), "info");
        }
      } catch (e: any) {
        ctx.ui.notify(`spec-flow: ${e.message}`, "error");
      }
    },
  });

  // ─── tool_call intercept: git commit → gate check ────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    // 防御（2026-08-14 事故复盘）：拦截器自身故障必须 fail-open 放行 + 告警，
    // 不能拖死全局 bash 工具——门禁是减速带不是安全边界（spec 7 §9）。
    // 事故形态：热重载中间态导致 _core.isCommitCommand undefined，
    // TypeError 被 pi 当作工具错误返回，所有 bash 调用（含 echo）瘫痪 2 小时。
    try {
      if (event.toolName !== "bash") return;
      const command = (event.input as any).command || "";

      // Quick exit: not a git commit command (avoid unnecessary gate IO)
      if (typeof isCommitCommand !== "function" || !isCommitCommand(command)) return;

      // IO: resolve the ACTUAL target repo (cd / git -C), then run ITS gates
      // (async — TUI stays responsive while waiting)
      const decision = await commitGateDecision(ctx.cwd, command, {
        signal: ctx.signal,
        onGate: (name: string) =>
          ctx.ui.notify(`⏳ spec-flow: 门禁 ${name} 运行中…`, "info"),
      });
      for (const message of decision.diagnostics || []) {
        ctx.ui.notify(`⚠️ spec-flow: ${message}`, "warning");
      }

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
    } catch (e: any) {
      ctx.ui.notify?.(
        `⚠️ spec-flow 拦截器故障（已放行本次 bash）：${e?.message ?? e}`,
        "warning"
      );
      return; // fail-open：不返回 block
    }
  });

  // ─── session_start: notify active specs ──────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    lastCwd = ctx.cwd;
    if (!ctx.hasUI) return; // print/JSON mode: UI methods are no-ops
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

