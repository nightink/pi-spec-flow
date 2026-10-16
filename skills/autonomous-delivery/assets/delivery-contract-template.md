# Lightweight delivery contract template

Use only when the current project has no governing Spec/issue/ADR/plan template. Adapt headings and location to the project.
Do not introduce a foreign metadata/status system.

```markdown
# <Outcome-oriented title>

## Context and observed facts

Separate repository/runtime evidence from assumptions. Link prior work.

## User-observable outcome

State what changes and why it matters.

## Non-goals

List adjacent work intentionally excluded.

## Invariants and safety boundaries

Cover data, compatibility, authorization, production isolation, performance, and concurrency where relevant.

## Design

Describe the smallest complete behavior, affected boundaries, failure semantics, and migration/rollback.

## Persistent implementation plan

1. <ordered vertical slice>
2. <tests/compatibility/migration>
3. <real acceptance/review/cleanup>

## Executable evidence matrix

| Promise / finding source | Acceptance ID | Automated evidence | Real acceptance | Isolation |
|---|---|---|---|---|
| <Outcome/Design/major source> | <A1> | <test/check and actual caller> | <browser/service/process/device path> | <temporary state> |

Reconcile all normative promises before approval; this author matrix is not a semantic completeness proof. Split compound
assertions, define metric units/aggregation and include positive/negative counterexamples. Distinguish helper capability,
actual entry wiring and execution. Explicitly identify needed unchanged caller context rather than assuming the diff contains it.

## Acceptance

- [ ] [A1] <observable success assertion>
- [ ] [A2] <negative/failure assertion>
- [ ] [A3] <actual entry and real integration assertion where needed>
- [ ] [A4] <full project gates and review evidence recorded>

## Review and decisions

Record proposal findings, parent dispositions, implementation review provenance, waivers, and human checkpoints required by
this project. For confirmed majors record original source → acceptance → fix/test evidence; Design-only notes are not closure.
Verified rejection or actual approved withdrawal/waiver needs its decision source and rationale. Never invent consent or turn
protocol/coverage gaps into confirmed product defects.

## Completion boundary

List deploy/restart/human steps that are intentionally separate. Distinguish source, built artifact, and live environment.
```

Todo state may mirror this contract but cannot be the only durable plan.
