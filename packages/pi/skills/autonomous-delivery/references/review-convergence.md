# Independent review and convergence

Keep proposal review, implementation review, parent verification, and real acceptance separate.

## 1. Consent and total budget

A full invocation has a **total** budget of at most three potentially metered fresh-model calls:

1. proposal review;
2. implementation diff/patch review;
3. one incremental closure review.

Parent verification in the current context does not count. Explicit skill invocation or explicit complete-delivery/third-party
convergence authorizes the total budget. Auto-selection alone does not: obtain consent before the first metered call and offer a
parent-only fallback. Never silently exceed the total. Persist one delivery-cycle ID; do not reset it on nested entry,
Spec creation or process restart. If spec-flow is available, explicit terminal/API `review-budget --json` authorization seeds
already-used external calls. Tools cannot authorize/increase grants. A failed/unknown potentially metered spawn remains charged.
Model count and parent dispositions are distinct; a new separately authorized cycle is not an implicit retry.

## 2. Proposal review

Provide the governing proposal, relevant project rules, and only the repository facts needed to assess feasibility. Ask a
fresh-context, read-only reviewer for cited Blocking/Non-blocking findings and a verdict. Prefer `spec_review` proposal
mode: prepare current contract bytes, inspect/secret-scan the exact sealed packet, then run once against the existing grant.
This does not write approval/status or audit evidence; parent must apply the project's proposal approval rules.

Parent Agent must verify every claim. Confirmed blockers update the governing artifact before construction. Proposal APPROVE
means the plan is implementable/testable; it does not prove future code. Reconcile all normative body promises with acceptance,
including compound observable dimensions and precise numeric definitions. Keep original findings bound to their source rather than
relying on author summaries. For confirmed majors, record finding → acceptance → implementation/test evidence; "written into Design"
is not closure. Verified rejection or actual approved withdrawal is a separate, sourced disposition, not a forced fake regression test.

If a worker cannot start, an isolated no-tools/no-session reviewer with a secret-scanned sealed packet is acceptable. Never call
the current implementation context “independent.”

## 3. Implementation review contract

Use the spec-flow shared engine, not the retired independent-spec-diff-review script/skill. Verify actual native
`spec_review` availability; static package declarations alone do not prove load. The trusted CLI `review --json <object>`
is equivalent when the adapter is unavailable. Do not auto-load/install an unknown extension or fall back to an archived script.

Use prepare/run/status: prepare builds the sole hash-bound full child prompt; inspect and check_secrets that exact file,
not a separately reconstructed diff packet. The engine's named high-risk-pattern scan is an additional bounded preflight,
not proof from a general secret scanner. Run consumes a user-authorized cycle once; retain packet/raw response/receipt and
check terminal state instead of assuming accepted/queued is completed. A restart does not authorize respawn.

Prefer an exact committed endpoint diff:

- unambiguous base and head full identifiers;
- ancestry checked;
- governing contract included in full;
- engine prior job/report/hash included for incremental closure work;
- separate original implementation base and delta review base;
- Spec/profile read from the explicit head, never silently from dirty files;
- diff/stat/name-status/check included;
- dirty/untracked exclusions stated;
- packet built and inspected before model call;
- packet secret-scanned;
- versioned body-source inventory and every returned source ID accounted for;
- semantic check that each normative promise actually reaches suitable acceptance (references/keywords alone are insufficient);
- explicit caller context, including unchanged entry files when relevant, sealed from the selected head/current target repository;
- declared proposal sources inherited and dispositions tied to acceptance or a verified decision.

If Git is unavailable, build an explicit before/after file manifest and patch, disclose reduced provenance, and do not invent
SHAs or claim Git-level isolation.

Use a clean temporary worktree when unrelated dirty state would otherwise contaminate the packet. Respect project policy on
commits; never create or rewrite commits when forbidden.

### Coverage and evidence precision

For spec-flow protocol 3, declare optional contract frontmatter `review_inputs: {context_files: [...], proposal_reviews: [...]}` before
impl; changing it changes the contract hash. Context files must be explicit bounded ordinary files in the target repository, not
links, cross-repository data, production sessions or executable instructions. Proposal IDs refer to retained completed same-Spec
proposal reports; importing them is not importing approval. Known evidence gaps are inherited as unresolved gaps, NOT confirmed bugs.
Keep packet/raw/job and directly declared original proposal journals to validate new coverage claims; a missing/tampered direct
source blocks consumption/cache without an extra call. This is not recursive certification of an unlimited historical graph. Historical v1/v2
PASS, repairs and free cache retain their original meaning and do not acquire v3 completeness retroactively.

Distinguish protocol error, coverage/evidence gap, confirmed static product failure, execution failure and runtime acceptance.
For the typed coverage protocol, criteria explicitly use kind=product|evidence; a nonpassing evidence criterion needs visible gap linkage, not a fabricated product finding.
Factual rejection supported by bound static counterevidence does not require scope-owner consent; withdrawal/waiver of a real requirement does.
Missing acceptance/context prevents the relevant PASS but does not prove a product bug. Runtime/remote/human residuals may be
visibly deferred while checking required recorded evidence; a confirmed static wiring omission cannot be deferred as runtime.
Do not assume an unchanged entry is disconnected: the baseline may already satisfy the promise. Do not cap a sum of parallel
session spans at one day or merge fork sessions without an explicit aggregation/identity contract. Test both false negatives and
false positives against independently fixed expectations. Fake matrices/executors test mechanics only, not model detection quality.

### Recovery without inventing conclusions

Inspect rawCounts separately from typed criteria; source-labelled observations are unverified candidates,
not validated defects or PASS. Zero criteria has its own error; a completed process is not a valid review.
Use actual decodePath/stopReason/usage (unknown stays null), not an assumed model capacity threshold or
automatic chunking. Compare startup engine identities across CLI/native/worker before attributing old behavior.
Retain original packet/raw/job/grant. Explicit change checks only unblock repair submissions; no amount of
parent testing, free prepare or history reconstruction replaces a required independent PASS or historical red.

## 4. Incremental scope

A blocking finding must be:

- introduced by changed material;
- a regression caused by the change;
- an incomplete fix for a claimed closure item.

Unchanged baseline issues are out of scope unless the user expands scope. Record them separately without changing the
incremental verdict. Cite exact changed lines for blocking introduced-by-diff/regression/incomplete-fix findings; retain the
prior finding closure matrix. A material contract/profile change needs full review instead of mechanically inheriting approval.
Empty ordinary diff is skipped without a model call, not an independent PASS.

## 5. Parent verification

For every blocking/high-risk item:

1. locate the cited hunk/artifact;
2. inspect current behavior and nearby tests;
3. reproduce safely when possible;
4. classify confirmed, rejected, downgraded, or out-of-scope;
5. record evidence and reasoning.

Do not blindly obey a reviewer and do not dismiss it merely because existing tests pass.

## 6. Convergence

- Confirmed semantic change: update governing contract first, then test and fix.
- Post-review fix: preserve the reviewed revision; create a new explicit revision/patch.
- If budget remains, use incremental review with the prior engine report for delta convergence; do not treat delta approval
  as full product/closure coverage. If project lifecycle requires a full current audit, use a full working-audit closure review
  within the same remaining authorization, with prior findings recorded, rather than performing two model calls.
- If budget is exhausted, parent verification can close local evidence but must not be mislabeled independent re-review.
- Stop when no confirmed blocker remains; do not weaken acceptance to force APPROVE.
- A user may explicitly waive a blocker; archive the exact waiver and consequence.

## 7. Archive

Follow project convention. If none exists, persist a review record alongside the governing artifact with:

- contract path;
- exact revision/patch boundary;
- reviewer model and isolation;
- reviewer-call budget used and remaining;
- independent verdict;
- parent disposition table;
- tests/real acceptance actually run;
- dirty/untracked exclusions;
- secret-scan result;
- unresolved follow-ups/waivers.

Review evidence never replaces runtime acceptance. `spec_review` is read-only, including proposal and delta PASS.
Only a matching full current working-tree `spec_audit` can write lifecycle audit; attaching an already completed valid
working-audit job is free, but ordinary/historical/delta reports cannot attach. Parent dispositions do not replace raw verdict.
Closure checks live gates/hashes and required human evidence; the model must not demand that its own in-flight review already
be PASS or the Spec already be done.
