# Native spec_review root union rejected before execution

- Date: 2026-10-06
- Status: resolved / parent-only source repair (no independent review or production adoption)
- Mother Spec: `docs/specs/S1.7-unified-review-and-spec-creation.md`, maintenance plan/result in Review journal only
- Baseline: `f8772afc43f70e2d56856b2c35c7f506b09e0c62`

## Report and accurate reproduction

User reports HTTP 400: `spec_review` function parameters require root `type: "object"`, but receive `type: null`; other executor requests also fail. A root `Type.Union` serializes to `anyOf` without an explicit root type. The complete tool list accompanies model requests, so one invalid declaration can reject a request intended to use another tool before any tool executes.

All nine actual native definitions were inspected through the installed trusted Pi SDK. Eight already have object roots; only `spec_review` does not. The actual OpenAI Completions and Responses serializers retain that invalid root. The actual Anthropic legacy converter forces an object root but loses all root-union branch properties, including action. Pre-network captures reproduce these declaration faults with zero HTTP requests, not a replay of the user's executor.

Earlier registration/execution-only smoke did not cover provider serialization. New fixture-resolution/allowlist/JSON-parse mistakes are separately archived and are not product reproductions.

## Repair and regression

- Flat closed `Type.Object`, same tool name/fields, nested action/mode enums and default prepare. No root anyOf/oneOf/allOf or tool splitting.
- Shared-engine exact action validation unchanged. Native and core negative tests reject missing/invalid job IDs, unknown actions/keys and action-inappropriate fields before charge/spawn. A disposable synthetic grant remains byte-identical at used=0; actual native negatives create no grant or job mutation.
- All nine object roots and exact property declarations survive actual SDK serialization to OpenAI Completions/Responses and Anthropic at onPayload; deliberately stop before sending, with a rejecting fetch guard.
- Node22 authority: 184/184 units plus eight E2E groups. Complete private Pi RPC/native/daemon-shaped/schema smoke exit 0, retaining S1.2 notification/commit/human-confirmation regression.

Evidence: `docs/reviews/S1.7/tool-schema/validation.md`. Historical S1.7 frontmatter, contract and audit/done preserved; old review does not cover new source. No provider/reviewer, real grant, real Spec/executor replay, install, example-app/global edit, production restart, push or hosted-CI operation. Owner must reload/rebind cached host/executor resources separately; offline payload acceptance is not hosted-provider acceptance.
