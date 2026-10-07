# Review output protocol errors must be recoverable, not product failures

- Status: resolved by parent-only S1.7 maintenance; no new independent review of this repair code.
- Governing contract: `docs/specs/S1.7-unified-review-and-spec-creation.md`, 2026-10-07 Review journal plan/result.
- Baseline: `988110bcb6c00771d47ead640dd5090ebfda94bc`.

## Reproduction

example-app full-current job `62ebfd2f8b75c717b2ed717f00223f83` completed normally. Its actual response declared PASS, all 11 criteria passed, and it reported no blocking finding. Four scope observations used exact `{file,note}` objects. The sealed prompt showed only `scope_deviations:[]`, without an element contract; the legacy consumer required strings. It appended a structure check and verdict-consistency check and persisted normalized FAIL. That is a tool producer/consumer contract fault, not a product finding or an uncharged failed execution. Its two-call grant remains exhausted.

## Repair and prevention

Newly prepared jobs pin result protocol 2 and prompt 4, explicitly documenting scope types/caps. The only compatible object shape is bounded, nonblank string `file`/`note`, losslessly JSON-encoded into scope strings. Unknown/extra fields, missing verdict/criterion evidence, genuine blockers and incomplete execution remain nonpassing. Missing version fields use unchanged legacy normalization; existing FAIL receipts are never silently recomputed with new semantics.

`spec_review {action:"repair",jobId}` (CLI `review --json`) validates retained packet/child/raw/result, then atomically publishes an idempotent derived receipt with immutable source hashes and identical original coverage, bindings, model/execution/usage and budget reference. It needs no launcher/provider/grant, accepts no budget or judgment edits, and leaves original job/grant/Spec bytes untouched. `audit ID --review-job DERIVED_ID` is the CLI counterpart of native bound attachment. Status/audit/next-step/attest hints distinguish protocol/execution errors from product FAIL and give a free recovery path instead of automatically demanding another model invocation. Core `attest()` remains synchronous and still requires valid passing evidence and human confirmation at the native adapter.

## Acceptance and limits

- Ten new disposable fake-review tests cover strict compatibility/caps, legacy normalization, exhausted grants, atomic retry/idempotence, product FAIL/blockers, malformed/unknown parameters, source tampering, ordinary-review rejection and stale bindings. Synthetic lifecycle/human evidence is only fixture plumbing.
- Actual CLI/linked worktrees demonstrate zero-launcher repair/replay and bound full attachment; real trusted Pi SDK invokes native repair and rejects a repair budget parameter. Existing daemon notification/commit/human decline regressions and all nine object-root tool payloads remain passing.
- Full Node22 check: 194/194 tests and nine E2E groups; full private Pi smoke passes with zero provider HTTP requests.
- The actual retained Spec70 response repaired to `76fadc25a3f57cc7a5f61db2a5424066`: 11/11 original criteria PASS, four round-trip scope observations, unchanged findings/bindings/execution/usage. Original normalized FAIL and grant 2/2 are intact; no new model call/charge, Spec write, gate, human attestation or lifecycle attachment.
- The current example-app checkout's contract and implementation snapshot differ from that original audit. This repair rescues the original review, not a new current-version approval. Owner adoption/rebinding, current-version acceptance and production operations are not claimed.

Evidence: `docs/reviews/S1.7/output-repair/`. Original production raw data is private, not included in Git archives. The unrelated HTML artifact and historical Spec frontmatter/contracts/done/audits remain unchanged.
