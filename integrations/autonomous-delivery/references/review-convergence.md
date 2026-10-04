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
means the plan is implementable/testable; it does not prove future code.

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
- packet secret-scanned.

If Git is unavailable, build an explicit before/after file manifest and patch, disclose reduced provenance, and do not invent
SHAs or claim Git-level isolation.

Use a clean temporary worktree when unrelated dirty state would otherwise contaminate the packet. Respect project policy on
commits; never create or rewrite commits when forbidden.

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
