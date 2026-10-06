# Daemon `spec_impl`: missing `ctx.ui.notify`

- Date: 2026-10-06
- Status: resolved in spec-flow source / parent-only (no new independent review)
- Mother Spec: [S1.2](../specs/S1.2-trustworthy-gates-and-closure.md), maintenance journal only; historical done/audit unchanged
- Baseline: `1b2b4069c67073fbe14f005c3598e59827d6c083`

## Report and reproduction

The user reported example-app daemon `spec_impl` failing with `ctx.ui.notify is not a function`, requiring the project CLI `impl 70` instead. We did not rerun or modify real Spec 70, inspect production sessions/credentials, or restart a daemon.

A disposable project loaded the actual spec-flow extension through the already-installed trusted Pi SDK 1.0.0 with a prototype-method UI class. `hasUI === true`, `typeof ctx.ui.notify === "undefined"`, and the real native `spec_impl` returned that exact TypeError before its gate executed. The same fixture passes after repair. This proves the installed SDK/adapter failure mechanism, not that the running daemon has adopted the new source.

## Root cause

Read-only source chain:

1. example-app `packages/server/src/runtime/ui-context-adapter.ts:107`: `RuntimeUIContext.notify()` lives on its prototype.
2. example-app `packages/server/src/runtime/sdk-primary-runtime.ts:256,258`: that UI instance is passed to `bindExtensions()` (including replacement sessions).
3. Selected Pi 1.0.0 `dist/core/extensions/runner.js:355–368`: `wrapUIPromptContext()` spreads `...ui` and recreates dialog methods only. Prototype `notify` is not copied; `hasUI()` still returns true.
4. Baseline spec-flow `index.ts:155–165`: `spec_impl` only tests `hasUI` and calls `ctx.ui.notify`; its tool update callback was unused.

The commit interceptor had the same assumption. With an empty UI, the old onGate callback threw before executing the gate and its exception handler returned the existing fail-open result. This is independently covered by a real failing gate, not merely a helper assertion.

## Repair and acceptance

- Host-free `notifySafely()` checks actual capability, preserves `this`, caps text, and isolates synchronous/async notification failures. All adapter notification sites use it.
- `spec_impl` emits gate/diagnostic progress through `onUpdate`, separately from optional UI notify. Audit/review progress and audit heartbeat also isolate presentation failures.
- Confirmation is **not** a best-effort approval: a non-callable/missing `confirm` rejects without writes, decline does not write, dialog exceptions still propagate, and explicit confirmation retains receiver binding and hash-bound attestation semantics.
- Core gate execution, FAIL summaries, lifecycle queues, audit budgets, and the interceptor's explicit bypass/internal-fault policy are unchanged. Missing presentation can no longer trigger the fallback before a failed gate is checked.
- Targeted: 27/27 tests; full Node 22.19.0 `npm run check`: 183/183 tests and all eight existing E2E groups.
- Actual isolated Pi CLI/RPC/native smoke passes, including the new daemon-shaped SDK case: native progress, healthy/failed gates, failed commit blocking, core audit refusal, and human decline. Synthetic tool issuer/audit precondition are explicitly mechanical fixtures, not independent review or real human evidence.

Evidence: [validation](../reviews/S1.2/daemon-ui/validation.md), source/evidence manifests and retained pre-fix/final logs in the same directory.

## Adoption boundary

No example-app code/concurrent work, hosted CI, remote refs, production daemon, installed Pi package, or real Spec 70 was changed. This consumer-side repair does not restore every prototype UI method for other extensions. A separate host/upstream fix can preserve those methods; owner reload/rebind is required to adopt updated extension code. No new metered grant/model call or lifecycle reopening was performed; the old S1.2 audit does not cover this maintenance.
