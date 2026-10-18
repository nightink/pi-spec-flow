# S2.1 candidate evidence and boundaries

Governing contract: `docs/specs/S2.1-monorepo-core-and-pi-adapter.md`.
Implementation base: `5d1411d28be3bd1712f7193413c301035131b1c7`.

## What is recorded

- `pi-smoke.log`: real Pi 1.x SDK/RPC smoke suite (RPC load, native typed tools,
  daemon UI shape, provider serializers, root-manifest skill discovery). Private
  temporary agent/project state; zero provider requests.
- `packages.log`: workspace link and package-name import from `packages/pi`, the
  `spec-flow` bin on a disposable Git fixture, a Pi git-install-shaped
  (`npm install --omit=dev --legacy-peer-deps`) and a CI/Action-shaped
  (`npm ci --omit=dev --omit=peer`) install in disposable copies, and the
  `npm pack --dry-run` surface of `packages/core`.
- `source-manifest.json`: changed product sources and tests with SHA-256 and
  execute bits. The governing Spec and this review archive are excluded.

The authoritative gate/E2E record is the normalized `impl` block in the Spec
(`npm run check`, `e2e-review-execution.mjs`, `e2e-monorepo-packages.mjs`), not
these convenience logs.

## Boundaries

- No npm publish, registry name/scope ownership claim, push, tag or deploy.
- No independent model review was run for this delivery. The lifecycle remains
  at `impl` PASS until an explicitly authorized review grant is provided.
- No second agent-harness implementation is claimed; the executor contract is
  exercised with a disposable non-Pi executor module.
- Importing these logs does not prove a hosted CI run or remote publication.

## Review history and remediation

- Audit attempt 1 (`S2.1-audit-20261018`, job `fc0eb32f…`): execution error, not a
  product result. `--thinking max` emitted 126,705 JSON delta events and hit the
  worker's 32 MiB raw cap (exit 143); no verdict was produced. The grant was
  charged and is not reused.
- Audit attempt 2 (`S2.1-audit-20261018b`): completed with a coverage/evidence
  gap, not a product defect. It required A6 smoke results to be normalized/bound
  and A7 to exercise the exact `action.yml` path rather than a copied CLI.
- Remediation: `package-layout.test.mjs` asserts the static package/manifest
  boundary in the normal check gate; `e2e-private-action.mjs` now executes the
  exact `action.yml` CLI path; the real-host smoke additionally loads the
  extension and skill through the root manifest and stays a recorded runtime
  fact because CI does not install a Pi host.
