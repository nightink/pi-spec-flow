# S1.6 parent validation provenance (2026-10-02)

Contract: `docs/specs/S1.6-worktrees-and-language-neutral-gates.md`. Base: `f842a28a174b41bacb67ce73290d8a30ab3e39ff`. Validation ran on the task implementation before candidate commit; the exact changed-source SHA-256 manifest is `source-manifest.json` (excludes lifecycle contract and review/validation-only artifacts). Files can be checked against the candidate diff without trusting a bare prose claim.

| Command | Result / retained stdout |
|---|---|
| `npx -y -p node@22.19.0 -c 'npm run check'` | PASS: 136/136 Node tests, six CLI/subprocess E2E suites, ordinary check --ci. `full-check.log` is complete stdout/stderr, not only a tail. |
| `SPECFLOW_PI_BIN=<already-installed-Pi-CLI> npx -y -p node@22.19.0 -c 'npm run smoke:pi'` | PASS: real Pi discovers /spec and renders /spec plus /spec worktrees via RPC; no agent/model run. `pi-smoke.log`. |
| `npm audit --omit=dev` | 0 vulnerabilities; no new runtime dependency or lockfile change. `dependency-audit.log`. |
| `git diff --check` | PASS (no output). Exact staged diff and sealed endpoint packet were scanned before commit/model; no findings. See `secret-scan.md` for actual tool report and packet SHA-256. |

Local environment: macOS, Node 22.19.0 for authoritative checks, Python 3.9.6, Git 2.50.1. Python fixtures use standard-library unittest; no pip, uv sync, or provider call. JS/npm compatibility paths and explicit generic commands remain real subprocesses. The offline copied-Action acceptance uses this repository's already-installed locked Node dependencies; it does not prove GitHub hosting/permissions or caller dependency provisioning. The Action still runs locked npm ci for its own runtime in GitHub; no remote Action run/push has been performed in this delivery.

Safety: unique disposable Git repos/worktrees, dummy specs, isolated counters/cache files; fixtures delete their temporary roots and signal/await test child processes. No example-app production credential/database/session data read or written. This delivery does not touch example-app. Runtime environment values and Pi diagnostics are not retained in these artifacts.

Coverage includes: package.json-free Python unit/E2E/migration files; intentional failing tests; schema/path/argv errors; literal shell metacharacters; missing executables and no gates; two linked/detached/spaced worktrees; same-content vs content-changing integration; live snapshot mismatch rejected before model invocation; six competing ID allocator subprocesses; removed/unavailable worktrees; same-ID locks vs distinct IDs; cancellation; delayed-gate code/spec edits. Positive closure/audit unit fixtures use explicit **fake** auditors to test mechanics, never counted as this Spec's independent audit.

Budget at initial archival: proposal call 1/3 (independent REVISE, parent incorporated B1–B3). Later implementation call 2/3 returned FAIL (5/6 PASS) solely for review/scan provenance; original JSON is `implementation-1.json`, parent dispositions are in the Spec's Review section. Source code unchanged in the closure revision; remaining budget is one final independent audit. Do not relabel prior S1.5 FAIL, close example-app 63, or claim review provenance here is itself model approval.
