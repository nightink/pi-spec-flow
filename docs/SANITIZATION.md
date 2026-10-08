# Sanitization pass v1 — path desensitization

- Date: 2026-10-08 (UTC 2026-10-08T14:00Z)
- Repository state: the tip of `main` before the sanitization commit; the history rewrite that followed removed pre-sanitization blobs, so commit SHAs referenced by older evidence (and this document's own pre-rewrite tip) no longer resolve.
- Scope: 74 tracked text files, 548 replacements

## Why

The repository is loaded as a public Pi git package (`pi install git:github.com/nightink/pi-spec-flow`). Historical evidence archives, governing specs and source files contained machine-local absolute paths (`/Users/<user>/...`, macOS temp folders, a local Node toolchain), references to a private consumer repository, and a local install path that predates the Pi git package mechanism. This pass removes that machine/private identity while keeping evidence content otherwise byte-identical apart from the replaced tokens.

## Placeholder vocabulary

| Rule | Count | Replacement |
|---|---|---|
| `repo-root` | 245 | 本仓库绝对路径（含 `file://`）→ 仓库相对路径 |
| `home-private-project` | 32 | 私有消费方项目在本机的扩展/worktree 路径 → `<home>/.../example-app` |
| `home` | 6 | 其余 `/Users/<user>/` 家目录路径 → `<home>/...` |
| `tmp` | 21 | macOS `/private/var/folders/<machine>/T/` → `<tmp>/` |
| `tmp-node` | 11 | 本机 node 发行目录 → `<tmp>/node-v22.19.0` |
| `tmp-artifact` | 13 | 临时验证产物目录（如 `specflow-*-scan.txt`）→ `<tmp>/...` |
| `runner` | 14 | GitHub-hosted runner 路径 → `<runner>/...` |
| `private-project` | 204 | 私有消费方项目标识（仓库 slug、包名、测试 fixture 名、证据文件名）→ `example-app` / `example-org/example-app` |
| `personal-repo` | 2 | 历史示例中的个人/第三方仓库路径 → `~/git/github.com/<org>/<repo>` |

Paths inside this repository became repository-relative paths (e.g. `/Users/<user>/.pi/agent/extensions/<repo>/core.mjs` → `core.mjs`). Paths outside became `<home>/...`, `<tmp>/...` or `<runner>/...`. Generic POSIX test fixtures (`/tmp/x`, `/tmp/no-pkg`, `/tmp/my dir`) and the macOS behavior comment in `core.mjs` (`/private/tmp`) were intentionally left untouched because they carry no machine identity.

## Product/source edits from this pass

- `README.md`: install section now documents `pi install git:github.com/nightink/pi-spec-flow`; the cross-repo Action section now describes a public caller instead of private same-account access; removed the stale `integrations/skill-migration.mjs` self-test line (that file was deleted in `845f011`).
- `package.json`: `typecheck` no longer references the deleted `integrations/skill-migration.mjs`.
- Test fixture naming was neutralized: the spec fixture factory and its test titles no longer reference the private consumer project (`project-profile.test.mjs`, `tests/e2e/e2e-project-governance-profile.mjs`, `tests/smoke/pi-daemon-ui.mjs`). No test behavior changed.

## Evidence re-binding

`evidence-manifest.json` files were recomputed for the 26 evidence files whose bytes changed. Each entry keeps the prior binding under `sanitizedFrom`, and every manifest carries a top-level `sanitization` block. Historical `source-manifest.json` review boundaries over product sources are intentionally not rewritten: they describe what was reviewed at the time and were already stale for later commits.

| Manifest | File | Before | After |
|---|---|---|---|
| `docs/reviews/S1.2/daemon-ui/evidence-manifest.json` | `fixture-import-failure.log` | `ed430321f912` (1089 B) | `46086408f03d` (998 B) |
| `docs/reviews/S1.2/daemon-ui/evidence-manifest.json` | `full-check.log` | `fdd2a6c30ae2` (42962 B) | `df222422c0e1` (42983 B) |
| `docs/reviews/S1.2/daemon-ui/evidence-manifest.json` | `parent-verification.json` | `fa0f3a2de72d` (2528 B) | `819f461e88a9` (2529 B) |
| `docs/reviews/S1.2/daemon-ui/evidence-manifest.json` | `pre-fix-sdk.log` | `c6880edc1729` (1307 B) | `86b6dcdae22f` (1142 B) |
| `docs/reviews/S1.2/daemon-ui/evidence-manifest.json` | `pre-fix.log` | `79be386bf48e` (16707 B) | `03f503fdded4` (13535 B) |
| `docs/reviews/S1.5/github-evidence-manifest.json` | `github/example-app-ci-at-run.yml` | `dcff3c590201` (898 B) | `c76821a87107` (905 B) |
| `docs/reviews/S1.5/github-evidence-manifest.json` | `github/example-app-run.json` | `4b6f3b618d3e` (291 B) | `3f58bfb6bcd8` (301 B) |
| `docs/reviews/S1.5/github-evidence-manifest.json` | `github/example-app-success.log` | `fe97691b32a0` (34493 B) | `3faaf574fa9c` (34605 B) |
| `docs/reviews/S1.7/execution-fix/evidence-manifest.json` | `fixture-absolute-argv-failure.log` | `e26e4dec06eb` (9576 B) | `e04e3e939ba6` (6783 B) |
| `docs/reviews/S1.7/execution-fix/evidence-manifest.json` | `fixture-canonical-path-failure.log` | `63f2b56cbf76` (8653 B) | `b57f87e609e2` (8460 B) |
| `docs/reviews/S1.7/execution-fix/evidence-manifest.json` | `fixture-profile-key-failure.log` | `496c06766f9b` (9419 B) | `0ac29ff5d54d` (6626 B) |
| `docs/reviews/S1.7/execution-fix/evidence-manifest.json` | `fixture-typebox-null-failure.log` | `7734655e740d` (36546 B) | `27eda3b11c49` (36418 B) |
| `docs/reviews/S1.7/execution-fix/evidence-manifest.json` | `full-check.log` | `b7147fc16444` (39722 B) | `9959b88fdeb7` (39743 B) |
| `docs/reviews/S1.7/execution-fix/evidence-manifest.json` | `pre-fix.log` | `1b0208418a72` (6209 B) | `42c92871a913` (5572 B) |
| `docs/reviews/S1.7/output-repair/evidence-manifest.json` | `full-check.log` | `efe011ab0e1c` (46244 B) | `403cf4f66822` (46265 B) |
| `docs/reviews/S1.7/output-repair/evidence-manifest.json` | `parent-verification.json` | `bec0a8947c68` (5731 B) | `e80890e14cae` (5753 B) |
| `docs/reviews/S1.7/output-repair/evidence-manifest.json` | `pre-fix.log` | `f9a4cea651f8` (7636 B) | `c81e232952af` (6761 B) |
| `docs/reviews/S1.7/output-repair/evidence-manifest.json` | `real-retained-response.json` | `95c881c146aa` (2908 B) | `01e64a91cb1c` (2923 B) |
| `docs/reviews/S1.7/output-repair/evidence-manifest.json` | `sync-api-regression.log` | `78411c35ef81` (24136 B) | `6cc4936f6c13` (23954 B) |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | `docs/reviews/S1.7/tool-schema/fixture-allowlist-failure.log` | `b810c66f750f` (482 B) | `ed6c687ea122` (384 B) |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | `docs/reviews/S1.7/tool-schema/fixture-budget-parse-failure.log` | `ba68ae03e36d` (9197 B) | `c498fb4b40f2` (9106 B) |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | `docs/reviews/S1.7/tool-schema/fixture-esm-resolution-failure.log` | `22318016997f` (862 B) | `78ee9d2a7283` (804 B) |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | `docs/reviews/S1.7/tool-schema/full-check.log` | `5a745977c1bf` (43212 B) | `be02d550a077` (43233 B) |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | `docs/reviews/S1.7/tool-schema/parent-verification.json` | `368f79fab4c5` (4643 B) | `880c762fbfd3` (4604 B) |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | `docs/reviews/S1.7/tool-schema/pre-fix-unit.log` | `08400d90ff22` (3441 B) | `85eb15e83869` (3350 B) |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | `docs/reviews/S1.7/tool-schema/pre-fix-wire.log` | `2f82e102581a` (2073 B) | `83e741e98245` (2024 B) |

## Governing spec re-binding

The sanitization changed the hashed contract body of four closed Specs. Their `impl.contract_hash` / `audit.contract_hash` were re-bound to the normalized contract, and a note was inserted inside each `## Review 与决策` region, which `specContractHash` excludes. This records a token-level normalization only; it is not a new implementation or review.

| Spec | contract_hash before | contract_hash after |
|---|---|---|
| `docs/specs/S1.4-project-governance-profiles.md` | `a924b9b71856` | `9adebf47cd5b` |
| `docs/specs/S1.5-project-contract-check-and-shared-action.md` | `2ac917797f9a` | `a8f0739f8563` |
| `docs/specs/S1.6-worktrees-and-language-neutral-gates.md` | `bdfc63414217` | `ec127da20170` |
| `docs/specs/S1.7-unified-review-and-spec-creation.md` | `958bcca7a2b3` | `ac175be71926` |

`S1.2` and `S1.3` already recompute to their recorded hashes: their sanitized tokens were entirely inside the excluded Review region.

## Changed files

| File | Replacements | Before | After |
|---|---|---|---|
| `docs/issues/2026-09-15-gate-cache-tree-null.md` | 1 | `14e3909b491b` | `35d49770cc6e` |
| `docs/issues/2026-10-06-daemon-ui-notify.md` | 4 | `a0032125c083` | `c94263b3ac47` |
| `docs/issues/2026-10-06-native-review-object-schema.md` | 1 | `c42b720af49d` | `745bbbd696bc` |
| `docs/issues/2026-10-07-recoverable-review-output.md` | 2 | `6292087a736c` | `79f3c028c858` |
| `docs/issues/review-execution-timeout-and-pi-launcher.md` | 3 | `53d806276768` | `00e45094e0f2` |
| `docs/reviews/S1.2/daemon-ui/closure.md` | 1 | `1a064cf68b67` | `f2b222ca8fd1` |
| `docs/reviews/S1.2/daemon-ui/evidence-manifest.json` | 19 | `74b2e768a7da` | `b25183a2e8d4` |
| `docs/reviews/S1.2/daemon-ui/fixture-import-failure.log` | 2 | `ed430321f912` | `46086408f03d` |
| `docs/reviews/S1.2/daemon-ui/full-check.log` | 3 | `fdd2a6c30ae2` | `df222422c0e1` |
| `docs/reviews/S1.2/daemon-ui/parent-verification.json` | 6 | `fa0f3a2de72d` | `819f461e88a9` |
| `docs/reviews/S1.2/daemon-ui/pre-fix-sdk.log` | 5 | `c6880edc1729` | `86b6dcdae22f` |
| `docs/reviews/S1.2/daemon-ui/pre-fix.log` | 66 | `79be386bf48e` | `03f503fdded4` |
| `docs/reviews/S1.2/daemon-ui/secret-scan.md` | 2 | `21172fac3192` | `502b91125ec3` |
| `docs/reviews/S1.2/daemon-ui/validation.md` | 2 | `6828c88204bb` | `76ed7365d75c` |
| `docs/reviews/S1.5/closure.md` | 3 | `b4b84332ff71` | `901211457f56` |
| `docs/reviews/S1.5/full-check.log` | 3 | `7cfd96b46fef` | `48bdeaa6d3ff` |
| `docs/reviews/S1.5/github-evidence-manifest.json` | 7 | `08c389ae821e` | `1b399f58cf1f` |
| `docs/reviews/S1.5/github/example-app-ci-at-run.yml` (renamed) | 1 | `dcff3c590201` | `c76821a87107` |
| `docs/reviews/S1.5/github/example-app-run.json` (renamed) | 1 | `4b6f3b618d3e` | `3f58bfb6bcd8` |
| `docs/reviews/S1.5/github/example-app-success.log` (renamed) | 22 | `fe97691b32a0` | `3faaf574fa9c` |
| `docs/reviews/S1.5/historical-audit-3.json` | 1 | `db437ae50a6d` | `4bdfc5c94086` |
| `docs/reviews/S1.5/implementation-2-receipt.json` | 2 | `c8ea7a431417` | `7a614ecf034d` |
| `docs/reviews/S1.5/postreview-check.log` | 3 | `8ad3a3360dd4` | `36bd6cb99e12` |
| `docs/reviews/S1.5/pre-fix.log` | 3 | `cb685f6224ff` | `b37c14f9af0f` |
| `docs/reviews/S1.5/pre-rebind-check.log` | 3 | `40e8e4a25295` | `b9a6a1d1d686` |
| `docs/reviews/S1.5/proposal-receipt.json` | 2 | `452a5d292a40` | `77b9a64efe79` |
| `docs/reviews/S1.5/secret-scan.md` | 1 | `43a58d8aae90` | `0b04cd738327` |
| `docs/reviews/S1.5/validation.md` | 13 | `3b7095e421ac` | `a622adbcdba1` |
| `docs/reviews/S1.6/full-check.log` | 3 | `c3619582746d` | `bf554563c60b` |
| `docs/reviews/S1.6/implementation-1.json` | 2 | `4d27f4ccee72` | `8065779320f1` |
| `docs/reviews/S1.6/secret-scan.md` | 2 | `80e2a6fe81e2` | `8ca0ef9f81fd` |
| `docs/reviews/S1.6/validation.md` | 3 | `045c68a6abc4` | `b4f2d3644e68` |
| `docs/reviews/S1.7/execution-fix/evidence-manifest.json` | 2 | `ed3ea3247bbb` | `1dc00b817f28` |
| `docs/reviews/S1.7/execution-fix/fixture-absolute-argv-failure.log` | 58 | `e26e4dec06eb` | `e04e3e939ba6` |
| `docs/reviews/S1.7/execution-fix/fixture-canonical-path-failure.log` | 4 | `63f2b56cbf76` | `b57f87e609e2` |
| `docs/reviews/S1.7/execution-fix/fixture-profile-key-failure.log` | 58 | `496c06766f9b` | `0ac29ff5d54d` |
| `docs/reviews/S1.7/execution-fix/fixture-typebox-null-failure.log` | 5 | `7734655e740d` | `27eda3b11c49` |
| `docs/reviews/S1.7/execution-fix/full-check.log` | 3 | `b7147fc16444` | `9959b88fdeb7` |
| `docs/reviews/S1.7/execution-fix/pre-fix.log` | 14 | `1b0208418a72` | `42c92871a913` |
| `docs/reviews/S1.7/execution-fix/secret-scan.md` | 1 | `9d219108f75a` | `c0f679e71426` |
| `docs/reviews/S1.7/execution-fix/validation.md` | 4 | `849380f076c7` | `aa89f4f6349b` |
| `docs/reviews/S1.7/full-check.log` | 3 | `0ecc7628bfbb` | `4330bb42ba61` |
| `docs/reviews/S1.7/output-repair/full-check.log` | 3 | `efe011ab0e1c` | `403cf4f66822` |
| `docs/reviews/S1.7/output-repair/parent-verification.json` | 6 | `bec0a8947c68` | `e80890e14cae` |
| `docs/reviews/S1.7/output-repair/pre-fix.log` | 19 | `f9a4cea651f8` | `c81e232952af` |
| `docs/reviews/S1.7/output-repair/real-retained-response.json` | 5 | `95c881c146aa` | `01e64a91cb1c` |
| `docs/reviews/S1.7/output-repair/secret-scan.md` | 2 | `ab6519c99259` | `3c3b6a319039` |
| `docs/reviews/S1.7/output-repair/sync-api-regression.log` | 4 | `78411c35ef81` | `6cc4936f6c13` |
| `docs/reviews/S1.7/output-repair/validation.md` | 1 | `a568bc221c5b` | `8567352198e0` |
| `docs/reviews/S1.7/postreview-check.log` | 3 | `ac3bb84eaa4f` | `a54b8a18778b` |
| `docs/reviews/S1.7/proposal.md` | 1 | `c64e7d2dce38` | `d86896956c76` |
| `docs/reviews/S1.7/secret-scan.md` | 2 | `9ca6490251e3` | `b6ae6e5af35f` |
| `docs/reviews/S1.7/tool-schema/closure.md` | 1 | `fa59ba7a5312` | `3e847964c078` |
| `docs/reviews/S1.7/tool-schema/evidence-manifest.json` | 11 | `afd875281a34` | `ebb6fadcfc58` |
| `docs/reviews/S1.7/tool-schema/fixture-allowlist-failure.log` | 2 | `b810c66f750f` | `ed6c687ea122` |
| `docs/reviews/S1.7/tool-schema/fixture-budget-parse-failure.log` | 2 | `ba68ae03e36d` | `c498fb4b40f2` |
| `docs/reviews/S1.7/tool-schema/fixture-esm-resolution-failure.log` | 2 | `22318016997f` | `78ee9d2a7283` |
| `docs/reviews/S1.7/tool-schema/full-check.log` | 3 | `5a745977c1bf` | `be02d550a077` |
| `docs/reviews/S1.7/tool-schema/parent-verification.json` | 6 | `368f79fab4c5` | `880c762fbfd3` |
| `docs/reviews/S1.7/tool-schema/pre-fix-unit.log` | 2 | `08400d90ff22` | `85eb15e83869` |
| `docs/reviews/S1.7/tool-schema/pre-fix-wire.log` | 1 | `2f82e102581a` | `83e741e98245` |
| `docs/reviews/S1.7/tool-schema/secret-scan.md` | 2 | `f787446ffed3` | `7ae2f642dbf2` |
| `docs/reviews/S1.7/tool-schema/validation.md` | 1 | `a6fdb04bb76e` | `9ea4a02b728a` |
| `docs/reviews/S1.7/validation.md` | 5 | `7bdad034ae1b` | `1dc4d8bcc56e` |
| `docs/specs/S1.1-commit-gate-repo-detection.md` | 2 | `ab7ac92726b6` | `324ff6b555ad` |
| `docs/specs/S1.2-trustworthy-gates-and-closure.md` | 5 | `68834575409b` | `737176f230f4` |
| `docs/specs/S1.4-project-governance-profiles.md` | 44 | `e8110b570cd6` | `4961da5833ac` |
| `docs/specs/S1.5-project-contract-check-and-shared-action.md` | 25 | `832d9f61c586` | `f790b4e580e4` |
| `docs/specs/S1.6-worktrees-and-language-neutral-gates.md` | 9 | `37b3f947f8ce` | `647b34829b19` |
| `docs/specs/S1.7-unified-review-and-spec-creation.md` | 13 | `e22da04dd1ef` | `e0465c11cee8` |
| `project-profile.test.mjs` | 16 | `78e71b95d240` | `d9d919a30fe5` |
| `README.md` | 3 | `8340b4c3ced4` | `4a2e70ad1828` |
| `tests/e2e/e2e-project-governance-profile.mjs` | 2 | `4667b86a201c` | `f6766af47fcb` |
| `tests/smoke/pi-daemon-ui.mjs` | 1 | `6ad678fbe00d` | `20481a89bcd4` |

## Verification

```bash
git grep -nE "/Users/|/private/var/folders|/private/tmp"   # only the macOS comment in core.mjs remains
node --test core.test.mjs project-profile.test.mjs        # renamed fixtures still pass
npm run check                                             # authority gate
```

## Not covered by this pass

- The accompanying history rewrite purges pre-sanitization blobs from reachable history; GitHub may retain unreachable objects, and existing clones/forks keep their old copies until refreshed.
- Evidence manifests are documentation-level SHA bindings; no product code reads them. The repository's own gate (`npm run check`) is what proves the tree still works.
- Opaque private-consumer identifiers that cannot be resolved without access to that repository are kept as evidence content: commit SHAs, GitHub run/job numbers, spec IDs and file counts in historical review records. They carry no credentials or machine paths.
