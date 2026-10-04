# S1.7 independent proposal review and parent dispositions

- Contract: docs/specs/S1.7-unified-review-and-spec-creation.md
- Implementation baseline: 78738343732b58ad6892df6d28fa69d8568fae06 (clean at intake).
- Proposal was an explicitly disclosed untracked draft, not a committed implementation candidate.
- Fresh read-only worker: research-mus9z2b583334115; requested model deepseek/deepseek-v4-flash; terminal result consumed by worker_result.
- Actual conclusion: **REVISE**, not implementation approval. Call 1/3; two actual calls remain. No additional worker calls.
- Allowed reads: trusted engine repo, named skill directories and named SDK docs/types/examples. No script execution, credentials, sessions or production data.

## Independent blocking findings (archived findings and reasoning)

B1. Persisted budget had no scope/key, initializer/authorization, charge/cache ordering or legacy-job coexistence. Current audit/fake tests have no grants; a model-facing budget argument could self-grant. Requested finite delivery-cycle identity, explicit user/CLI authorization, no tool increases, shared atomic charge-on-reserve, no interruption refund, free cached PASS, explicit fake-test grants and preservation of S1.6 job state.

B2. Proposal/committed/incremental/working-audit modes lacked inputs/spec-source/schema and a structural read-only closure boundary. Current done consumes fm.audit and hashes. Requested mode table, head-version contract/profile for committed review, structured prior-report identity, and an invariant that ordinary review never changes status/review.decision/audit even after PASS.

B3. Configured lifecycle can have no preReview; CI requires approval on all startable roles. A CI-clean unapproved draft cannot exist in that configuration. Numeric allocator returns strings but numeric contracts require YAML integer IDs and N.slug.md; kind/required metadata were underdetermined. Requested fail-closed no-draft policy, numeric conversion, explicit kind/defaults and refusal to invent missing required metadata.

B4. Creation schema, template/version/slots, output-directory/slug/mapped fields and global skill migration authority were unspecified. Requested strict v1 extension, safe recognized directories/templates, fixed literal placeholders, project lifecycle mapping and explicit installed/archive paths + manifests/fresh discovery. Parent inspected global autonomous VERSION/CHANGELOG/MANIFEST convention before migration.

B5. Packet identity could cover an embedded payload instead of entire sent prompt; phrase about rejecting malformed result before execution was impossible. Storage/limits/foreign-job behavior missing. Requested packet == exact child-input bytes, sealed/rechecked hash, preflight scan before budget/model, raw postexecution failures retained, bounded private atomic storage and no mutation of legacy job directories.

## Parent verification / resolution before construction

| Item | Verification | Disposition |
|---|---|---|
| B1 | Current audit has no budget; cache returns before spawn; fixtures use fake bins. Existing recovery jobs are unrelated formats. | Confirmed. Named explicit immutable grants and versioned private store; reserve before spawn and retain unknown outcomes; cache remains free. |
| B2 | auditUnlocked/writeSpecLifecycleFile/done currently own v2 fm.audit evidence. | Confirmed. Separate additive report receipt; only current working-audit adapter writes audit; no historical/delta import. |
| B3 | DEFAULT preReview was empty, configured startable approval unconditional, numeric contract requires integer. | Confirmed. Add default draft preReview without removing legacy pending; custom no-draft fails; fixed kind/default rules and numeric YAML. |
| B4 | Strict parser lacks creation; allocator scans only four directories; globals are unmanaged files with a checksum convention. | Confirmed. Exact creation keys/slots/path/default rules plus named reversible archive and tracked installation bundle. |
| B5 | Current core @file prompt is reconstructed separately from standalone dry-run; result arrives after execution. | Confirmed. One full-prompt file, engine scanner receipt and exact input hash; result validation postexecution; raw response preserved. |

N1–N9 are incorporated in the contract: endpoint no-textconv/no-ext-diff hardening; head profile; handled slash/fixture tool invocation without model; bounded static recognition; deliberate shared isolation flags; skipped != audit PASS; changed-line incremental classification; creation affects other active snapshots; temporary tests preserve real coordination; distinguish harness real authorization and engine fake grants. The new draft temporarily references a future E2E file, so interim CI redness is task-introduced and expected until the suite exists, not an inherited baseline issue.

Parent approves the revised construction plan after these verified resolutions. This does **not** relabel the model's original REVISE as APPROVE. No model implementation audit has yet run; no S1.5/example-app or completed contract rewritten.
