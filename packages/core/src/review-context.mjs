// Context policy is contract data, not a mutable process environment override.
// Old retained contracts without context_limits keep exactly the old defaults.
export const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  max_files: 20,
  max_file_bytes: 65536,
  max_total_bytes: 131072,
});
export const MAX_CONTEXT_LIMITS = Object.freeze({
  max_files: 100,
  max_file_bytes: 1048576,
  max_total_bytes: 8388608,
});

export function contextError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.diagnostic = {
    version: 1,
    code,
    category: "review-context",
    stage: "context",
    message,
    nextActions: [],
    ...details,
  };
  return error;
}

export function resolveContextLimits(value) {
  if (value === undefined) return { ...DEFAULT_CONTEXT_LIMITS };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_CONTEXT_LIMITS, key))
  )
    throw contextError(
      "REVIEW_CONTEXT_POLICY",
      "context_limits requires only max_files, max_file_bytes and max_total_bytes",
    );
  const limits = { ...DEFAULT_CONTEXT_LIMITS, ...value };
  for (const [key, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONTEXT_LIMITS[key])
      throw contextError(
        "REVIEW_CONTEXT_POLICY",
        `context_limits.${key} requires an integer 1..${MAX_CONTEXT_LIMITS[key]}`,
        { field: key },
      );
  }
  if (limits.max_file_bytes > limits.max_total_bytes)
    throw contextError(
      "REVIEW_CONTEXT_POLICY",
      "context_limits.max_file_bytes must not exceed max_total_bytes",
    );
  return limits;
}

export function assertContextText(text, file) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject binary/control/replacement bytes without returning the text
  const match = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.exec(text);
  if (!match) return;
  const byteOffset = Buffer.byteLength(text.slice(0, match.index), "utf8");
  const codePoint = `U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  throw contextError(
    "REVIEW_CONTEXT_TEXT",
    `Context ${file}: unsupported UTF-8 text, ${codePoint} at byte offset ${byteOffset} (0-based); no source text returned`,
    { path: file, reason: "unsupported-text", byteOffset, codePoint },
  );
}
