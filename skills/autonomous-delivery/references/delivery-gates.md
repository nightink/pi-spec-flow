# Adaptive gates and real acceptance

This is a routing algorithm, not a command list. Discover current commands from project instructions, manifests, task runners,
and CI. Inspect unfamiliar commands before execution.

## 1. Map every changed behavior

A task can require multiple rows:

| Area | Targeted evidence | Real acceptance candidates |
|---|---|---|
| docs/spec/skill/config | parser/schema/link/discovery tests | actual load, render, command discovery, or generated output |
| backend/API/service | unit + integration + static/type checks | real service request, auth/error path, restart/recovery |
| DB/storage/migration | isolated DB tests, forward/backward compatibility | migration on disposable copy, restart, rollback/recovery |
| security/auth/permissions | positive and negative authorization tests | real boundary with dummy identities/credentials |
| frontend/web | component/store/router tests, production build | real browser main path, deep-link/refresh, keyboard/reconnect, visual overflow |
| mobile/device/desktop | platform unit/build tests | simulator/device or explicit human attestation if unavailable |
| protocol/SDK/client | producer + consumer + compatibility tests | real transport and supported-version matrix |
| CLI/daemon/process | parser/lifecycle/signal/error tests | real child process, exit codes, residual-process and recovery checks |
| package/build/release | artifact freshness, package/install dry-run | install/start from built artifact; never publish automatically |
| performance/concurrency | focused benchmark/invariant/race tests | representative load/streaming/parallel run with bounded resources |

## 2. Development loop

1. reproduce a bug or establish a failing contract test;
2. implement the smallest complete vertical slice;
3. run the narrowest relevant checks;
4. inspect the diff and warning delta;
5. update the governing artifact before accepting changed requirements;
6. repeat until the user-observable path is complete.

Do not optimize for green tests that do not cover the reported path.

## 3. Candidate gates

Before independent implementation review, establish what the current project requires, typically:

- formatter/lint with no newly introduced violations;
- type/static checks;
- affected unit and integration tests;
- build/generated artifact freshness;
- schema/spec/metadata validation;
- diff whitespace/conflict check;
- secret scanning of new scripts, packets, docs, and artifacts;
- relevant isolated E2E;
- explicit candidate boundary (commit SHAs or non-Git manifest/patch).

The project's authoritative full command wins. If none exists, compose the required CI jobs rather than inventing a familiar
command from another ecosystem.

## 4. Real acceptance rules

Real acceptance follows the product boundary, not the test framework:

- UI: built application in real browser/device, including direct entry and state transitions;
- service/API: real process and transport, not only handler calls;
- runtime/daemon/CLI: real child process, terminal result, signals/recovery/residuals;
- migration: disposable realistic data and restart behavior;
- SDK/integration: actual producer/consumer or explicit supported-version fixture;
- packaging: consume built package/artifact from outside the source path.

A static review, mock, queued command, HTTP acceptance response, screenshot of a different state, or unit test alone is not the
same evidence.

## 5. Isolation

Prefer unique temporary roots for HOME, app data, runtime sockets, sessions, DBs, project fixtures, caches, and ports. Use dummy
credentials unless the governing contract requires and the user authorizes a real provider. Install cleanup before processes
start; kill by recorded PID/runtime identity; remove state; check residuals. Never print tokens or copy production data casually.

## 6. Evidence ledger

For each important gate record:

- exact command or manual path;
- result and relevant counts;
- environment/isolation boundary;
- retained log/screenshot/artifact location;
- what it proves;
- what it does not prove;
- revision at which it ran.

Behavior-changing commits invalidate stale runtime evidence unless explicitly shown otherwise.
