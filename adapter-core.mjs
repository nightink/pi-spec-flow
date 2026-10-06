// spec-flow adapter-core.mjs — host-free helpers for the Pi adapter (index.ts).
//
// This module deliberately has zero host dependencies (no Pi package, no
// typebox, no core.mjs) so confirmation and optional presentation can be tested
// with plain Node. index.ts stays the thin host shell: notifications never
// decide gate/evidence success, while human confirmation remains fail-closed.

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
  if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
}

/**
 * Best-effort notification. hasUI alone does not guarantee notify exists in a
 * custom SDK host. Preserve `this`, bound text, and isolate only presentation
 * failures (including async rejections). true means attempted, not delivered.
 */
export function notifySafely(ctx, text, level = "info") {
  try {
    if (ctx?.hasUI !== true) return false;
    const ui = ctx.ui, notify = ui?.notify;
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
    observeFeedback(onUpdate({ content: [{ type: "text", text: truncateToolText(text) }], details: {} }));
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
export async function attestationGate({
  hasUI,
  confirm,
  id,
  item,
  note,
  signal,
} = {}) {
  if (hasUI !== true || typeof confirm !== "function") {
    return { allowed: false, reason: "no-ui" };
  }

  const confirmed = await confirm(
    "spec-flow 人工核验",
    formatAttestationPrompt({ id, item, note }),
    signal ? { signal } : undefined
  );

  return confirmed === true
    ? { allowed: true, reason: "confirmed" }
    : { allowed: false, reason: "declined" };
}
