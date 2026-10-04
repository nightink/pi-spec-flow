# S1.7 execution repair — parent-only validation

## Authority and consent

- Intake baseline: `2164ffb65c744cdf31f448e45d7d25ad6da8af65`; main, one worktree. Initial dirty state was only this task's issue/index, created in the preceding feedback stage.
- Governing mother: `docs/specs/S1.7-unified-review-and-spec-creation.md`, existing sealed-executor/parameter compatibility and no-respawn invariants. Parent-approved maintenance plan was recorded in its Review region before product construction.
- User explicitly chose **B: repair + tests, no independent model calls**. This repair has **zero** independent calls, no new real grant, no borrowed S1.5/S1.7 balance. Fake grants/results below are disposable execution fixtures, never independent evidence.
- The original S1.7 done/frontmatter, six accepted requirements and audit remain unchanged. `parent-verification.json` asserts exact frontmatter equality to baseline, unchanged semantic contract `958bcca7a2b351cf91e37f7746ee343b99b6a6b3841530e1c675fd605bbcce68`, record gaps=[]; its old snapshot is historical and is not this repair's tree. No begin/impl/audit/done was run on the real mother.
- No example-app/global skill edits, installs, push, remote writes, production restarts, production credentials/database/session reads. Environment inspection was masked; values were not copied to these artifacts.

## Observed bugs and delivered behavior

1. Baseline first-run timeout already refreshed a prepared job; the confirmed gap was missing feedback for running/terminal reuse, not proof that an old running timer should be overwritten. Pre-fix tests fail on absent executionInfo. New `executionInfo` reports requested/effective timeout, started/wait-existing/reuse-result, applied/ignored flags and a concrete new-job/no-auto-retry explanation. Native tools receive progress; cached audit text also exposes actual settings. Invalid cached override does not invalidate a retained valid result. Receipt execution/provenance is not rewritten.
2. Missing PATH pi failed after charge/spawn, and review had no reusable Node+CLI route for the caller's audit-only shim workaround. Baseline real worker fixtures reproduce `spawn pi ENOENT` and failure to reject before spending. New shared filesystem preflight resolves BIN before charge, preserves explicit trusted shim priority and adds explicit `SPECFLOW_PI_CLI`: current Node + caller-trusted installed absolute CLI, without requiring PATH pi or generating a shim. It never probes `--version`, loads targets, installs, guesses npx cache or edits PATH. Failed preflight leaves prepared jobs reusable and budget unchanged.
3. Timeout zero previously fell back silently to the default. Invalid timeout is now rejected (1..1800000 ms). Actual child timeout is retained as timed_out/nonpassing with the original duration; increasing configuration on terminal replay never respawns or refunds.

## Actual commands and results

Platform: macOS arm64; Node **v22.19.0**, `<tmp>/node-v22.19.0/bin/node`. `typecheck` is syntax/static parse, not tsc. No dependency changes/install.

| Evidence | Command / boundary | Actual result |
|---|---|---|
| `pre-fix.log` | Node22 `node --test review-execution.test.mjs` before product edits | 7 failed contract regressions; includes missing diagnostics, missing preflight and audit `spawn pi ENOENT`. Prepared execution's duration was already current, but its feedback assertion failed. |
| `targeted.log` | Node22 `node --test review-creation.test.mjs review-execution.test.mjs` | **31/31 PASS** (23 existing, 8 new). Running/cache reuse, unstarted stale settings, permission/missing bin/CLI, invalid timeout, BIN precedence, explicit Node CLI, PATH/relative BIN, charged timeout replay, lifecycle cache. |
| `cli.log` | Node22 `node tests/e2e/e2e-review-execution.mjs` | **3 PASS** through actual core CLI and detached worker. No PATH pi; rejected launch costs zero; same prepared review/audit can run after trusted CLI configuration; effective timeout and exact packet bytes; cached metadata byte-identical; timed-out job stays charged/nonpassing. |
| `full-check.log` | `PATH=<tmp>/node-v22.19.0/bin:$PATH npm run check` | **exit 0**, syntax/bundle validation, **169/169 units**, **eight real E2E groups**, final contracts-only. Existing JS/Python/worktree/private-Action closure regressions remain green. |
| `pi-smoke.log` | Node22 `npm run smoke:pi`, explicit existing trusted Pi CLI/SDK under `<home>/.pi/worktrees/example-app/node_modules` | **exit 0**. Actual isolated Pi 1.x CLI RPC/SDK discovers `/spec`, worktrees, typed tools and executionInfo schema; nested free skipped-job replay returns structured feedback. No provider/agent_start. One synthetic zero-usage assistant is plumbing only. |
| `parent-verification.json` | Read-only baseline/current comparison plus Spec consistency | exit 0; original frontmatter and semantic contract unchanged, gaps=[]; zero independent calls. |

Fixture corrections are retained separately, never counted as product evidence: initial profile used an unsupported `file` key, then an unsupported absolute gate argv; corrected to the existing `{name,argv:["node",...]}` contract. A relative BIN assertion used noncanonical `/var` instead of Git's `/private/var`; corrected expected identity, not production resolution. The fake Typebox stub lacked Null; added it without weakening assertions, then actual SDK smoke verified the real schema. Those logs have explicit `fixture-*` names. A lifecycle test's initially empty diff was corrected before final pre-fix capture; only the resulting ENOENT path is used for reproduction.

## Binding and limits

`source-manifest.json` freezes all **13 changed product/source/test/doc paths** exercised by the latest gates, with bytes/SHA-256/executable mode; it excludes the mother journal, issue and acceptance archives and is not a full repository snapshot. `evidence-manifest.json` binds the eleven retained logs/probes (including final contracts-only). Two TAP failure logs remove only trailing horizontal whitespace to pass git diff --check; their exact original bytes/hashes are retained privately under `.git/spec-flow/acceptance/S1.7-execution-fix/` and disclosed in the manifest. No lines are removed; all other logs are unchanged. Source hashes must still match before local commit; docs-only archive additions do not constitute another run or a new audit.

Preflight proves filesystem readiness only, not Pi version compatibility, interpreter behavior or protection against later executable replacement. Caller must explicitly select/trust the CLI/shim. macOS/POSIX acceptance; no new Windows guarantee. Existing valid legacy/missing-local portable receipts retain their documented boundary; cached diagnostics show unknown timeout when unavailable.

## Closure

Parent verified the changed hunks, executable fixtures, full authority and actual host/CLI results. The local repair is **implemented and tested, parent-only**. **Not independently reviewed**, no new lifecycle audit PASS or normal done claim; the old mother done state describes only its historical delivery. Publication and production resource reload/deployment remain owner-controlled follow-up, not performed here.
