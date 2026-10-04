// spec-flow index.ts — pi extension adapter
// Thin wrapper: lifecycle/allocation tools + tool_call intercept + session_start summary
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
  allocateSpecId,
  newSpec,
  reviewSpec,
  renderWorktrees,
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

function structuredResult(value: any) {
  return { ...toolResult(JSON.stringify(value, null, 2)), details: value, structuredContent: value };
}
const stringList = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { minItems: 1, maxItems: 100 });
const newParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 300 }), prefix: Type.Optional(Type.String({ maxLength: 80 })),
  slug: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 80 })),
  goals: Type.Optional(stringList), nonGoals: Type.Optional(stringList), design: Type.Optional(stringList),
  plan: Type.Optional(stringList), acceptance: Type.Optional(stringList),
  dependencies: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Integer({ minimum: 0 })]), { maxItems: 100 })),
  dryRun: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const reviewParameters = Type.Union([
  Type.Object({ action: Type.Optional(Type.Literal("prepare")),
    mode: Type.Optional(Type.Union([Type.Literal("proposal"), Type.Literal("committed"), Type.Literal("incremental")])),
    id: Type.Optional(Type.String()), specPath: Type.Optional(Type.String()),
    base: Type.Optional(Type.String()), head: Type.Optional(Type.String()), previousReview: Type.Optional(Type.String()),
    allowDirty: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("run"), jobId: Type.String(), budgetId: Type.Optional(Type.String()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status"), jobId: Type.String() }, { additionalProperties: false }),
]);

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
    name: "spec_alloc",
    label: "Spec ID Allocate",
    description: "Reserve a unique Spec ID across this repository's Git worktrees (local Git common directory)",
    parameters: Type.Object({ prefix: Type.Optional(Type.String({ description: "Optional numeric namespace prefix, e.g. S1. (default: numeric IDs)" })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await allocateSpecId(ctx.cwd, params.prefix || ""));
    },
  });

  pi.registerTool({
    name: "spec_new", label: "Spec New",
    description: "Create an unapproved draft from the fixed versioned template using a shared-family unique ID; no lifecycle evidence. dryRun previews without allocation.",
    promptSnippet: "Create a deterministic, unapproved Spec draft (or dry-run its template).",
    promptGuidelines: ["Use spec_new rather than inventing frontmatter/sections. Complete the project contract and obtain proposal approval before spec_begin."],
    parameters: newParameters,
    outputSchema: Type.Object({ id: Type.Optional(Type.String()), path: Type.Optional(Type.String()), status: Type.String(),
      template: Type.Object({ version: Type.Integer(), sha256: Type.String() }),
      dryRun: Type.Optional(Type.Boolean()), directory: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) { return structuredResult(await newSpec(ctx.cwd, params)); },
  });
  pi.registerTool({
    name: "spec_review", label: "Spec Review",
    description: "Read-only isolated proposal/explicit committed hash-diff/incremental review. prepare/status are free; run consumes an existing user-authorized delivery-cycle grant once. Never writes lifecycle audit or closes a Spec.",
    promptSnippet: "Prepare/run/inspect a sealed, hash-bound independent review without changing Spec lifecycle.",
    promptGuidelines: ["Discovery/prepare never call a provider. Ask for explicit paid review authorization; this tool cannot grant/reset budgets. Delta PASS does not mean full Spec acceptance."],
    parameters: reviewParameters,
    outputSchema: Type.Object({ version: Type.Integer(), jobId: Type.String(), mode: Type.String(), state: Type.String(),
      modelInvoked: Type.Boolean(), receipt: Type.Any(), packetPath: Type.String(), result: Type.Any(),
      executionInfo: Type.Optional(Type.Object({ action: Type.String(), requestedTimeoutMs: Type.Union([Type.Integer(), Type.Null()]),
        effectiveTimeoutMs: Type.Union([Type.Integer(), Type.Null()]), requestValid: Type.Boolean(),
        timeoutApplied: Type.Boolean(), timeoutIgnored: Type.Boolean(), message: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return structuredResult(await reviewSpec(ctx.cwd, params, { signal,
        onProgress: (text: string) => onUpdate?.({ content: [{ type: "text", text: truncateToolText(text) }] }),
      }));
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
    description: "Independent full current working-tree audit via the sealed review engine; existing authorized grant required for a fresh call. Can attach only a matching working-tree-audit job, never ordinary/delta approval.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
      budgetId: Type.Optional(Type.String({ description: "Existing user-authorized delivery-cycle grant" })),
      reviewJobId: Type.Optional(Type.String({ description: "Matching prepared/completed full working-tree audit job to resume/attach, without duplicate invocation" })),
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
            signal, budgetId: params.budgetId, reviewJobId: params.reviewJobId,
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
          value: String(s.frontmatter?.id ?? s.file),
          label: s.frontmatter?.id !== undefined ? s.file : undefined,
        }));
        const items = [
          { value: "board", label: "看板" },
          { value: "worktrees", label: "并行 worktree 看板（实时快照）" },
          { value: "new", label: "固定模板草案：/spec new <JSON>" },
          { value: "review", label: "封存审查：/spec review <JSON>" },
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
        if (/^(new|review)(?:\s|$)/.test(arg)) {
          const split = arg.indexOf(" ");
          if (split < 0) throw new Error("Use /spec new <JSON> or /spec review <JSON>");
          const input = JSON.parse(arg.slice(split + 1));
          const result = arg.slice(0, split) === "new" ? await newSpec(ctx.cwd, input) : await reviewSpec(ctx.cwd, input, { signal: ctx.signal });
          ctx.ui.notify(truncateToolText(JSON.stringify(result, null, 2)), "info");
          return;
        }
        const text =
          arg === "worktrees" ? await renderWorktrees(ctx.cwd) :
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
        (s) =>
          s.hasFrontmatter &&
          s.frontmatter?.status === s.profile?.lifecycle?.active
      );
      if (active.length === 0) return; // silent

      const lines = [`📋 spec-flow: ${active.length} 个进行中 spec`];
      for (const spec of active) {
        const fm = spec.frontmatter!;
        const id = fm.id ?? spec.file;
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

