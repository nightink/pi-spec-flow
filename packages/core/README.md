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
spec-flow board
spec-flow worktrees
spec-flow spec-alloc [--prefix S1.]
spec-flow spec-new --json '<object>'
spec-flow begin <id>
spec-flow impl <id>
spec-flow audit <id> [--review-job <32-hex JOB_ID>]
spec-flow attest <id> <item> <note>
spec-flow done <id>
spec-flow verify
spec-flow check --ci [--contracts-only] [--live]
spec-flow review --json '{"action":"prepare"|"run"|"status"|"repair", ...}'
spec-flow review-budget --json '<grant>'
```

Review/audit execution needs an external model CLI. CI-only commands
(`verify`, `check`, `board`, `impl`) never call a provider.

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
} from "@nightink/spec-flow-core";

// The CLI and the Pi adapter share exactly this entry surface.
const specs = loadSpecs(process.cwd());
```

Subpath exports: `./review`, `./coverage`, `./executor`, `./profile`,
`./workspace`, `./spec-creation`, `./executors/pi-cli`.

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
| `SPECFLOW_REVIEW_BUDGET_ID` | Default authorized cycle grant for CLI runs |
| `SPECFLOW_GATE_CACHE_TTL_MS` | Gate cache TTL |

## Publishing

The package is prepared for `npm publish` from `packages/core` with
`publishConfig.access = "public"`. `npm pack --dry-run` is verified by the
repository E2E suite. Publication, scope ownership and versioning remain the
maintainer's decision.

## License

MIT © 2026 nightink. See [LICENSE](LICENSE).
