# Criteria admissibility (issue #2) — parent verification

Baseline: `1d3d259b0515a0a202bc635db17ab0f138bd49cd` (`origin/main` before this fix; the branch was rebased onto it after a concurrent `fix(gates)` commit landed). Governing contract: S1.7 (unified review engine / audit prompt).
No separate Spec, no reopening of a done Spec, and **no independent review of this repair code**: this archive is
parent-only maintenance acceptance.

## Source and contract

Six changed product paths are bound by `source-manifest.json` (`README.md`, `core.mjs`, `core.test.mjs`,
`review-engine.mjs`, `review-repair.test.mjs`, `review-creation.test.mjs`). Result protocol stays at `2`; only the
audit prompt text/version and the core audit record/summary change. `normalizeAuditResult` keeps its exact output shape
(`verdict`/`criteria`/`scope_deviations`), so historical `audit` records keep the same `result_sha256`; the new
`audit.out_of_scope` key is written **only when non-empty**, and `assertRetainedAuditEvidence` is untouched.
No historical Spec frontmatter, job, packet, raw output, receipt or budget was rewritten.

## Reproduction and convergence

Five new/updated regressions fail on the baseline source with the fixed tests present (`pre-fix.log`, exit 1):
prompt-version and admissibility assertions for both proposal and working-tree-audit packets, deferral persistence,
and the deferred-PASS lifecycle. After the fix the same three test files pass 120/120 (`targeted.log`).

The reproduced defect is exactly the reported one: the baseline sealed packet contains no criteria-admissibility
constraint (runtime/remote/human facts may become criteria, and `out_of_scope` is neither typed nor visible), while
`Any failing/unverifiable criterion requires verdict fail` still holds. A runtime-only criterion therefore keeps the
audit at FAIL and locks `spec_attest`/`spec_done`.

## Executed acceptance

- `npm run check` on Node v24.19.0: typecheck + eslint + 198/198 unit tests + ten real E2E groups +
  `check --ci --contracts-only` pass (`full-check.log`, exit 0).
- Private Pi smoke on Node v24.19.0 with an explicit trusted shim and `SPECFLOW_PI_SDK` (the host PATH has no `pi`):
  real isolated CLI `/spec`, native typed tools through `ctx.executeTool`, daemon UI, and nine object-root tool
  declarations across three provider serializers with zero HTTP requests (`pi-smoke.log`, exit 0).
- Behavioural acceptance with fake auditors (fixture plumbing, not model evidence):
  audit PASS is reachable when the packet records bound gate/impl evidence and the residual runtime/remote/human facts
  are deferred to `out_of_scope`; the deferred list is persisted and shown; `spec_attest` then `spec_done` succeed.
  Fail-closed is unchanged: an `unverifiable` runtime criterion ⇒ audit FAIL and `spec_attest` refusal, and empty
  criteria with everything deferred ⇒ verdict `fail`.
- Exact old prompt bytes are preserved in `pre-fix.log`; the retained baseline regression evidence is not edited.

## Evidence and limits

`evidence-manifest.json` binds the four logs and the three summaries by bytes/SHA-256. Logs were normalized by
removing line-end horizontal whitespace only; no lines were removed. Secret scans are pattern-limited, not a
universal absence-of-secrets proof (`secret-scan.md`).

Limits: no real-model audit was executed (no paid authorization was requested), so "does the model obey the new rule"
is backed by sealed-packet content assertions plus deterministic layering regressions, not provider evidence. No Node
22 runtime exists on this host, so the gates ran on Node v24.19.0 (the repo requires `>=22.19.0`). The original
five-submission sequence of the reporting project was not replayed, and no cross-repository verifier was executed.
No push, deploy, install, provider call, budget charge or production-host change was performed by this delivery.
