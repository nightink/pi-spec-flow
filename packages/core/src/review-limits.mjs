// Shared review packet byte-limit policy.
//
// The limit is resolved once while preparing/sealing a packet, bound into the
// packet data and the job receipt, and reused for every later read. Changing the
// current environment therefore cannot raise (or silently lower) the limit of a
// retained job. Legacy jobs without sealed metadata keep the historical 512 KiB
// read behavior; absent metadata never becomes an unlimited read.
import fs from "node:fs";
import path from "node:path";
import { digest, readPrivateBytes } from "./review-storage.mjs";

export const REVIEW_LIMIT_VERSION = 1;
export const DEFAULT_REVIEW_MAX_BYTES = 512 * 1024;
export const MAX_REVIEW_MAX_BYTES = 16 * 1024 * 1024;
export const REVIEW_LIMIT_SOURCES = Object.freeze(["argument", "environment", "default"]);
const SOURCES = new Set(REVIEW_LIMIT_SOURCES);
const DECIMAL = /^[0-9]+$/;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nextAction(
  tool,
  args,
  reason,
  { requiresAuthorization = false, requiresHuman = false } = {},
) {
  return Object.freeze({
    tool,
    args: Object.freeze({ ...args }),
    reason,
    requiresAuthorization,
    requiresHuman,
  });
}

/** Machine-readable limit failure. `error.diagnostic` never contains packet text. */
export class ReviewLimitError extends Error {
  constructor(diagnostic, options) {
    super(diagnostic.message, options);
    this.name = "ReviewLimitError";
    this.code = diagnostic.code;
    this.category = diagnostic.category;
    this.stage = diagnostic.stage;
    this.diagnostic = Object.freeze({
      version: REVIEW_LIMIT_VERSION,
      ...diagnostic,
      nextActions: Object.freeze(diagnostic.nextActions.map((item) => Object.freeze(item))),
      ...(diagnostic.breakdown
        ? { breakdown: Object.freeze(diagnostic.breakdown.map((item) => Object.freeze(item))) }
        : {}),
    });
  }
}

export function isReviewLimitError(value) {
  return value instanceof ReviewLimitError;
}

/** Validate an already-resolved `{version,maxBytes,source}` object. */
export function validateReviewLimit(value) {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !["version", "maxBytes", "source"].includes(key)) ||
    value.version !== REVIEW_LIMIT_VERSION ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > MAX_REVIEW_MAX_BYTES ||
    !SOURCES.has(value.source)
  )
    throw new Error(
      `Invalid review limit: require {version:${REVIEW_LIMIT_VERSION},maxBytes:1..${MAX_REVIEW_MAX_BYTES},source:argument|environment|default}`,
    );
  return Object.freeze({
    version: REVIEW_LIMIT_VERSION,
    maxBytes: value.maxBytes,
    source: value.source,
  });
}

function invalidLimit(source, reason) {
  return new ReviewLimitError({
    code: "REVIEW_LIMIT_INVALID",
    category: "review-config",
    stage: "resolve",
    actualBytes: null,
    lowerBoundBytes: null,
    sizeKnown: false,
    limitBytes: null,
    source,
    breakdown: null,
    nextActions: [
      nextAction(
        "spec_review",
        { action: "prepare", maxBytes: DEFAULT_REVIEW_MAX_BYTES },
        `使用显式合法 maxBytes（1..${MAX_REVIEW_MAX_BYTES} 的整数）或修正 SPECFLOW_AUDIT_MAX_BYTES；空值按未配置处理，非法值不会回退`,
      ),
    ],
    message: `Invalid review limit: ${reason}; no review job was created and no model call was made`,
  });
}

function explicitLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REVIEW_MAX_BYTES)
    throw invalidLimit(
      "argument",
      `explicit maxBytes must be an integer between 1 and ${MAX_REVIEW_MAX_BYTES} bytes`,
    );
  return Object.freeze({
    version: REVIEW_LIMIT_VERSION,
    maxBytes: value,
    source: "argument",
  });
}

/**
 * Resolve the effective packet limit.
 * Precedence: explicit `maxBytes` -> non-empty `SPECFLOW_AUDIT_MAX_BYTES` ->
 * `DEFAULT_REVIEW_MAX_BYTES`. No parseInt/NaN fallback, no truncation.
 */
export function resolveReviewLimit(maxBytes, env = process.env) {
  if (maxBytes !== undefined) return explicitLimit(maxBytes);
  const raw = env?.SPECFLOW_AUDIT_MAX_BYTES;
  if (raw === undefined || raw === "") {
    return Object.freeze({
      version: REVIEW_LIMIT_VERSION,
      maxBytes: DEFAULT_REVIEW_MAX_BYTES,
      source: "default",
    });
  }
  if (typeof raw !== "string" || !DECIMAL.test(raw))
    throw invalidLimit(
      "environment",
      "SPECFLOW_AUDIT_MAX_BYTES must be a positive decimal integer string (suffixes/fractions/spaces are rejected)",
    );
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_REVIEW_MAX_BYTES)
    throw invalidLimit(
      "environment",
      `SPECFLOW_AUDIT_MAX_BYTES must be between 1 and ${MAX_REVIEW_MAX_BYTES} bytes`,
    );
  return Object.freeze({
    version: REVIEW_LIMIT_VERSION,
    maxBytes: parsed,
    source: "environment",
  });
}

/** Resolve the sealed limit of an existing job. Never consults current env. */
export function retainedReviewLimit(job) {
  if (!isObject(job)) throw reviewLimitTampered({ id: null, reason: "invalid retained job" });
  if (job.review_limit === undefined) {
    // Genuine pre-metadata receipt: exact historical bytes/limit behavior.
    return Object.freeze({
      version: REVIEW_LIMIT_VERSION,
      maxBytes: DEFAULT_REVIEW_MAX_BYTES,
      source: "default",
      legacy: true,
    });
  }
  try {
    return Object.freeze({ ...validateReviewLimit(job.review_limit), legacy: false });
  } catch (cause) {
    throw reviewLimitTampered({
      id: typeof job.id === "string" ? job.id : null,
      reason: "retained job has invalid/unsupported review_limit metadata",
      cause,
    });
  }
}

function suggestedBytes(limit, actualBytes, lowerBoundBytes) {
  if (actualBytes !== null)
    return Math.min(MAX_REVIEW_MAX_BYTES, Math.max(actualBytes, limit.maxBytes + 1));
  if (lowerBoundBytes !== null)
    return Math.min(MAX_REVIEW_MAX_BYTES, Math.max(lowerBoundBytes + 1, limit.maxBytes + 1));
  return MAX_REVIEW_MAX_BYTES;
}

/**
 * Build a stable over-limit diagnostic. A complete packet reports exact
 * `actualBytes` plus a reconciling breakdown; bounded Git capture only reports a
 * provable lower bound and leaves the total explicitly unknown.
 */
export function reviewLimitExceeded(
  limit,
  {
    stage,
    actualBytes = null,
    lowerBoundBytes = null,
    breakdown = null,
    id = null,
    mode = null,
    specPath = null,
    detail = null,
  },
) {
  const policy = {
    version: limit?.version,
    maxBytes: limit?.maxBytes,
    source: limit?.source,
  };
  validateReviewLimit(policy);
  if ((actualBytes === null) === (lowerBoundBytes === null))
    throw new Error("Review limit diagnostic requires exactly one of actualBytes/lowerBoundBytes");
  const sizeKnown = actualBytes !== null;
  const provable = sizeKnown ? actualBytes : lowerBoundBytes;
  const suggested = suggestedBytes(policy, actualBytes, lowerBoundBytes);
  const actions =
    provable > MAX_REVIEW_MAX_BYTES
      ? [
          nextAction(
            "spec_board",
            {},
            `材料已超过单包上限 ${MAX_REVIEW_MAX_BYTES} bytes；必须人工拆分合同/变更范围后重建完整包，不能截断或自动缩 scope`,
            { requiresHuman: true },
          ),
        ]
      : [
          // Carry the real prepare selector so the suggestion is executable for
          // the mode that failed, not a bare `{action:"prepare",maxBytes}`.
          nextAction(
            "spec_review",
            {
              action: "prepare",
              ...(id ? { id } : {}),
              ...(mode ? { mode } : {}),
              ...(specPath ? { specPath } : {}),
              maxBytes: suggested,
            },
            sizeKnown
              ? `完整包需要至少 ${actualBytes} bytes；显式限额不低于实际值，包保持完整、不截断`
              : `Git 只能证明超过 ${lowerBoundBytes} bytes 的下界，总量未知；提高显式限额重试 prepare，仍不截断`,
          ),
        ];
  if (stage === "read")
    actions.push(
      nextAction(
        "spec_board",
        {},
        "核对 Spec 阶段与已批准 scope；旧 job 的封存限额不可改写，如需更大包应新建带显式 maxBytes 的 prepare",
      ),
    );
  // A status action needs a retained job; never emit an unrunnable status call.
  if (id)
    actions.push(
      nextAction(
        "spec_review",
        { action: "status", jobId: id },
        "读取保留 job 的状态/封存绑定；不修改限额、不自动重试付费调用",
      ),
    );
  return new ReviewLimitError({
    code: "REVIEW_PACKET_LIMIT",
    category: "review-limit",
    stage,
    actualBytes,
    lowerBoundBytes,
    sizeKnown,
    limitBytes: policy.maxBytes,
    source: policy.source,
    breakdown,
    detail,
    nextActions: actions,
    message: `${
      sizeKnown
        ? `Review packet exceeds limit at ${stage}: ${actualBytes} bytes > ${policy.maxBytes} bytes (source=${policy.source}); complete packet retained, nothing truncated, no model call`
        : `Review packet exceeds limit at ${stage}: Git output stopped above ${lowerBoundBytes} bytes > ${policy.maxBytes} bytes (source=${policy.source}); total size unknown, nothing truncated, no model call`
    }; ${
      provable > MAX_REVIEW_MAX_BYTES
        ? "next: manually split the contract/scope (spec_board); one packet cannot exceed 16777216 bytes"
        : `next: spec_review ${JSON.stringify({ action: "prepare", ...(id ? { id } : {}), ...(mode ? { mode } : {}), ...(specPath ? { specPath } : {}), maxBytes: suggested })} (free prepare; authorized execution still required)`
    }`,
  });
}

/** Sealed metadata that disagrees with the packet is tampering, never a fallback. */
export function reviewLimitTampered({
  id = null,
  reason = "sealed limit metadata mismatch",
  cause,
}) {
  return new ReviewLimitError(
    {
      code: "REVIEW_LIMIT_BINDING",
      category: "review-integrity",
      stage: "read",
      actualBytes: null,
      lowerBoundBytes: null,
      sizeKnown: false,
      limitBytes: null,
      source: null,
      breakdown: null,
      nextActions: [
        nextAction(
          "spec_board",
          {},
          "保留原 job/packet 证据并人工核对；不要编辑或删除限额 metadata，也不要放宽环境变量来读取旧证据",
          { requiresHuman: true },
        ),
      ],
      message: `Sealed review limit metadata differs from the retained packet/job${id ? ` ${String(id).slice(0, 8)}` : ""}; no approval or model call. ${reason}; next: inspect with spec_board and retain evidence; never edit/delete metadata or widen the environment`,
    },
    cause ? { cause } : undefined,
  );
}

function packetBindings(text) {
  const start = text.indexOf("\n\n{");
  const end = text.indexOf("\n\nReturn only strict JSON:", start + 1);
  if (start < 0 || end < 0) return null;
  try {
    const data = JSON.parse(text.slice(start + 2, end));
    return isObject(data) ? data.bindings : null;
  } catch {
    return null;
  }
}

/**
 * Read a retained packet under its sealed (or legacy) limit and cross-check the
 * limit binding in the packet against the mutable job metadata.
 */
export function readRetainedPacket(dir, job) {
  const limit = retainedReviewLimit(job);
  const file = path.join(dir, "packet.md");
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error("Retained review packet missing; no approval", { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Unsafe review artifact");
  if (stat.size > limit.maxBytes)
    throw reviewLimitExceeded(limit, {
      stage: "read",
      actualBytes: stat.size,
      breakdown: [{ section: "packet", bytes: stat.size }],
      id: typeof job.id === "string" ? job.id : null,
      detail: "retained packet exceeds the sealed limit",
    });
  const bytes = readPrivateBytes(file, limit.maxBytes);
  if (typeof job.packet_sha256 !== "string" || digest(bytes) !== job.packet_sha256)
    throw new Error("Retained review packet changed; no approval");
  const bindings = packetBindings(bytes.toString("utf8"));
  const marker = bindings && Object.hasOwn(bindings, "review_limit") ? bindings.review_limit : null;
  if (limit.legacy) {
    // A packet that binds a limit proves the job lost/removed its metadata.
    if (marker !== null)
      throw reviewLimitTampered({
        id: typeof job.id === "string" ? job.id : null,
        reason: "packet binds review_limit but job metadata is absent",
      });
    return bytes;
  }
  let bound;
  try {
    bound = validateReviewLimit(marker);
  } catch (cause) {
    throw reviewLimitTampered({
      id: typeof job.id === "string" ? job.id : null,
      reason: "packet is missing or has invalid review_limit binding",
      cause,
    });
  }
  if (bound.maxBytes !== limit.maxBytes || bound.source !== limit.source)
    throw reviewLimitTampered({
      id: typeof job.id === "string" ? job.id : null,
      reason: "packet review_limit binding differs from job metadata",
    });
  return bytes;
}
