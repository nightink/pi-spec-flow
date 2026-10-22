// spec-flow index.ts — pi extension adapter
// Thin wrapper: lifecycle/allocation tools + tool_call intercept + session_start summary
// All long-running work (gates, e2e, pi audit subprocess) is async — the
// event loop stays free so the TUI never freezes while waiting.
// Lifecycle tools (begin/impl/audit/attest/done) resolve the real spec path and
// hold the per-file mutation queue for the whole read-modify-write window.
// Invalid input throws; machine outcomes (impl/audit/board diagnostics) return
// isError + structuredContent so agents never parse emoji or prose.

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  allocateSpecId,
  appendCommitLedger,
  attest,
  auditOutcome,
  begin,
  commitGateDecision,
  done,
  findSpec,
  implOutcome,
  inspectBoard,
  isCommitCommand,
  loadSpecs,
  newSpec,
  nextStep,
  prepareAudit,
  renderBoard,
  renderSpecDetail,
  renderWorktrees,
  reviewSpec,
} from "@nightink/spec-flow-core";
// The adapter, not the engine, owns the harness launch protocol. Other agent
// adapters import their own executor module here; see docs/adapters.md.
import {
  buildArgs as buildPiReviewArgs,
  envDeny as piReviewEnvDeny,
  envSet as piReviewEnvSet,
  resolve as resolvePiReviewExecution,
} from "@nightink/spec-flow-core/executors/pi-cli";

import { Type } from "typebox";
import {
  attestationGate,
  failureResult,
  formatBoardText,
  formatOutcomeText,
  formatReviewSummary,
  notifySafely,
  truncateToolText,
  updateToolProgress,
} from "./adapter-core.mjs";

const reviewExecutor = {
  resolve: resolvePiReviewExecution,
  buildArgs: buildPiReviewArgs,
  envDeny: piReviewEnvDeny,
  envSet: piReviewEnvSet,
};

// Track latest session cwd — command completions have no ctx
let lastCwd = process.cwd();

// Resolve the REAL spec file first, then run the whole read-modify-write window
// under the same per-file queue as built-in edit/write. The returned promise is
// awaited by withFileMutationQueue, so the queue is held until the mutation
// (and its writes) finish. Tool failures propagate to Pi.
async function runSpecMutation<T>(cwd: string, id: string, fn: () => T | Promise<T>): Promise<T> {
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

function structuredResult(value: unknown) {
  return {
    ...toolResult(JSON.stringify(value, null, 2)),
    details: value,
    structuredContent: value,
  };
}

// Structured machine outcome with bounded, recovery-first model text. A failed
// product/tool outcome is a real error result while keeping structuredContent.
function dataResult(value: unknown, text: string) {
  return {
    content: [{ type: "text" as const, text: truncateToolText(text) }],
    details: value,
    structuredContent: value,
  };
}

function outcomeResult(value: { pass?: boolean }, text: string) {
  const result = dataResult(value, text);
  return value.pass === true ? result : { ...result, isError: true };
}

function hasDiagnostic(error: unknown): error is Error & { diagnostic: unknown } {
  return Boolean(error) && typeof error === "object" && "diagnostic" in (error as object);
}
const stringList = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), {
  minItems: 1,
  maxItems: 100,
});
// Shared recovery action shape: tool + exact args + why, and whether a human
// or an existing authorization is still required. Never invent consent.
const nextActionSchema = Type.Object(
  {
    tool: Type.String(),
    args: Type.Object({}, { additionalProperties: true }),
    reason: Type.String(),
    requiresAuthorization: Type.Boolean(),
    requiresHuman: Type.Boolean(),
  },
  { additionalProperties: false },
);
// Optional failure-envelope fields keep every schema an explicit object root
// while letting scripts read core diagnostics under isError (no silent drop).
const diagnosticFields = {
  // failureResult() adds these two so the structured failure envelope stays a
  // valid instance of the same declared output schema as the success value.
  operation: Type.Optional(Type.String()),
  specId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pass: Type.Optional(Type.Boolean()),
  category: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  nextActions: Type.Optional(Type.Array(nextActionSchema)),
  diagnostic: Type.Optional(Type.Any()),
};
const maxBytesSchema = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: 16777216,
    description:
      "prepare packet byte limit (1..16777216); explicit > SPECFLOW_AUDIT_MAX_BYTES > 524288. Bytes, not a model token capacity.",
  }),
);
const outcomeSchema = Type.Object(
  {
    version: Type.Integer(),
    operation: Type.Union([Type.Literal("impl"), Type.Literal("audit")]),
    specId: Type.String(),
    pass: Type.Boolean(),
    category: Type.String(),
    summary: Type.String(),
    nextActions: Type.Array(nextActionSchema),
    jobId: Type.Optional(Type.String()),
    packetPath: Type.Optional(Type.String()),
    diagnostic: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);
const newParameters = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 300 }),
    prefix: Type.Optional(Type.String({ maxLength: 80 })),
    slug: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 80 })),
    goals: Type.Optional(stringList),
    nonGoals: Type.Optional(stringList),
    design: Type.Optional(stringList),
    plan: Type.Optional(stringList),
    acceptance: Type.Optional(stringList),
    dependencies: Type.Optional(
      Type.Array(Type.Union([Type.String(), Type.Integer({ minimum: 0 })]), { maxItems: 100 }),
    ),
    dryRun: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
// Providers require an explicit object root, not a root union of action objects.
// Keep action-specific required/forbidden fields enforced by the shared engine;
// do not drop fields here or a malformed request could become a paid run.
const reviewParameters = Type.Object(
  {
    action: Type.Optional(
      Type.Union(
        [
          Type.Literal("prepare"),
          Type.Literal("run"),
          Type.Literal("status"),
          Type.Literal("repair"),
        ],
        {
          description:
            "Default prepare. run/status/repair require jobId. repair is zero-model, lossless retained-output recovery, with no budget or semantic edits. Only prepare accepts mode/id/specPath/base/head/previousReview/allowDirty; only run accepts budgetId.",
        },
      ),
    ),
    mode: Type.Optional(
      Type.Union(
        [Type.Literal("proposal"), Type.Literal("committed"), Type.Literal("incremental")],
        { description: "prepare only; default committed" },
      ),
    ),
    id: Type.Optional(Type.String({ description: "prepare only; Spec ID or use specPath" })),
    specPath: Type.Optional(Type.String({ description: "prepare only; governing Spec path" })),
    base: Type.Optional(
      Type.String({ description: "prepare only; required with head for committed/incremental" }),
    ),
    head: Type.Optional(
      Type.String({ description: "prepare only; required with base for committed/incremental" }),
    ),
    previousReview: Type.Optional(
      Type.String({ description: "prepare only; prior job for incremental review" }),
    ),
    allowDirty: Type.Optional(
      Type.Boolean({
        description: "prepare only; explicitly accept committed-only dirty exclusions",
      }),
    ),
    jobId: Type.Optional(
      Type.String({ description: "Required for run/status/repair; forbidden for prepare" }),
    ),
    budgetId: Type.Optional(
      Type.String({
        description:
          "run only; existing user-authorized delivery-cycle grant, never a new authorization",
      }),
    ),
    maxBytes: maxBytesSchema,
  },
  { additionalProperties: false },
);

export default function (pi: ExtensionAPI) {
  // ─── Register tools ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "spec_board",
    label: "Spec Board",
    description:
      "Inspect specs with stage, blockers and exact nextActions. Default freshness=record-only (does not read the current checkout); live=true compares active implementation/contract evidence.",
    promptSnippet:
      "Show spec stages, blockers and executable nextActions; default is record-only, live=true checks freshness.",
    promptGuidelines: [
      "Record-only means the board did not verify the current checkout; do not claim freshness or close on it. Use live=true when implementation state matters.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional single Spec ID" })),
      live: Type.Optional(
        Type.Boolean({
          description: "Compare current checkout freshness; default false (record-only)",
        }),
      ),
    }),
    // Success always fills freshness/specs/summary; they stay optional so the
    // shared structured failure envelope (isError + diagnostic) is still a
    // valid instance of this declared schema.
    outputSchema: Type.Object(
      {
        version: Type.Integer(),
        freshness: Type.Optional(Type.Union([Type.Literal("record-only"), Type.Literal("live")])),
        note: Type.Optional(Type.String()),
        specs: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.String(),
                file: Type.Optional(Type.String()),
                status: Type.Optional(Type.String()),
                statusLabel: Type.Optional(Type.String()),
                stage: Type.String(),
                fresh: Type.Union([Type.Boolean(), Type.Null()]),
                blockers: Type.Array(Type.String()),
                nextActions: Type.Array(nextActionSchema),
              },
              { additionalProperties: false },
            ),
          ),
        ),
        summary: Type.Optional(
          Type.Union([
            Type.String(),
            Type.Object(
              {
                total: Type.Integer(),
                managed: Type.Integer(),
                unmanaged: Type.Integer(),
                active: Type.Integer(),
                fresh: Type.Integer(),
                stale: Type.Integer(),
                actionable: Type.Integer(),
                blocked: Type.Integer(),
              },
              { additionalProperties: false },
            ),
          ]),
        ),
        ...diagnosticFields,
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await inspectBoard(ctx.cwd, {
          id: params.id,
          live: params.live === true,
          signal,
        });
        return dataResult(result, formatBoardText(result));
      } catch (error) {
        if (hasDiagnostic(error)) return failureResult(error, "board", {});
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "spec_alloc",
    label: "Spec ID Allocate",
    description:
      "Reserve a unique Spec ID across this repository's Git worktrees (local Git common directory)",
    parameters: Type.Object({
      prefix: Type.Optional(
        Type.String({
          description: "Optional numeric namespace prefix, e.g. S1. (default: numeric IDs)",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        version: Type.Integer(),
        id: Type.Optional(Type.String()),
        ...diagnosticFields,
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        return toolResult(await allocateSpecId(ctx.cwd, params.prefix || ""));
      } catch (error) {
        // A12: unreadable/prunable family members stay fail-closed but become
        // structured machine diagnostics instead of a bare Git error.
        if (hasDiagnostic(error)) return failureResult(error, "alloc", {});
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "spec_new",
    label: "Spec New",
    description:
      "Create an unapproved draft from the fixed versioned template using a shared-family unique ID; no lifecycle evidence. dryRun previews without allocation.",
    promptSnippet: "Create a deterministic, unapproved Spec draft (or dry-run its template).",
    promptGuidelines: [
      "Use spec_new rather than inventing frontmatter/sections. Complete the project contract and obtain proposal approval before spec_begin.",
      "Reconcile every normative body promise and confirmed major with numbered acceptance and actual entry evidence; a filled matrix or helper capability alone is not proof.",
    ],
    parameters: newParameters,
    outputSchema: Type.Object(
      {
        // The structured failure envelope carries version; success omits it.
        version: Type.Optional(Type.Integer()),
        id: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        template: Type.Optional(Type.Object({ version: Type.Integer(), sha256: Type.String() })),
        dryRun: Type.Optional(Type.Boolean()),
        directory: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        ...diagnosticFields,
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        return structuredResult(await newSpec(ctx.cwd, params));
      } catch (error) {
        if (hasDiagnostic(error)) return failureResult(error, "new", {});
        throw error;
      }
    },
  });
  pi.registerTool({
    name: "spec_review",
    label: "Spec Review",
    description:
      "Project-read-only isolated proposal/committed/incremental review. prepare/status/repair are free; prepare-only maxBytes sets the sealed packet byte limit (explicit > SPECFLOW_AUDIT_MAX_BYTES > 524288). repair creates a lossless derived receipt from retained protocol errors without a model call or budget change. run consumes an existing authorized grant. Never writes lifecycle audit or closes a Spec.",
    promptSnippet:
      "Prepare/run/inspect or freely repair a retained review protocol error without changing Spec lifecycle.",
    promptGuidelines: [
      "Discovery/prepare never call a provider. Ask for explicit paid review authorization; this tool cannot grant/reset budgets. Delta PASS does not mean full Spec acceptance.",
      "For v3, declare optional contract frontmatter review_inputs.context_files (bounded ordinary target-repository callers) and review_inputs.proposal_reviews (retained same-Spec proposal IDs) before impl. No automatic cross-repository crawl or imported approval.",
      "Account every sealed source ID and verify its semantic acceptance/criterion mapping. A coverage gap is not a confirmed product defect; references alone do not prove semantics, runtime acceptance or zero model error. Keep original packet/raw/job for new coverage claims.",
    ],
    parameters: reviewParameters,
    // Success always fills every field below; the optional markers keep the
    // declared schema truthful for the shared structured failure envelope
    // (isError:true + diagnostic) that isError results return instead.
    outputSchema: Type.Object(
      {
        version: Type.Integer(),
        jobId: Type.Optional(Type.String()),
        mode: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
        modelInvoked: Type.Optional(Type.Boolean()),
        receipt: Type.Optional(Type.Any()),
        packetPath: Type.Optional(Type.String()),
        result: Type.Optional(Type.Any()),
        reviewLimit: Type.Optional(Type.Any()),
        outputInfo: Type.Optional(
          Type.Object(
            {
              category: Type.String(),
              code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              repairable: Type.Boolean(),
              rawVerdict: Type.Optional(Type.Any()),
              productCriteria: Type.Optional(Type.Integer()),
              compatibilityApplied: Type.Optional(Type.Boolean()),
              issues: Type.Optional(Type.Array(Type.String())),
              message: Type.String(),
              repairInput: Type.Optional(
                Type.Object(
                  { action: Type.Literal("repair"), jobId: Type.String() },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        executionInfo: Type.Optional(
          Type.Object(
            {
              action: Type.String(),
              requestedTimeoutMs: Type.Union([Type.Integer(), Type.Null()]),
              effectiveTimeoutMs: Type.Union([Type.Integer(), Type.Null()]),
              requestValid: Type.Boolean(),
              timeoutApplied: Type.Boolean(),
              timeoutIgnored: Type.Boolean(),
              message: Type.String(),
            },
            { additionalProperties: false },
          ),
        ),
        ...diagnosticFields,
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, onUpdate, ctx) {
      try {
        const value = await reviewSpec(ctx.cwd, params, {
          signal,
          executor: reviewExecutor,
          onProgress: (text: string) => updateToolProgress(onUpdate, text),
        });
        // Bounded recovery-first text; full receipt remains structured.
        return dataResult(value, formatReviewSummary(value));
      } catch (error) {
        if (hasDiagnostic(error)) return failureResult(error, "review", {});
        throw error;
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
      const output = await runSpecMutation(ctx.cwd, params.id, () =>
        begin(ctx.cwd, params.id, { signal }),
      );
      return toolResult(output);
    },
  });

  pi.registerTool({
    name: "spec_impl",
    label: "Spec Impl",
    description:
      "Run gates and e2e for a spec, record results. A FAIL returns isError with the machine outcome (pass/category/nextActions); PASS returns isError=false.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID" }),
    }),
    outputSchema: outcomeSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const outcome = await runSpecMutation(ctx.cwd, params.id, () =>
          implOutcome(ctx.cwd, params.id, {
            signal,
            onGate: (name: string) => {
              const text = `⏳ spec-flow: 门禁 ${name} 运行中…`;
              updateToolProgress(onUpdate, text);
              notifySafely(ctx, text, "info");
            },
            onDiagnostic: (message: string) => {
              const text = `⚠️ spec-flow: ${message}`;
              updateToolProgress(onUpdate, text);
              notifySafely(ctx, text, "warning");
            },
          }),
        );
        return outcomeResult(outcome, formatOutcomeText(outcome));
      } catch (error) {
        if (hasDiagnostic(error)) return failureResult(error, "impl", { specId: params.id });
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "spec_audit",
    label: "Spec Audit",
    description:
      "Independent full current working-tree audit via the sealed review engine. action=prepare is free (no model, no charge, no Spec write) and returns the sealed job/packet; action=run (default) needs an existing authorized grant or a matching reviewJobId. A prepare result is not PASS and not an error; failed runs return isError with pass/category/nextActions.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("prepare"), Type.Literal("run")], {
          description:
            "Default run. prepare is free and forbids budgetId/reviewJobId; new packet limits are set only by prepare (run/attach reuse the sealed limit). maxBytes is bytes, not a model token capacity.",
        }),
      ),
      id: Type.String({ description: "Spec ID" }),
      maxBytes: maxBytesSchema,
      budgetId: Type.Optional(
        Type.String({ description: "Existing user-authorized delivery-cycle grant" }),
      ),
      reviewJobId: Type.Optional(
        Type.String({
          description:
            "Matching prepared/completed full working-tree audit job to resume/attach, without duplicate invocation; maxBytes is prepare-only and cannot be combined here",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        version: Type.Integer(),
        operation: Type.Optional(Type.Union([Type.Literal("audit"), Type.Literal("prepare")])),
        action: Type.Optional(Type.Union([Type.Literal("prepare"), Type.Literal("run")])),
        specId: Type.String(),
        pass: Type.Optional(Type.Boolean()),
        category: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        nextActions: Type.Optional(Type.Array(nextActionSchema)),
        jobId: Type.Optional(Type.String()),
        packetPath: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
        bytes: Type.Optional(Type.Integer()),
        maxBytes: Type.Optional(Type.Integer()),
        limits: Type.Optional(Type.Any()),
        prepared: Type.Optional(Type.Boolean()),
        packetBytes: Type.Optional(Type.Integer()),
        modelInvoked: Type.Optional(Type.Boolean()),
        receipt: Type.Optional(Type.Any()),
        result: Type.Optional(Type.Any()),
        reviewLimit: Type.Optional(Type.Any()),
        diagnostic: Type.Optional(Type.Any()),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action === "prepare" ? "prepare" : "run";
      // Reject invalid combinations here instead of silently dropping fields;
      // money-adjacent requests must never become a different paid run.
      if (
        action === "prepare" &&
        (params.budgetId !== undefined || params.reviewJobId !== undefined)
      ) {
        throw new Error(
          "spec_audit prepare is free and forbids budgetId/reviewJobId; pass only id and optional maxBytes",
        );
      }
      if (action !== "prepare" && params.maxBytes !== undefined) {
        throw new Error(
          "spec_audit maxBytes is valid only with action=prepare; run/attach reuses the sealed job limit",
        );
      }

      if (action === "prepare") {
        updateToolProgress(
          onUpdate,
          "🧾 spec-flow: 封存 full audit packet（零模型、零计次、不写 Spec）…",
        );
        try {
          const prepared = await prepareAudit(ctx.cwd, params.id, {
            signal,
            maxBytes: params.maxBytes,
            onProgress: (text: string) => updateToolProgress(onUpdate, text),
          });
          const value = { ...prepared, action, specId: params.id };
          return dataResult(value, formatReviewSummary({ ...value, mode: prepared.receipt?.mode }));
        } catch (error) {
          if (hasDiagnostic(error)) return failureResult(error, "audit", { specId: params.id });
          throw error;
        }
      }

      const notice = "🔍 spec-flow: 独立审计运行中（可 Esc 中断，输入会排队到结束后处理）…";
      notifySafely(ctx, notice, "info");
      updateToolProgress(onUpdate, notice);
      // Heartbeat: keep the tool view alive so it never looks frozen
      const started = Date.now();
      const heartbeat = setInterval(() => {
        const secs = Math.round((Date.now() - started) / 1000);
        updateToolProgress(onUpdate, `⏳ 审计运行中 ${secs}s…（Esc 可中断）`);
      }, 5000);
      try {
        const outcome = await runSpecMutation(ctx.cwd, params.id, () =>
          auditOutcome(ctx.cwd, params.id, {
            signal,
            executor: reviewExecutor,
            budgetId: params.budgetId,
            reviewJobId: params.reviewJobId,
            onProgress: (text: string) => updateToolProgress(onUpdate, text),
          }),
        );
        return outcomeResult(outcome, formatOutcomeText(outcome));
      } catch (error) {
        if (hasDiagnostic(error)) return failureResult(error, "audit", { specId: params.id });
        throw error;
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
      const ui = ctx.hasUI ? ctx.ui : undefined;
      const confirm = ui?.confirm;
      const gate = await attestationGate({
        hasUI: ctx.hasUI,
        confirm: typeof confirm === "function" ? confirm.bind(ui) : undefined,
        id: params.id,
        item: params.item,
        note: params.note,
        signal,
      });

      if (gate.reason === "no-ui") {
        throw new Error(
          "spec_attest 需要交互式 UI 用户确认；当前模式无 UI，未写入。" +
            "如需显式登记，请在 CLI 运行：spec-flow attest <id> <item> <note>",
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
        attest(ctx.cwd, params.id, params.item, params.note),
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
        done(ctx.cwd, params.id, { signal }),
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
          const result =
            arg.slice(0, split) === "new"
              ? await newSpec(ctx.cwd, input)
              : await reviewSpec(ctx.cwd, input, {
                  signal: ctx.signal,
                  executor: reviewExecutor,
                });
          notifySafely(ctx, JSON.stringify(result, null, 2), "info");
          return;
        }
        const text =
          arg === "worktrees"
            ? await renderWorktrees(ctx.cwd)
            : arg && arg !== "board"
              ? await renderSpecDetail(ctx.cwd, arg, ctx.signal)
              : await renderBoard(ctx.cwd, ctx.signal);
        if (text === null) {
          notifySafely(ctx, `spec-flow: 未找到 spec ${arg}`, "warning");
        } else if (text === "") {
          notifySafely(
            ctx,
            "spec-flow: 当前项目无支持的 spec/ 目录（docs/spec(s)、spec(s)）",
            "warning",
          );
        } else {
          notifySafely(ctx, text, "info");
        }
      } catch (e) {
        notifySafely(ctx, `spec-flow: ${e instanceof Error ? e.message : String(e)}`, "error");
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
      const input = event.input as { command?: unknown } | undefined;
      const command = typeof input?.command === "string" ? input.command : "";

      // Quick exit: not a git commit command (avoid unnecessary gate IO)
      if (typeof isCommitCommand !== "function" || !isCommitCommand(command)) return;

      // IO: resolve the ACTUAL target repo (cd / git -C), then run ITS gates
      // (async — TUI stays responsive while waiting)
      const decision = await commitGateDecision(ctx.cwd, command, {
        signal: ctx.signal,
        onGate: (name: string) => notifySafely(ctx, `⏳ spec-flow: 门禁 ${name} 运行中…`, "info"),
      });
      for (const message of decision.diagnostics || []) {
        notifySafely(ctx, `⚠️ spec-flow: ${message}`, "warning");
      }

      // Ledger write helper: write to the target repo, fall back to session cwd.
      // targetRepo is "unknown" when the target could not be resolved (S1.1).
      const writeLedger = (ledgerEvent: unknown) => {
        appendCommitLedger(decision, ledgerEvent, ctx.cwd);
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
        notifySafely(
          ctx,
          "⚠️ spec-flow: SPECFLOW_BYPASS=1 detected, allowing commit despite gate failures",
          "warning",
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
    } catch (e) {
      notifySafely(
        ctx,
        `⚠️ spec-flow 拦截器故障（已放行本次 bash）：${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
      // fail-open：不返回 block
    }
  });

  // ─── session_start: notify active specs ──────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    lastCwd = ctx.cwd;
    if (!ctx.hasUI) return; // print/JSON mode: UI methods are no-ops
    try {
      const specs = loadSpecs(ctx.cwd);
      const active = specs.filter(
        (s) => s.hasFrontmatter && s.frontmatter?.status === s.profile?.lifecycle?.active,
      );
      if (active.length === 0) return; // silent

      const lines = [`📋 spec-flow: ${active.length} 个进行中 spec`];
      for (const spec of active) {
        const fm = spec.frontmatter;
        if (!fm) continue;
        const id = fm.id ?? spec.file;
        const baseSha = fm.impl?.base_sha?.slice(0, 8) || "?";
        const suggestion = await nextStep(ctx.cwd, spec, ctx.signal);
        lines.push(`  • ${id} (base=${baseSha}) — ${suggestion}`);
      }
      notifySafely(ctx, lines.join("\n"), "info");
    } catch {
      // silent on error
    }
  });
}
