# S1.2 daemon UI maintenance — parent-only validation

Baseline: `1b2b4069c67073fbe14f005c3598e59827d6c083`. Governing contract: `docs/specs/S1.2-trustworthy-gates-and-closure.md`; plan/result in its Review journal only. Historical frontmatter, semantic contract and done/audit are unchanged. This maintenance has **no new independent model review**, grant or lifecycle reopening. Old independent evidence does not cover the new source.

## Candidate and commands

`source-manifest.json` freezes six changed product/test/doc files. It excludes the mother journal, issue records and archives; it is not a full-current audited snapshot. `evidence-manifest.json` binds commands, exit codes, logs, normalization and private original-byte hashes. All commands ran with actual Node 22.19.0 on macOS arm64; `typecheck` is syntax/static parsing, not a `tsc` claim. No install, dependency change, new vulnerability-audit claim, production data access, provider or remote operation.

| Evidence | Result | Boundary |
|---|---|---|
| `pre-fix.log` | expected exit 1, 14/14 regression failures | fake Pi registration but real core/CLI gates and disposable project files |
| `pre-fix-sdk.log` | expected exit 1; actual native `spec_impl` returns `ctx.ui.notify is not a function` | real installed Pi SDK 1.0.0 with prototype-method UI fixture; not live daemon |
| `targeted.log` | exit 0, 27/27 | 13 existing adapter tests + 14 new regressions |
| `sdk.log` | exit 0, three PASS paths | actual Pi SDK context, wrapped native tools and nested call/events pipeline |
| `full-check.log` | exit 0, 183/183 and eight E2E groups | entire authoritative `npm run check`, ending in contracts-only validation |
| `pi-smoke.log` | exit 0 | real isolated Pi CLI/RPC discovery/commands, native new/review plumbing, and daemon-shaped native lifecycle/commit path |
| `parent-verification.json` | exact historical frontmatter/contract equality; gaps=[] | parent comparison and source hashes, not a model review |
| `fixture-import-failure.log` | development fixture error only | corrected import of `loadProjectProfile` before final baseline reproduction; not a product defect |

## Proven behavior

- Optional notify missing/non-callable/throwing, missing UI and headless contexts cannot interrupt a real gate. Native impl emits bounded gate/diagnostic progress through `onUpdate`. A failed gate still persists `impl.pass=false`, its nonpassing gate result and exact diagnostic.
- Receiver binding is retained. Synchronous errors and async rejection in optional notification/update transports affect presentation only. Core exceptions still reach the native error result; no throw is converted into an evidence PASS.
- The interceptor actually runs failed gates and returns `block:true` even without notify. Ordinary bash still skips gates; explicit bypass still records failed gate evidence. The actual SDK nested bash call is blocked and fixture Git HEAD remains unchanged.
- Audit's missing-notify case reaches the correct core `impl is not explicitly passing` refusal before any grant/provider execution; this is not acceptance of a fresh paid audit.
- No callable confirmation rejects with byte-identical Spec and ledger. Decline/failed dialog does not write; explicit confirmation preserves receiver and hash-bound attestation. Its fake-host audit precondition is explicitly a synthetic fixture seed, not independent review.
- Actual SDK UI wrapping retains dialog capability while losing prototype notify; the real confirmation callback receives the human prompt and declines without writes. Progress is received both by nested callbacks and `tool_execution_update` events.

## Source diagnosis and limits

`parent-verification.json` binds read-only source hashes/lines: example-app prototype `RuntimeUIContext.notify`, direct/rebound SDK binding, and actual installed Pi's `wrapUIPromptContext` object spread/hasUI implementation. Real SDK acceptance reproduces that source-supported mechanism. It does **not** inspect or reload the production daemon or its cached extension resources.

Only `pre-fix.log` needed line-end horizontal whitespace removal for tracked Git cleanliness; no lines were removed. Exact originals for all logs are privately retained under `.git/spec-flow/acceptance/S1.2-daemon-ui/` and hash-bound in the evidence manifest. No model raw response exists for this maintenance.

example-app concurrent edits, real Spec 70, production sessions/credentials, global skills, installed SDK, daemon, remote refs/workflows and hosted CI were not modified. The consumer repair does not reconstitute all UI methods for other extensions. Owner adoption/reload/rebind or a separate host/upstream UI preservation change remains outside this source-only delivery. macOS/POSIX verification does not add a Windows guarantee.
