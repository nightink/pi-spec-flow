// Machine-readable workflow diagnostics shared by the CLI and agent adapters.
//
// The CLI and native tools must never reverse-engineer state from emoji or
// prose. Every lifecycle step therefore produces one bounded object here:
//
//   {version, operation, specId, pass, category, summary, nextActions,
//    jobId?, packetPath?, diagnostic?}
//
// `nextActions` entries are executable suggestions, not authorizations:
// `requiresAuthorization` marks an action that would spend a review budget and
// `requiresHuman` marks an action a human has to perform (attestation). Board
// inspections never fabricate either flag.

export const WORKFLOW_DIAGNOSTICS_VERSION = 1;

export const DEFAULT_AUDIT_MAX_BYTES = 512 * 1024;
export const MIN_AUDIT_MAX_BYTES = 1;
export const MAX_AUDIT_MAX_BYTES = 16 * 1024 * 1024;

// Stable outcome vocabulary. `pass` is true only for "pass"; every other
// category is a non-passing result with a distinct recovery path.
export const OUTCOME_CATEGORIES = Object.freeze([
  "pass",
  "impl-fail",
  "impl-unstable",
  "product-fail",
  "coverage-gap",
  "protocol-error",
  "execution-error",
  "limit-exceeded",
  "precondition-error",
]);

export const BOARD_STAGES = Object.freeze([
  "unmanaged",
  "proposal",
  "startable",
  "approval",
  "migrate",
  "impl",
  "impl-fail",
  "audit",
  "audit-protocol",
  "audit-execution",
  "audit-coverage",
  "attest",
  "evidence",
  "done-ready",
  "done",
  "ignored",
  "unknown",
]);

const REVIEW_ISSUE_CATEGORIES = new Set([
  "pass",
  "product-fail",
  "coverage-gap",
  "protocol-error",
  "execution-error",
  "limit-exceeded",
]);

function boundedText(value, max, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

/** Bounded executable suggestion; never an authorization grant. */
export function workflowAction(
  tool,
  args,
  reason,
  { requiresAuthorization = false, requiresHuman = false } = {},
) {
  if (typeof tool !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(tool))
    throw new Error("nextActions.tool must be a lowercase tool name");
  assertPlainObject(args, "nextActions.args");
  return {
    tool,
    args,
    reason: boundedText(reason, 1000, "nextActions.reason"),
    requiresAuthorization: requiresAuthorization === true,
    requiresHuman: requiresHuman === true,
  };
}

export function boundedActions(actions, max = 8) {
  if (!Array.isArray(actions)) throw new Error("nextActions must be an array");
  return actions.slice(0, max);
}

/** `nextActions` in the fixed `{tool,args,reason,...}` contract. */
export function normalizeActions(actions) {
  if (actions === undefined) return [];
  if (!Array.isArray(actions)) throw new Error("nextActions must be an array");
  return actions.map((action) => {
    assertPlainObject(action, "nextActions item");
    return workflowAction(action.tool, action.args, action.reason, {
      requiresAuthorization: action.requiresAuthorization === true,
      requiresHuman: action.requiresHuman === true,
    });
  });
}

export function workflowDiagnostic({
  code,
  category,
  stage,
  message,
  limitBytes = null,
  limitSource = null,
  actualBytes = null,
  lowerBoundBytes = null,
  totalBytesKnown = false,
  nextActions = [],
  ...extra
}) {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(code))
    throw new Error("diagnostic.code must be an uppercase machine code");
  if (typeof category !== "string" || !category) throw new Error("diagnostic.category is required");
  if (typeof stage !== "string" || !stage) throw new Error("diagnostic.stage is required");
  for (const [name, value] of Object.entries({ limitBytes, actualBytes, lowerBoundBytes })) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw new Error(`diagnostic.${name} must be a non-negative safe integer or null`);
  }
  return {
    version: WORKFLOW_DIAGNOSTICS_VERSION,
    code,
    category,
    stage,
    message: boundedText(message, 4000, "diagnostic.message"),
    ...(limitBytes === null ? {} : { limitBytes }),
    ...(limitSource === null ? {} : { limitSource }),
    ...(actualBytes === null ? {} : { actualBytes }),
    ...(lowerBoundBytes === null ? {} : { lowerBoundBytes }),
    totalBytesKnown: totalBytesKnown === true,
    nextActions: normalizeActions(nextActions),
    ...extra,
  };
}

/** Attach a stable machine diagnostic to an Error without changing its message. */
export function withDiagnostic(error, diagnostic) {
  if (error && typeof error === "object" && !error.diagnostic && diagnostic) {
    error.diagnostic = diagnostic;
  }
  return error;
}

export function workflowError(message, diagnostic, { cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  if (diagnostic) error.diagnostic = diagnostic;
  return error;
}

export function isAuditMaxBytesText(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

/** Strict positive decimal string → safe integer inside the supported range. */
export function parseAuditMaxBytesText(text, { source = "argument", name = "maxBytes" } = {}) {
  if (!isAuditMaxBytesText(text))
    throw invalidAuditLimitError(name, text, source, "require a positive decimal integer string");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < MIN_AUDIT_MAX_BYTES || value > MAX_AUDIT_MAX_BYTES)
    throw invalidAuditLimitError(
      name,
      text,
      source,
      `require ${MIN_AUDIT_MAX_BYTES}..${MAX_AUDIT_MAX_BYTES} bytes`,
    );
  return value;
}

export function assertAuditMaxBytesNumber(value, { source = "argument" } = {}) {
  if (!Number.isSafeInteger(value) || value < MIN_AUDIT_MAX_BYTES || value > MAX_AUDIT_MAX_BYTES) {
    throw invalidAuditLimitError(
      "maxBytes",
      String(value),
      source,
      `require ${MIN_AUDIT_MAX_BYTES}..${MAX_AUDIT_MAX_BYTES} bytes`,
    );
  }
  return value;
}

export function invalidAuditLimitError(name, value, source, detail) {
  const rendered = value === undefined ? "(undefined)" : JSON.stringify(String(value));
  return workflowError(
    `Invalid ${name}=${rendered} (${source}): ${detail}; no packet, model call or budget spent`,
    workflowDiagnostic({
      code: "AUDIT_MAX_BYTES_INVALID",
      category: "invalid-limit",
      stage: "resolve-limit",
      message: `${name} from ${source} must be ${detail}`,
      nextActions: [],
    }),
  );
}

/** Validate a shared/sealed limit object; fail closed on tampering. */
export function assertReviewLimitShape(value, { allowSealedSource = false } = {}) {
  assertPlainObject(value, "review limit");
  const sources = ["argument", "environment", "default", ...(allowSealedSource ? ["sealed"] : [])];
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < MIN_AUDIT_MAX_BYTES ||
    value.maxBytes > MAX_AUDIT_MAX_BYTES ||
    !sources.includes(value.source)
  ) {
    throw workflowError(
      "Invalid sealed/resolved review limit metadata; no packet or model call",
      workflowDiagnostic({
        code: "AUDIT_LIMIT_METADATA_INVALID",
        category: "precondition-error",
        stage: "resolve-limit",
        message: "Review limit metadata must be {version:1,maxBytes:1..16777216,source}",
        nextActions: [],
      }),
    );
  }
  return { version: 1, maxBytes: value.maxBytes, source: value.source };
}

/**
 * Normalize a review engine output classification. Unknown categories are tool
 * errors, never a product FAIL and never a pass.
 */
export function classifyReviewIssue(outputInfo) {
  const raw = outputInfo?.category;
  if (raw === undefined || raw === null) return null;
  if (!REVIEW_ISSUE_CATEGORIES.has(raw)) {
    return {
      category: "execution-error",
      pass: false,
      code: outputInfo?.code ?? "REVIEW_OUTPUT_CATEGORY_UNKNOWN",
    };
  }
  return { category: raw, pass: raw === "pass", code: outputInfo?.code ?? null };
}

export function auditStatusLabel(category, verdict) {
  if (category === "limit-exceeded") return "⚠️ 审查材料超限（非产品 FAIL）";
  if (category === "invalid-limit") return "⚠️ 审查限额配置非法（未调用模型）";
  if (category === "protocol-error" || category === "execution-error")
    return "⚠️ 工具/协议错误（非产品 FAIL）";
  if (category === "coverage-gap") return "⚠️ 覆盖/证据缺口（非已确认产品 FAIL）";
  return verdict === "pass" ? "✅ PASS" : "❌ FAIL";
}

/**
 * Model-facing summaries are bounded, never fatal: a long audit summary must
 * still produce a machine PASS/FAIL. The untruncated text stays in the receipt
 * and private files; the cut is marked so it cannot be mistaken for the whole.
 */
export function boundedSummary(value, max = 20000) {
  if (typeof value !== "string" || !value.trim()) throw new Error("outcome.summary is required");
  if (value.length <= max) return value;
  const marker = `\n…[spec-flow] summary truncated ${value.length - max} characters; full text in the retained receipt]`;
  return `${value.slice(0, max)}${marker}`;
}

export function workflowOutcome({
  operation,
  specId,
  pass,
  category,
  summary,
  nextActions = [],
  jobId,
  packetPath,
  diagnostic,
}) {
  if (!["impl", "audit"].includes(operation)) throw new Error("Unsupported outcome operation");
  if (!OUTCOME_CATEGORIES.includes(category)) throw new Error("Unsupported outcome category");
  if (typeof pass !== "boolean") throw new Error("outcome.pass must be boolean");
  if (pass !== (category === "pass")) throw new Error("outcome.pass must match category");
  return {
    version: WORKFLOW_DIAGNOSTICS_VERSION,
    operation,
    specId: String(specId),
    pass,
    category,
    summary: boundedSummary(summary),
    nextActions: normalizeActions(nextActions),
    ...(jobId ? { jobId } : {}),
    ...(packetPath ? { packetPath } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** Bounded, machine-readable recovery lines for human/CLI output. */
export function diagnosticLines(diagnostic) {
  if (!diagnostic) return [];
  const lines = [`  诊断: ${diagnostic.code} @ ${diagnostic.stage} — ${diagnostic.message}`];
  if (diagnostic.limitBytes != null) {
    const source = diagnostic.limitSource ?? diagnostic.source ?? null;
    lines.push(`  限额: ${diagnostic.limitBytes} bytes${source ? `（来源: ${source}）` : ""}`);
  }
  if (diagnostic.actualBytes != null) lines.push(`  实际完整材料: ${diagnostic.actualBytes} bytes`);
  if (diagnostic.lowerBoundBytes != null) {
    const sizeKnown = diagnostic.totalBytesKnown ?? diagnostic.sizeKnown ?? false;
    lines.push(
      `  已知下界: ≥${diagnostic.lowerBoundBytes} bytes（${sizeKnown ? "总量已知" : "总量未知，不能当作实际大小"}）`,
    );
  }
  if (Array.isArray(diagnostic.breakdown) && diagnostic.breakdown.length > 0) {
    let total = 0;
    lines.push("  分项字节:");
    for (const item of diagnostic.breakdown.slice(0, 24)) {
      if (!item || !Number.isSafeInteger(item.bytes)) continue;
      total += item.bytes;
      lines.push(`    ${String(item.section)}: ${item.bytes}`);
    }
    lines.push(`  分项合计: ${total} bytes`);
  }
  const actions = normalizeActions(diagnostic.nextActions ?? []);
  if (actions.length > 0) {
    lines.push("  恢复动作（仅建议，不自动执行）:");
    for (const action of actions) {
      lines.push(
        `    ${action.tool} ${JSON.stringify(action.args)} — ${action.reason}${action.requiresAuthorization ? "（需用户授权预算）" : ""}${action.requiresHuman ? "（需人工）" : ""}`,
      );
    }
  }
  return lines;
}

export function boardEntry({
  id,
  file,
  status,
  statusLabel,
  stage,
  fresh = null,
  blockers = [],
  nextActions = [],
}) {
  if (!BOARD_STAGES.includes(stage)) throw new Error(`Unsupported board stage: ${stage}`);
  if (fresh !== null && typeof fresh !== "boolean")
    throw new Error("board entry fresh must be null or boolean");
  if (!Array.isArray(blockers) || blockers.some((item) => typeof item !== "string" || !item))
    throw new Error("board blockers must be non-empty strings");
  return {
    id: String(id),
    file,
    status: status ?? "(no status)",
    statusLabel,
    stage,
    fresh,
    blockers: blockers.slice(0, 8),
    nextActions: normalizeActions(nextActions),
  };
}
