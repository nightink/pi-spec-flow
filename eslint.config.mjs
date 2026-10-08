import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Lint gate for the spec-flow extension, tests and E2E/smoke harnesses.
// Goal: block the bug classes LLM-written code drifts into (loose equality,
// promise executors that return values, unreachable/empty branches, shadowed
// or unused bindings, implicit globals, `any` leaks), not to reformat style.
export default tseslint.config(
  {
    ignores: ["node_modules/**", "docs/**", ".git/**", ".pi/**", "coverage/**"],
  },
  {
    files: ["**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["**/*.ts"] })),
  {
    files: ["**/*.mjs", "**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // ── equality / comparison ────────────────────────────────────────────
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-compare-neg-zero": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      // ── bug-class correctness ────────────────────────────────────────────
      "array-callback-return": ["error", { checkForEach: false, allowImplicit: false }],
      "no-constant-binary-expression": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "no-promise-executor-return": "error",
      "no-return-await": "error",
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
      "require-atomic-updates": "error",
      "no-template-curly-in-string": "error",
      "no-new-native-nonconstructor": "error",
      "no-self-assign": ["error", { props: true }],
      "no-self-compare": "error",
      "no-sequences": "error",
      "getter-return": "error",
      "no-setter-return": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-optional-chaining": "error",
      "no-dupe-else-if": "error",
      "no-duplicate-case": "error",
      "no-fallthrough": "error",
      "no-global-assign": "error",
      "no-import-assign": "error",
      "no-loss-of-precision": "error",
      "no-obj-calls": "error",
      "no-regex-spaces": "error",
      "no-sparse-arrays": "error",
      // ── async hygiene ────────────────────────────────────────────────────
      "no-async-promise-executor": "error",
      "no-await-in-loop": "off", // sequential gates/calls are intentional here
      // ── security / footguns ──────────────────────────────────────────────
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-proto": "error",
      "no-extend-native": "error",
      "no-octal-escape": "error",
      radix: "error",
      // ── explicit, non-sloppy code ───────────────────────────────────────
      "no-shadow": ["error", { builtinGlobals: false }],
      "no-implicit-coercion": "error",
      "no-unused-expressions": "error",
      "object-shorthand": ["error", "always"],
      "prefer-object-spread": "error",
      // ── dead / useless code ──────────────────────────────────────────────
      "no-unused-vars": ["error", {
        args: "after-used",
        argsIgnorePattern: "^_",
        caughtErrors: "none",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
      "no-useless-catch": "error",
      "no-useless-escape": "error",
      "no-useless-rename": "error",
      "no-useless-return": "error",
      "no-lonely-if": "error",
      "no-else-return": ["error", { allowElseIf: true }],
      "prefer-const": "error",
      "no-var": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "constructor-super": "error",
      "no-class-assign": "error",
      "no-const-assign": "error",
      "no-dupe-class-members": "error",
      "no-new-symbol": "error",
      "no-this-before-super": "error",
      "no-unreachable": "error",
    },
  },
  {
    // E2E/smoke harnesses and unit tests intentionally use plain async
    // callbacks, console output and dynamic process exits, and they mutate
    // process.env between awaits inside isolated sequential tests.
    files: ["*.test.mjs", "tests/**/*.mjs"],
    rules: {
      "no-console": "off",
      "require-atomic-updates": "off",
    },
  },
);
