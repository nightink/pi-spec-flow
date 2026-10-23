// Synthetic plumbing fixtures; never real reviewer judgments or authorizations.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { begin, findSpec, implOutcome, writeFrontmatter } from "../../packages/core/src/core.mjs";
import { authorizeReviewBudget } from "../../packages/core/src/review-engine.mjs";

export const CLI = fileURLToPath(new URL("../../packages/core/src/core.mjs", import.meta.url));
export function deliveryFixture(t, inputs = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specflow-delivery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write(
    "docs/specs/S1.md",
    writeFrontmatter("# Fixture\n\n- [ ] [A1] Works.\n", {
      id: "S1",
      status: "approved",
      review: { decision: "approved" },
      evidence: { e2e: [], migrations: [], human: [] },
      review_inputs: inputs,
    }),
  );
  write(
    ".spec-flow.json",
    JSON.stringify({
      version: 1,
      gates: {
        mode: "replace",
        commands: [{ name: "test", argv: ["node", "-e", "process.exit(0)"] }],
      },
    }),
  );
  write(".gitignore", "*.log\ndist/\n");
  write("code.txt", "before\n");
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const fake = path.join(root, ".git", "fake.mjs");
  write(
    ".git/fake.mjs",
    `#!/usr/bin/env node\nimport fs from 'node:fs';import {mechanicalCoverage} from ${JSON.stringify(new URL("./review-fixture.mjs", import.meta.url).href)};fs.appendFileSync(${JSON.stringify(path.join(root, ".git/calls.txt"))},'call\\n');const result=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, ".git/result.json"))},'utf8'));console.log(JSON.stringify(mechanicalCoverage(result,fs.readFileSync(process.argv.at(-1).slice(1),'utf8'))));`,
  );
  fs.chmodSync(fake, 0o755);
  write(
    ".git/result.json",
    JSON.stringify({
      verdict: "fail",
      criteria: [{ criterion: "fixture", status: "fail", evidence: "synthetic finding only" }],
      scope_deviations: [],
    }),
  );
  const env = {
    ...process.env,
    SPECFLOW_AUDIT_BIN: fake,
    SPECFLOW_REVIEW_BUDGET_ID: "fixture",
    SPECFLOW_AUDIT_MAX_BYTES: "4194304",
  };
  const cli = (...args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: 60000,
    });
  return {
    root,
    write,
    git,
    cli,
    env,
    spec: () => findSpec(root, "S1"),
    update: (mutate) => {
      const s = findSpec(root, "S1");
      mutate(s.frontmatter);
      write("docs/specs/S1.md", writeFrontmatter(s.content, s.frontmatter));
    },
    async implement() {
      if (findSpec(root, "S1").frontmatter.status === "approved") await begin(root, "S1");
      write("code.txt", "after\n");
      const result = await implOutcome(root, "S1");
      assert.equal(result.pass, true, result.summary);
    },
    grant: () =>
      authorizeReviewBudget(root, {
        id: "fixture",
        calls: 2,
        note: "Isolated synthetic executor only; not a real provider authorization.",
      }),
  };
}
