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

| Behavior or risk | Automated evidence | Real acceptance | Isolation |
|---|---|---|---|
| <item> | <test/check> | <browser/service/process/device path> | <temporary state> |

## Acceptance

- [ ] <observable success assertion>
- [ ] <negative/failure assertion>
- [ ] <real integration assertion where needed>
- [ ] <full project gates and review evidence recorded>

## Review and decisions

Record proposal findings, parent dispositions, implementation review provenance, waivers, and human checkpoints required by
this project.

## Completion boundary

List deploy/restart/human steps that are intentionally separate. Distinguish source, built artifact, and live environment.
```

Todo state may mirror this contract but cannot be the only durable plan.
