// RESIDUAL lint gate — deliberately tiny.
//
// Biome (see biome.jsonc) is the only formatter and the only full linter. This
// config exists solely for the ESLint bug classes Biome still has no
// implementation for (verified with `biome migrate eslint` and `biome explain`):
// data-flow/syntax checks that Biome's rule set cannot express today. If Biome
// ships an equivalent, the rule must be deleted here, not duplicated.
//
// Scope is `**/*.mjs`: espree cannot parse TypeScript, and re-adding
// typescript-eslint just to run eight syntax rules over `index.ts` is not worth
// the dependency (that file is covered by Biome, `tsc` and `node --check`).
//
// Consciously NOT restored, because they are unreachable or covered elsewhere:
//   - no-delete-var / no-octal: hard SyntaxError in ESM (`node --check` proves it)
//   - @typescript-eslint/no-unused-expressions: covered by Biome `noUnusedExpressions`
//   - @typescript-eslint/triple-slash-reference: TS-only, and the pattern is absent
export default [
  { ignores: ["node_modules/**", "docs/**", ".pi/**", "coverage/**", "**/*.ts"] },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      // Lost updates: a value read before an `await` and written after it.
      "require-atomic-updates": "error",
      // `new Promise((resolve) => setTimeout(resolve, 10))` silently returns a value.
      "no-promise-executor-return": "error",
      // `return await` outside `try` adds a microtask hop for nothing.
      "no-return-await": "error",
      // A loop body that always exits/breaks makes the remaining iterations dead.
      "no-unreachable-loop": "error",
      // A value assigned and overwritten before any read.
      "no-useless-assignment": "error",
      // ASI hazard: `foo\n(bar)` is not a call.
      "no-unexpected-multiline": "error",
      // `new RegExp("(")` only fails at runtime; catch the literal case statically.
      "no-invalid-regexp": "error",
      // `new Symbol()` is a runtime TypeError that is statically visible.
      "no-new-symbol": "error",
    },
  },
];
