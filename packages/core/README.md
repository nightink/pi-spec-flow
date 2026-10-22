# @nightink/spec-flow-core

Harness-neutral engine and CLI for the evidence-bound spec workflow used by
[pi-spec-flow](https://github.com/nightink/pi-spec-flow). It owns the Spec
contract, gate execution, sealed review packets, durable review jobs, budgets
and lifecycle state. It has no dependency on the Pi SDK, typebox or any other
agent harness, and the engine imports no harness SDK. The bundled
`executors/pi-cli.mjs` is an optional reference executor: adapters replace it
through the executor contract.

## Install and use

```bash
npm install --save-dev @nightink/spec-flow-core
npx spec-flow board
npx spec-flow check --ci
```

Node.js `>=22.19.0` is required. The package ships `src/` and `templates/`
only; install it instead of pointing gate scripts at a path inside a Pi package
checkout.

Common commands (run from the target repository; Spec directories are
discovered from `docs/specs`, `docs/spec`, `specs` or `spec`):

```text
spec-flow board [ID] [--live] [--json]
spec-flow worktrees
spec-flow spec-alloc [--prefix S1.]
spec-flow spec-new --json '<object>'
spec-flow begin <id>
spec-flow impl <id>                            # non-zero exit when evidence fails
spec-flow audit <id> --prepare [--max-bytes N]
spec-flow audit <id> --review-job <32-hex JOB_ID>
spec-flow audit <id>                           # run with the existing authorization
spec-flow attest <id> <item> <note>
spec-flow done <id>
spec-flow verify
spec-flow check --ci [--contracts-only] [--live]
spec-flow review --json '{"action":"prepare"|"run"|"status"|"repair", ...}'
spec-flow review-budget --json '<grant>'
```

Review/audit execution needs an external model CLI. `board`, `impl`, `audit --prepare`,
`verify` and `check` never call a provider. `audit --prepare` is free (no model, no
charge, no Spec/ledger write) and only seals a private prepared job; running or
attaching it still needs the existing authorization.

## Test

```bash
npm test        # package-local unit tests (also run from the repository root)
```

## Library API

```js
import {
  board,
  loadSpecs,
  begin,
  impl,
  audit,
  done,
  newSpec,
  reviewSpec,
  prepareAudit,
  implOutcome,
  auditOutcome,
  inspectBoard,
} from "@nightink/spec-flow-core";

// The CLI and the Pi adapter share exactly this entry surface.
const specs = loadSpecs(process.cwd());
const result = await inspectBoard(process.cwd(), { live: true });
```

The legacy text APIs (`board`, `impl`, `audit`, …) remain compatible. The CLI and
Pi adapter use the structured entry points below instead of parsing text.

### Machine results and recovery

`implOutcome()` / `auditOutcome()` return:

```js
{
  version: 1,
  operation: "impl" | "audit",
  specId: "S1.2",
  pass: false,
  category: "impl-fail",       // or pass/product-fail/coverage-gap/protocol-error/...
  summary: "…bounded, human-readable…",
  nextActions: [{ tool, args, reason, requiresAuthorization, requiresHuman }],
  jobId: "…",                  // audit only when a retained job exists
  packetPath: "…",             // audit only
  diagnostic: { code, category, stage, message, nextActions, … },
}
```

`prepareAudit(cwd, id, { maxBytes?, signal?, onProgress? })` returns the ordinary
review status plus `prepared: true`, `modelInvoked: false`, `bytes`, `maxBytes`,
`limits` and `nextActions`. It never invokes a model, consumes budget, or writes
Spec/ledger; a prepared job is neither PASS nor an error. `inspectBoard(cwd, { id,
live, signal })` returns `{version:1, freshness:"record-only"|"live", note, specs:
[{id, file, status, statusLabel, stage, fresh, blockers, nextActions}], summary}`.
Default `record-only` does not read the checkout; `live:true` computes freshness.

### Recommended path

One path covers both entry points (identical in the CLI and the Pi adapter):

1. `spec_new` creates an unapproved draft; complete the contract and apply the
   project's approval/status rule.
2. `spec_review {action:"prepare", mode:"proposal", id}` seals the proposal
   packet for free. Inspect `packetPath`, then run it with an existing grant.
3. `spec_begin` → `spec_impl`. PASS is `pass:true`/exit 0; FAIL is
   `pass:false`/non-zero with a machine category.
4. `prepareAudit` / `spec_audit {action:"prepare"}` / `audit --prepare` seals the
   full current packet for free: no model, no charge, no Spec/ledger write. Scan
   the packet, then execute or attach the same job with existing authorization.
5. `spec_attest` after real human verification → `spec_done`.

`inspectBoard` is record-only by default; pass `live:true` when current-checkout
freshness matters, and never treat record-only output as proof that evidence is
still fresh.

### Recovery table

Recovery is category-driven, not emoji-driven. Errors thrown by core
workspace/limit paths carry `error.diagnostic` with a stable code; adapters must
return that machine data, not reverse-engineer prose.

| Category | Meaning | Next action |
|---|---|---|
| `precondition-error` | status/approval/base_sha/evidence shape unsatisfied | fix the named precondition; never bypass |
| `impl-fail` / `impl-unstable` | gates failed, or content changed during gates | fix and rerun `spec_impl` |
| `product-fail` | static product verdict failed | act on findings, re-impl and re-prepare |
| `coverage-gap` | coverage/evidence gap, not a confirmed product bug | add acceptance/caller evidence; a contract change needs re-impl |
| `protocol-error` | tool output protocol error | free `review repair` when `repairable`; not a PASS |
| `execution-error` | launcher/execution/binding failure | inspect `status` and private evidence; fix config, no auto-retry |
| `limit-exceeded` | complete material exceeds the sealed byte limit | re-prepare with a larger explicit limit; no truncation or scope narrowing |
| `fresh:false` (live board) | checkout drifted from impl evidence | rerun `spec_impl` in this checkout before preparing audit |
| `configuration-error` | a registered worktree member is unverifiable | read-only `git worktree list --porcelain` / `prune --dry-run`; never auto-prune |

### Gate evidence

`impl.gates.<name>` records `pass`, the exact `command` (`{cmd}` or
`{file,args}`), the combined output `bytes`, `output_sha256`, and bounded
`head`/`tail` lines. A gate whose tail happens to be a sub-script summary is
therefore still statically provable as fully executed. These records describe a
real run; they do not let a reviewer re-execute it.

### Packet byte limits

Packet limits resolve as **explicit `maxBytes` > `SPECFLOW_AUDIT_MAX_BYTES` >
524288**. The allowed range is `1..16777216` bytes; environment values must be a
non-empty decimal integer string (empty means unset; fractions, suffixes and
out-of-range values fail before any charge). This is a UTF-8 byte limit, not a
model token capacity or zero-finding guarantee. `review prepare` and `audit
--prepare` may set it; run/status/read reuse the policy sealed with the job, and
legacy jobs without metadata keep the 512 KiB compatibility limit. Changing the
current environment never rewrites a retained job.

Subpath exports: `./review`, `./coverage`, `./review-limits`, `./diagnostics`,
`./executor`, `./profile`, `./workspace`, `./spec-creation`, `./executors/pi-cli`.

## Review executor contract

The sealed review engine is harness-neutral. A review run resolves an executor
module exporting:

```js
// resolve(cwd, env) -> execution
export function resolve(cwd, env = process.env) {
  return {
    bin: "/absolute/tool",     // spawned executable
    prefixArgs: [],            // optional leading argv entries
    launcher: "custom",        // receipt label
    model: "",                 // provider model or ""
    thinking: "off",           // one of the review thinking levels
    timeout: 180000,           // 1..1800000 ms
  };
}

// buildArgs(execution, promptFile) -> argv after bin/prefixArgs
export function buildArgs(execution, promptFile) {
  return ["--model", execution.model || "default", `@${promptFile}`]; // last item MUST be `@${promptFile}`
}

// Optional: ambient variables removed before the child spawns, and values set
// for the child afterwards.
export const envDeny = ["MY_AGENT_SESSION_ID"];
export const envSet = { MY_AGENT_OFFLINE: "1" };
```

The final argument must be `@<promptFile>` so the worker can prove that the
child input is byte-identical to the sealed packet
(`child_input_sha256 === packet_sha256`).

Select a module by absolute path:

```bash
SPECFLOW_REVIEW_EXECUTOR=/absolute/path/my-executor.mjs spec-flow audit S1.1
```

or pass a pre-loaded `{ resolve, buildArgs }` object as `options.executor` when
embedding the engine. The engine imports the executor and builds the serialized
invocation **before** charging the immutable review budget, so an invalid
executor fails free.

Adapter boundaries and a package template are documented in the repository at
`docs/adapters.md`.

The bundled `./executors/pi-cli` module is the reference implementation: it
honors `SPECFLOW_AUDIT_BIN`, `SPECFLOW_REVIEW_CLI`, the legacy
`SPECFLOW_PI_CLI`, then `pi` on `PATH`, and builds the Pi CLI argv
(`-p --no-session ... --mode json --thinking <level> @packet`).

## Environment

| Variable | Purpose |
|---|---|
| `SPECFLOW_REVIEW_EXECUTOR` | Absolute path to an executor module |
| `SPECFLOW_AUDIT_BIN` | Trusted executable that already speaks the selected argv |
| `SPECFLOW_REVIEW_CLI` | Absolute JS CLI run with the current Node |
| `SPECFLOW_PI_CLI` | Legacy alias for the Pi CLI |
| `SPECFLOW_AUDIT_MODEL` / `SPECFLOW_AUDIT_THINKING` | Model and thinking labels |
| `SPECFLOW_AUDIT_TIMEOUT` | First-run timeout in ms (1..1800000) |
| `SPECFLOW_AUDIT_MAX_BYTES` | Prepare packet byte limit (default 524288, 1..16777216; explicit `maxBytes` wins) |
| `SPECFLOW_REVIEW_BUDGET_ID` | Default authorized cycle grant for CLI runs |
| `SPECFLOW_GATE_CACHE_TTL_MS` | Gate cache TTL |

## Publishing

The package is prepared for `npm publish` from `packages/core` with
`publishConfig.access = "public"`. `npm pack --dry-run` is verified by the
repository E2E suite. Publication, scope ownership and versioning remain the
maintainer's decision.

## License

MIT © 2026 nightink. See [LICENSE](LICENSE).
