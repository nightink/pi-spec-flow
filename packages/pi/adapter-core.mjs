// spec-flow adapter-core.mjs — host-free helpers for the Pi adapter (index.ts).
//
// This module deliberately has zero host dependencies (no Pi package, no
// typebox, no core.mjs) so confirmation and optional presentation can be tested
// with plain Node. index.ts stays the thin host shell: notifications never
// decide gate/evidence success, while human confirmation remains fail-closed.

import { dirname, join } from "node:path";

/** Hard cap for text returned to the LLM by spec-flow tools. */
export const TOOL_TEXT_LIMIT = 12000;

/** Cap for the user note rendered inside the confirm dialog. */
export const ATTEST_NOTE_DISPLAY_LIMIT = 1200;

/**
 * Clip long text and mark the cut explicitly, so a truncated tool result is
 * never mistaken for the complete output. Short text is returned unchanged.
 */
export function truncateToolText(text, limit = TOOL_TEXT_LIMIT) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n…[spec-flow] 输出已截断 ${value.length - limit} 字符`;
}

// Pi feedback APIs are void, but custom hosts may return rejected promises.
// Observe those without awaiting a disconnected presentation transport.
function observeFeedback(result) {
  if (result && typeof result.then === "function")
    Promise.resolve(result).catch(() => {
      // Dropped on purpose: the presentation transport may already be disconnected.
    });
}

/**
 * Best-effort notification. hasUI alone does not guarantee notify exists in a
 * custom SDK host. Preserve `this`, bound text, and isolate only presentation
 * failures (including async rejections). true means attempted, not delivered.
 */
export function notifySafely(ctx, text, level = "info") {
  try {
    if (ctx?.hasUI !== true) return false;
    const ui = ctx.ui,
      notify = ui?.notify;
    if (typeof notify !== "function") return false;
    observeFeedback(notify.call(ui, truncateToolText(text), level));
    return true;
  } catch {
    return false;
  }
}

/** Tool progress is independent of optional UI notifications; not evidence. */
export function updateToolProgress(onUpdate, text) {
  if (typeof onUpdate !== "function") return false;
  try {
    observeFeedback(
      onUpdate({ content: [{ type: "text", text: truncateToolText(text) }], details: {} }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Dialog body builder: always shows both the evidence item and the note. */
export function formatAttestationPrompt({ id, item, note } = {}) {
  return [
    `Spec: ${id ?? "(unknown)"}`,
    `人工核验项: ${item ?? "(empty)"}`,
    `核验说明: ${truncateToolText(note, ATTEST_NOTE_DISPLAY_LIMIT)}`,
    "",
    "确认登记人工核验并写入 spec？取消/拒绝不会写入。",
  ].join("\n");
}

/**
 * Host-free confirmation gate for `spec_attest`.
 *
 * Returns a decision instead of throwing so callers can distinguish:
 *   - { allowed: true,  reason: "confirmed" }  user confirmed  → may write
 *   - { allowed: false, reason: "declined" }   user denied/cancelled → no write
 *   - { allowed: false, reason: "no-ui" }      ctx.hasUI=false / no dialog → reject
 *
 * `confirm` is injected (ctx.ui.confirm at runtime) and is only called with a
 * real UI. `signal` is forwarded only when one is available; an exception from
 * `confirm` propagates (the caller must not write anything on the way out).
 */
export async function attestationGate({ hasUI, confirm, id, item, note, signal } = {}) {
  if (hasUI !== true || typeof confirm !== "function") {
    return { allowed: false, reason: "no-ui" };
  }

  const confirmed = await confirm(
    "spec-flow 人工核验",
    formatAttestationPrompt({ id, item, note }),
    signal ? { signal } : undefined,
  );

  return confirmed === true
    ? { allowed: true, reason: "confirmed" }
    : { allowed: false, reason: "declined" };
}

// ─── machine outcomes → bounded model text ──────────────────────────────────
// Text is a recovery-oriented summary, never a head-truncated JSON dump: job
// identity, state/category, packet path and nextActions come first so a large
// receipt cannot push them out of the model-visible window. The complete
// receipt stays in structuredContent (codemode/scripts) and the private job
// directory named here.

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One nextAction is `{tool,args,reason,requiresAuthorization,requiresHuman}`. */
export function formatNextAction(action) {
  if (!isRecord(action) || typeof action.tool !== "string") return "- (invalid nextAction)";
  const args =
    isRecord(action.args) && Object.keys(action.args).length > 0
      ? ` ${JSON.stringify(action.args)}`
      : "";
  const flags = [
    action.requiresAuthorization === true ? "requiresAuthorization" : null,
    action.requiresHuman === true ? "requiresHuman" : null,
  ].filter(Boolean);
  const reason = typeof action.reason === "string" && action.reason ? ` — ${action.reason}` : "";
  return `- ${action.tool}${args}${flags.length ? ` [${flags.join(", ")}]` : ""}${reason}`;
}

export function formatNextActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return "- (none) — 先处理上面的阻塞/诊断，不自动重试、不换算新授权";
  }
  return actions.map(formatNextAction).join("\n");
}

/** Private receipt file path derived from the sealed packet location. */
export function reviewReceiptPath(packetPath) {
  if (typeof packetPath !== "string" || packetPath.length === 0) return null;
  return join(dirname(packetPath), "job.json");
}

/** Conservative recovery actions for a review status without core nextActions. */
export function reviewNextActions(status) {
  if (!isRecord(status)) return [];
  if (Array.isArray(status.nextActions)) return status.nextActions;
  const jobId = status.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) return [];
  if (status.state === "prepared") {
    if (status.receipt?.mode === "working-tree-audit") {
      const id = status.receipt?.bindings?.spec_id;
      return [
        {
          tool: "spec_audit",
          args: { id, reviewJobId: jobId },
          reason: "复用已封存 full audit 仍需要现有 delivery-cycle 授权；不会自动创建/重置预算",
          requiresAuthorization: true,
          requiresHuman: false,
        },
      ];
    }
    return [
      {
        tool: "spec_review",
        args: { action: "run", jobId },
        reason: "run 仅消费已存在的授权 grant，不创建新授权",
        requiresAuthorization: true,
        requiresHuman: false,
      },
    ];
  }
  if (status.outputInfo?.repairable === true) {
    return [
      {
        tool: "spec_review",
        args: { action: "repair", jobId },
        reason: "只修复工具输出协议，零模型/零预算；不是产品通过",
        requiresAuthorization: false,
        requiresHuman: false,
      },
    ];
  }
  if (status.state === "failed" || status.state === "cancelled") {
    return [
      {
        tool: "spec_review",
        args: { action: "status", jobId },
        reason: "先读保留证据与错误；不自动重试、不退款、不换 cycle",
        requiresAuthorization: false,
        requiresHuman: false,
      },
    ];
  }
  return [];
}

function resultFacts(status) {
  const result = isRecord(status.result) ? status.result : null;
  if (!result) return [];
  const facts = [];
  if (typeof result.verdict === "string") facts.push(`verdict=${result.verdict}`);
  if (Array.isArray(result.criteria)) facts.push(`criteria=${result.criteria.length}`);
  const summary = result.coverage_summary;
  if (isRecord(summary)) {
    facts.push(
      `coverage=${summary.covered ?? "?"}/${summary.total ?? "?"}${summary.semantic_guarantee === false ? " (semantic_guarantee=false)" : ""}`,
    );
  }
  return facts;
}

/** Bounded model text for spec_review; complete data stays structured. */
export function formatReviewSummary(status) {
  const value = isRecord(status) ? status : {};
  const info = isRecord(value.outputInfo) ? value.outputInfo : {};
  const receiptPath = reviewReceiptPath(value.packetPath);
  const actions = reviewNextActions(value);
  const lines = [
    `Spec review ${value.mode || "?"} · job=${value.jobId || "?"}`,
    `state=${value.state || "?"} modelInvoked=${value.modelInvoked === true} category=${info.category || "n/a"}${info.code ? ` code=${info.code}` : ""}`,
    ...resultFacts(value),
    ...(value.bytes != null || value.maxBytes != null
      ? [
          `packetBytes=${value.bytes ?? "?"} maxBytes=${value.maxBytes ?? value.limits?.maxBytes ?? "?"}${value.limits?.source ? ` limitSource=${value.limits.source}` : ""}`,
        ]
      : []),
    `packetPath=${value.packetPath || "?"}`,
    receiptPath
      ? `完整 receipt（未裁剪）: ${receiptPath}（私有 0600）`
      : "完整 receipt: 无保留路径",
    "下一步:",
    formatNextActions(actions),
    "摘要边界: 本文本只含状态/分类/恢复入口，未复制 receipt 全文；完整结果在 structuredContent，未裁剪。",
  ];
  if (info.message) lines.push(`说明: ${info.message}`);
  return truncateToolText(lines.join("\n"));
}

/** Bounded model text for spec_board / inspectBoard. */
export function formatBoardText(board) {
  const value = isRecord(board) ? board : {};
  const live = value.freshness === "live";
  const lines = [
    `📋 spec-flow board — freshness=${value.freshness || "record-only"}${live ? "（已比对当前 checkout）" : "（record-only：未读取当前 checkout freshness）"}`,
  ];
  const summary = value.summary;
  if (isRecord(summary)) {
    lines.push(
      `总计 ${summary.total ?? "?"} | managed ${summary.managed ?? "?"} | active ${summary.active ?? "?"} | fresh ${summary.fresh ?? 0} | stale ${summary.stale ?? 0} | actionable ${summary.actionable ?? 0} | blocked ${summary.blocked ?? 0}`,
    );
  } else if (typeof summary === "string" && summary) {
    lines.push(summary);
  }
  if (typeof value.note === "string" && value.note) lines.push(value.note);
  const specs = Array.isArray(value.specs) ? value.specs : [];
  for (const spec of specs) {
    const fresh =
      spec.fresh === null || spec.fresh === undefined
        ? "fresh=not-checked"
        : `fresh=${spec.fresh ? "yes" : "NO"}`;
    const label = spec.statusLabel ? ` ${spec.statusLabel}` : "";
    lines.push(
      `• ${spec.id || "?"} [${spec.file || "?"}] status=${spec.status ?? "?"}${label} | stage=${spec.stage ?? "?"} ${fresh}`,
    );
    for (const blocker of Array.isArray(spec.blockers) ? spec.blockers : []) {
      lines.push(`  阻塞: ${blocker}`);
    }
    const actions = Array.isArray(spec.nextActions) ? spec.nextActions : [];
    for (const action of actions) lines.push(`  ${formatNextAction(action)}`);
  }
  if (!live)
    lines.push("提示: 默认 record-only 不证明当前实现仍匹配；需要 freshness 时用 live=true。");
  lines.push("摘要边界: 本文本有界；完整 specs/nextActions 在 structuredContent。");
  return truncateToolText(lines.join("\n"));
}

/** Bounded model text for implOutcome / auditOutcome. */
export function formatOutcomeText(outcome) {
  const value = isRecord(outcome) ? outcome : {};
  const operation = value.operation === "audit" ? "audit" : "impl";
  const diagnostic = isRecord(value.diagnostic) ? value.diagnostic : null;
  const lines = [
    `Spec ${value.specId || "?"} ${operation}: ${value.pass === true ? "PASS" : "FAIL"} category=${value.category || "n/a"}`,
    ...(value.jobId ? [`job=${value.jobId}`] : []),
    ...(value.packetPath ? [`packetPath=${value.packetPath}`] : []),
    ...(diagnostic
      ? [
          `诊断: ${diagnostic.code || "?"} (${diagnostic.category || "?"})${diagnostic.stage ? ` stage=${diagnostic.stage}` : ""}`,
        ]
      : []),
    "下一步:",
    formatNextActions(value.nextActions),
    "摘要边界: 本文本只含结论/恢复入口；完整 summary 与诊断在 structuredContent。",
    "",
    typeof value.summary === "string" ? value.summary : "",
  ];
  return truncateToolText(lines.join("\n"));
}

/**
 * Structured failure envelope for a host-free core error. A core diagnostic is
 * preserved verbatim (no packet text, no invented PASS, no budget changes).
 */
export function specflowFailure(error, operation, { specId = null } = {}) {
  const diagnostic = isRecord(error?.diagnostic)
    ? error.diagnostic
    : {
        version: 1,
        code:
          (typeof error?.code === "string" && error.code) ||
          (typeof error?.name === "string" && error.name) ||
          "SPECFLOW_TOOL_ERROR",
        category: (typeof error?.category === "string" && error.category) || "tool-error",
        message: error instanceof Error ? error.message : String(error ?? "Unknown error"),
        nextActions: [],
      };
  const summary =
    (typeof diagnostic.message === "string" && diagnostic.message) ||
    (error instanceof Error ? error.message : String(error ?? "Unknown error"));
  return {
    version: 1,
    operation,
    specId,
    pass: false,
    category: diagnostic.category || "tool-error",
    summary,
    nextActions: Array.isArray(diagnostic.nextActions) ? diagnostic.nextActions : [],
    diagnostic,
  };
}

/** Pi error result that still carries machine data to scripts/codemode. */
export function failureResult(error, operation, options = {}) {
  const failure = specflowFailure(error, operation, options);
  const lines = [
    `✗ spec-flow ${operation}: ${failure.category}${failure.diagnostic.code ? `/${failure.diagnostic.code}` : ""}`,
    failure.summary,
    "下一步:",
    formatNextActions(failure.nextActions),
    "诊断数据(结构化，已脱敏):",
    truncateToolText(JSON.stringify(failure.diagnostic), 4000),
  ];
  return {
    isError: true,
    content: [{ type: "text", text: truncateToolText(lines.join("\n")) }],
    details: failure,
    structuredContent: failure,
  };
}
