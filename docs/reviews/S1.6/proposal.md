# S1.6 independent proposal review

- Contract: `docs/specs/S1.6-worktrees-and-language-neutral-gates.md`
- Parent-supplied base: `f842a28a174b41bacb67ce73290d8a30ab3e39ff`; contract was a new uncommitted draft, no implementation changes yet.
- Reviewer: `deepseek/deepseek-v4-flash`, synchronous research fork, fresh/read-only context. Reviewed complete contract and relevant core/profile/Action/README/test source. Reviewer could read files but had no Git execution tool, so did not independently resolve the parent-supplied base. No reviewer writes or paid subcalls.
- Call 1 of explicitly authorized maximum 3 in **this new delivery**. Prior S1.5 delivery verdicts/budget are separate and untouched.
- Independent verdict: **REVISE**. This is a proposal review, not implementation approval.

## Blocking findings (reviewer) and parent dispositions

| Finding | Reviewer evidence | Parent disposition before construction |
|---|---|---|
| B1: Generic Action drops old no-profile npm verify-only callers | Old default detectProjectConfig only selected typecheck/test/biome/vitest; old Action guaranteed npm run verify. Replacing it with default check --ci could lose the sole authoritative gate. | Confirmed. `verify` CLI uses explicit gates first, preserves no-gates-config npm verify exactly once, otherwise detected gates; copied-Action E2E covers configured and no-profile verify-only caller. |
| B2: New public schema not pinned | Contract named commands/evidence features but not exact fields, defaults, name/argv/path rules. Strict profile rejects unknown keys, so this is load-bearing. | Confirmed. Exact commands/evidence shapes, mutually exclusive gates, defaults, names/extensions/relative paths and runner argument rules added to contract before code. |
| B3: Mid-gate code writes can create ungated passing snapshots | Old impl snapshotted only after gates; optimistic spec content checks alone cannot protect implementation code. | Confirmed. Snapshots before and after gates/E2E; changes record FAIL and diagnostic. Actual delayed Python gate tests mutate code/spec during run; spec edits preserved via optimistic write check. |

## Non-blocking clarifications adopted

N1–N7 pinned prefix allocator namespace/max+1 rule, `worktrees` command, migration allocator configuration, explicit no-gate nonpass, live mode combinations/active-only errors, optional default lifecycle approval enforcement and declared E2E. The reviewer suggested rejecting all symlink executables; parent deliberately allows trusted venv interpreter links (common Python behavior). E2E evidence **files** still cannot be symlinks or leave the checkout. No security sandbox is claimed.

Parent approved the amended contract after confirming these fixes. That disposition does not convert the original REVISE into an independent implementation PASS. Two authorized reviewer calls remain for implementation and optional incremental closure.
