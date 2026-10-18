# Adding an agent-harness adapter

spec-flow splits **capability** from **harness**:

```text
packages/core   @nightink/spec-flow-core   lifecycle, gates, sealed review engine, budgets, CLI
packages/pi     @nightink/pi-spec-flow     Pi tools/commands/UI/notifications + autonomous-delivery skill
packages/<x>    <your adapter>             another harness: register tools, present progress, launch its CLI
```

The engine never imports a harness SDK and never hardcodes a harness launch
protocol. The only bundled harness-specific code is the optional reference
executor `executors/pi-cli.mjs` (Pi CLI argv); adapters replace it through the
executor contract. Core also never writes another harness's local metadata. An
adapter is a thin package that:

1. depends on `@nightink/spec-flow-core` (a normal semver dependency; workspaces
   link it during git installs) and declares the host SDK only as an optional
   peer dependency;
2. imports engine functions by package specifier — never by filesystem path;
3. owns the harness's review launch protocol through an executor module;
4. maps engine results and progress into the harness's tool/command UI;
5. ships its own tests, including a fake-CLI end-to-end run with no provider.

## 1. Package skeleton

```text
packages/my-agent/
├── package.json
├── index.ts               # harness entry: registers spec_* tools/commands
├── adapter-core.mjs       # host-free presentation helpers (notifications, truncation)
├── executor.mjs           # review launch protocol for this harness
└── tests/ or root tests   # fake-CLI E2E + real-host smoke
```

`package.json`:

```json
{
  "name": "@example/spec-flow-my-agent",
  "type": "module",
  "dependencies": { "@nightink/spec-flow-core": "^0.3.0" },
  "peerDependencies": { "@example/agent-sdk": "*" },
  "peerDependenciesMeta": { "@example/agent-sdk": { "optional": true } }
}
```

For a Pi adapter, also declare the host manifest (extension + skill paths) in the
package that is installed, as `packages/pi/package.json` does.

## 2. Implement the executor module

```js
// executor.mjs
export function resolve(cwd, env) {
  return {
    bin: env.MY_AGENT_BIN || "/absolute/default/binary",
    prefixArgs: [],
    launcher: "my-agent",
    model: env.MY_AGENT_MODEL || "",
    thinking: "off",              // off|minimal|low|medium|high|xhigh|max
    timeout: 180000,              // 1..1800000 ms
  };
}

export function buildArgs(execution, promptFile) {
  // Last argv item MUST be `@${promptFile}`; the worker proves the child input
  // is byte-identical to the sealed packet (child_input_sha256 === packet_sha256).
  return ["--isolated", "--json", `@${promptFile}`];
}

export const envDeny = ["MY_AGENT_SESSION_ID"];
export const envSet = { MY_AGENT_OFFLINE: "1" };
```

Pass it explicitly from the adapter (no global default required):

```ts
import { audit, reviewSpec } from "@nightink/spec-flow-core";
import { buildArgs, envDeny, envSet, resolve } from "./executor.mjs";

const executor = { resolve, buildArgs, envDeny, envSet };
await reviewSpec(cwd, input, { executor, signal, onProgress });
await audit(cwd, id, { executor, budgetId, reviewJobId, signal, onProgress });
```

The engine loads/validates the executor and serializes the invocation **before**
charging the immutable budget, so an invalid adapter launch fails free. The
worker only spawns the serialized argv; it has no harness-specific code.

## 3. Map the engine surface

Lifecycle tools should call the core API under the host's file-mutation queue
where the host provides one:

```ts
findSpec / begin / impl / audit / attest / done / board / renderSpecDetail
newSpec / reviewSpec / allocateSpecId / renderWorktrees
```

Presentation helpers stay in the adapter: `hasUI`, `confirm`, `notify`, progress
updates and text truncation. Notification capability failure must never change
gate results, spend budgets or write lifecycle evidence.

## 4. Verification checklist

- Unit: executor contract (`resolve` shape, `buildArgs` final `@file`, `envDeny`/`envSet`).
- E2E: prepare → invalid executor fails before charge → custom fake CLI runs the
  sealed packet → `child_input_sha256 === packet_sha256` → budget charged once.
- Real host smoke: tool schemas/registration, skill discovery if applicable,
  zero provider calls.
- Packaging: `npm pack --dry-run` contains only `src`-equivalent code and docs;
  no engine copy, no host SDK in `dependencies`.

Do not copy `packages/core/src` into an adapter, add harness SDKs to core, or
reimplement budget/packet/caching logic. Those are the shared correctness
surface; adapters only translate protocol and presentation.
