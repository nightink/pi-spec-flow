// spec-flow adapter-core.mjs — host-free helpers for the Pi adapter (index.ts).
//
// This module deliberately has zero host dependencies (no Pi package, no
// typebox, no core.mjs) so the human-confirmation gate can be unit-tested with
// plain Node:  node --test adapter-core.test.mjs
//
// index.ts stays the thin host shell: it injects ctx.ui.confirm / ctx.hasUI
// and applies the resulting decision.

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
