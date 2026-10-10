# Parent-only maintenance closure

Issue #2's structural block is removed without weakening fail-closed semantics: the audit prompt (v5) now requires
every criterion to be decidable from the sealed packet, sends runtime/remote/cross-repository/human acceptance facts
to `out_of_scope`, and keeps `Any failing/unverifiable criterion requires verdict fail`. Deferred items are recorded in
the Spec `audit.out_of_scope` and shown in the audit summary instead of being dropped silently.

Acceptance: `npm run check` 198/198 units + ten real E2E groups + contracts-only pass, and the private Pi smoke passes
with zero provider HTTP requests. Five baseline regressions failed before the change.

This is not an independent review of the repair code, no real provider call was made, and no historical job/packet/raw/
receipt/budget/Spec was rewritten. Result protocol 2, `normalizeAuditResult`'s output shape and legacy record hashes are
unchanged; the original reporting project's five-submission sequence was not replayed, and its private packet is not
copied here. Whether a live model complies with the new rule remains unproven by provider evidence.
