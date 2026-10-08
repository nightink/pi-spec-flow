import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  approvalProblems,
  dependencyIds,
  loadProjectProfile,
  statusRole,
} from "./project-profile.mjs";
import {
  audit,
  begin,
  checkCI,
  commitGateDecision,
  detectProjectConfig,
  done,
  findSpec,
  impl,
  parseFrontmatter,
  specContractHash,
  writeFrontmatter,
} from "./core.mjs";

function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-profile-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function init(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=spec-flow-profile",
      "-c",
      "user.email=spec-flow@example.invalid",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: root }
  );
}

function profile(overrides = {}) {
  return {
    version: 1,
    lifecycle: {
      preReview: ["draft", "in-review"],
      startable: ["approved"],
      active: "in-progress",
      done: "done",
      ignored: ["archived"],
      dependenciesField: "depends_on",
      updatedField: "updated",
      bodyStatusLine: false,
      legacyActive: "external-warning",
      externalActiveIds: [3],
      approval: {
        reviewersField: "reviewers",
        reviewedAtField: "reviewed_at",
        minimumReviewers: 1,
        placeholderReviewers: ["pending"],
      },
      ...overrides.lifecycle,
    },
    gates: {
      mode: "replace",
      npmScripts: ["verify"],
      ...overrides.gates,
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => !["lifecycle", "gates"].includes(key))
    ),
  };
}

function exampleAppSpec({
  id,
  status = "approved",
  reviewers = ["parent/2026-09-21"],
  reviewedAt = "2026-09-21",
  dependsOn = [],
  check = false,
  repo,
} = {}) {
  return writeFrontmatter(
    `# ${id}. example-app-shaped spec\n\n## 验收标准\n\n- [${check ? "x" : " "}] configured lifecycle works\n`,
    {
      id,
      title: `example-app-shaped ${id}`,
      kind: "spec",
      status,
      created: "2026-09-21",
      updated: "2026-09-21",
      author: "agent",
      reviewers,
      reviewed_at: reviewedAt,
      depends_on: dependsOn,
      supersedes: [],
      evidence: { human: [] },
      ...(repo ? { impl: { repo } } : {}),
    }
  );
}

function fakeAuditor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specflow-profile-auditor-"));
  const file = path.join(dir, "fake-auditor.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({verdict:"pass",criteria:[{criterion:"profile lifecycle",status:"pass",evidence:"configured diff"}],scope_deviations:[]}));\n`,
    { mode: 0o755 }
  );
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("project profile: strict config loads status, approval, dependencies, and replace gates", () => {
  const root = project({
    "package.json": JSON.stringify({ scripts: { verify: "node verify.mjs", test: "node test.mjs" } }),
    ".spec-flow.json": JSON.stringify(profile()),
  });
  const loaded = loadProjectProfile(root);
  assert.equal(loaded.configured, true);
  assert.equal(statusRole(loaded, "draft"), "preReview");
  assert.equal(statusRole(loaded, "approved"), "startable");
  assert.equal(statusRole(loaded, "archived"), "ignored");
  assert.deepEqual(dependencyIds(loaded, { depends_on: [1, 2] }), [1, 2]);
  assert.deepEqual(
    approvalProblems(loaded, { reviewers: ["pending"], reviewed_at: "2026-09-21" }),
    ["reviewers needs at least 1 non-placeholder reviewer(s)"]
  );
  assert.deepEqual(
    detectProjectConfig(root, loaded).gates.map((gate) => gate.name),
    ["verify"]
  );
});

test("project profile: unknown keys, missing scripts, overlapping status, and symlinks fail closed", () => {
  const packageJson = JSON.stringify({ scripts: { verify: "node verify.mjs" } });

  const unknown = project({
    "package.json": packageJson,
    ".spec-flow.json": JSON.stringify({ ...profile(), surprise: true }),
  });
  assert.throws(() => loadProjectProfile(unknown), /unknown key: surprise/);

  const missing = project({
    "package.json": packageJson,
    ".spec-flow.json": JSON.stringify(profile({ gates: { npmScripts: ["absent"] } })),
  });
  assert.throws(() => loadProjectProfile(missing), /script does not exist: absent/);

  const overlap = project({
    "package.json": packageJson,
    ".spec-flow.json": JSON.stringify(profile({ lifecycle: { ignored: ["done"] } })),
  });
  assert.throws(() => loadProjectProfile(overlap), /overlaps/);

  const reserved = project({
    "package.json": packageJson,
    ".spec-flow.json": JSON.stringify(profile({ lifecycle: { updatedField: "impl" } })),
  });
  assert.throws(() => loadProjectProfile(reserved), /non-reserved/);

  const blanket = project({
    "package.json": packageJson,
    ".spec-flow.json": JSON.stringify(profile({ lifecycle: { externalActiveIds: [] } })),
  });
  assert.throws(() => loadProjectProfile(blanket), /must list each historical active spec/);

  const outside = project({ "profile.json": JSON.stringify(profile()) });
  const linked = project({ "package.json": packageJson });
  fs.symlinkSync(path.join(outside, "profile.json"), path.join(linked, ".spec-flow.json"));
  assert.throws(() => loadProjectProfile(linked), /regular non-symlink/);
});

test("project profile: invalid config blocks commit while explicit bypass remains available", async () => {
  const root = project({
    "package.json": JSON.stringify({ scripts: { verify: "node verify.mjs" } }),
    ".spec-flow.json": JSON.stringify({ ...profile(), unknown: true }),
  });
  const blocked = await commitGateDecision(root, "git commit -m test");
  assert.equal(blocked.action, "block");
  assert.match(blocked.reason, /配置无效/);
  const bypassed = await commitGateDecision(
    root,
    "SPECFLOW_BYPASS=1 git commit -m test"
  );
  assert.equal(bypassed.action, "bypass");
});

test("project profile: configured lifecycle rejects an external implementation repo", async () => {
  const external = project({ "implementation.txt": "external\n" });
  const root = project({
    "package.json": JSON.stringify({ scripts: { verify: "node verify.mjs" } }),
    ".spec-flow.json": JSON.stringify(profile(), null, 2),
    "verify.mjs": "console.log('verified');\n",
    "specs/1.external.md": exampleAppSpec({ id: 1, repo: external }),
  });
  await assert.rejects(begin(root, "1"), /do not support an external impl\.repo/);
});

test("project profile: external legacy warning is limited to explicit IDs", async () => {
  const root = project({
    "package.json": JSON.stringify({ scripts: { verify: "node verify.mjs" } }),
    ".spec-flow.json": JSON.stringify(profile(), null, 2),
    "verify.mjs": "console.log('verified');\n",
    "specs/3.allowed.md": exampleAppSpec({ id: 3, status: "in-progress" }),
    "specs/6.unreviewed.md": exampleAppSpec({ id: 6, reviewers: ["pending"] }),
    "specs/9.not-allowed.md": exampleAppSpec({ id: 9, status: "in-progress" }),
  });
  await assert.rejects(begin(root, "6"), /non-placeholder reviewer/);
  const result = await checkCI(root);
  assert.equal(result.pass, false);
  assert.match(result.output, /3: external legacy active spec/);
  assert.match(result.output, /6: proposal approval 非法/);
  assert.match(result.output, /9: legacy in-progress spec/);
});

test("project profile: example-app-shaped numeric lifecycle preserves local metadata and uses verify only", async () => {
  const marker = path.join(os.tmpdir(), `specflow-profile-marker-${process.pid}-${Date.now()}`);
  const root = project({
    "package.json": JSON.stringify({
      scripts: {
        verify: "node verify.mjs",
        typecheck: "node typecheck.mjs",
        test: "node test.mjs",
      },
    }),
    ".spec-flow.json": JSON.stringify(profile(), null, 2),
    "verify.mjs": `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(marker)}, "verify\\n"); console.log("verified");\n`,
    "typecheck.mjs": `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(marker)}, "typecheck\\n");\n`,
    "test.mjs": `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(marker)}, "test\\n");\n`,
    "specs/1.dependency.md": exampleAppSpec({ id: 1, status: "done", check: true }),
    "specs/2.feature.md": exampleAppSpec({ id: 2, dependsOn: [1] }),
    "specs/3.legacy-active.md": exampleAppSpec({ id: 3, status: "in-progress" }),
    "specs/4.draft.md": exampleAppSpec({ id: 4, status: "draft", reviewers: ["pending"], reviewedAt: null }),
    "specs/5.archived.md": exampleAppSpec({ id: 5, status: "archived", reviewers: ["pending"], reviewedAt: null }),
  });
  init(root);

  assert.equal(findSpec(root, "2")?.relativePath, "specs/2.feature.md");
  assert.equal(findSpec(root, "2.feature.md")?.frontmatter.id, 2);

  const before = await checkCI(root);
  assert.equal(before.pass, true, before.output);
  assert.match(before.output, /external legacy active spec/);

  await begin(root, "2");
  let feature = findSpec(root, "2");
  assert.equal(feature.frontmatter.status, "in-progress");
  assert.equal(feature.frontmatter.workflow_version, 2);
  assert.equal(feature.frontmatter.reviewers[0], "parent/2026-09-21");
  assert.equal(feature.frontmatter.depends_on[0], 1);
  assert.match(feature.frontmatter.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(feature.content, /^- 状态：/m);

  let invalidated = parseFrontmatter(feature.content);
  invalidated.data.reviewers = [" pending "];
  fs.writeFileSync(
    path.join(root, "specs/2.feature.md"),
    writeFrontmatter(feature.content, invalidated.data)
  );
  await assert.rejects(impl(root, "2"), /non-placeholder reviewer/);
  feature = findSpec(root, "2");
  invalidated = parseFrontmatter(feature.content);
  invalidated.data.reviewers = ["parent/2026-09-21"];
  fs.writeFileSync(
    path.join(root, "specs/2.feature.md"),
    writeFrontmatter(feature.content, invalidated.data)
  );

  fs.writeFileSync(path.join(root, "implementation.txt"), "profile implementation\n");
  const implemented = await impl(root, "2");
  assert.match(implemented, /PASS/);
  assert.deepEqual(
    fs.readFileSync(marker, "utf8").trim().split("\n"),
    ["verify", "verify"],
    "checkCI and impl run only the configured verify script"
  );

  feature = findSpec(root, "2");
  const loadedProfile = feature.profile;
  const originalHash = specContractHash(feature.content, loadedProfile);
  const parsed = parseFrontmatter(feature.content);
  parsed.data.updated = "2099-01-01";
  parsed.data.reviewed_at = "2099-01-02";
  parsed.data.reviewers = ["another-reviewer"];
  const metadataChanged = writeFrontmatter(feature.content, parsed.data);
  assert.equal(specContractHash(metadataChanged, loadedProfile), originalHash);

  const auditor = fakeAuditor();
  const previousBin = process.env.SPECFLOW_AUDIT_BIN;
  process.env.SPECFLOW_AUDIT_BIN = auditor.file;
  const { authorizeReviewBudget } = await import("./review-engine.mjs");
  authorizeReviewBudget(root, { id: "mechanical-tests", calls: 1, note: "Synthetic profile fixture with a fake auditor only; no real review call." });
  try {
    const audited = await audit(root, "2", { budgetId: "mechanical-tests" });
    assert.match(audited, /PASS/);
  } finally {
    if (previousBin === undefined) delete process.env.SPECFLOW_AUDIT_BIN;
    else process.env.SPECFLOW_AUDIT_BIN = previousBin;
    auditor.cleanup();
  }

  const closed = await done(root, "2");
  assert.match(closed, /已完成/);
  feature = findSpec(root, "2");
  assert.equal(feature.frontmatter.status, "done");
  assert.equal(feature.frontmatter.depends_on[0], 1);
  assert.equal(feature.frontmatter.reviewers[0], "parent/2026-09-21");
  assert.doesNotMatch(feature.content, /^- 状态：/m);

  fs.rmSync(marker, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("project profile: config content is snapshot-bound after impl", async () => {
  const root = project({
    "package.json": JSON.stringify({ scripts: { verify: "node verify.mjs" } }),
    ".spec-flow.json": JSON.stringify(profile(), null, 2),
    "verify.mjs": "console.log('verified');\n",
    "specs/1.feature.md": exampleAppSpec({ id: 1 }),
  });
  init(root);
  await begin(root, "1");
  fs.writeFileSync(path.join(root, "implementation.txt"), "implemented\n");
  await impl(root, "1");

  const changed = profile({
    lifecycle: { approval: {
      reviewersField: "reviewers",
      reviewedAtField: "reviewed_at",
      minimumReviewers: 1,
      placeholderReviewers: ["pending", "todo"],
    } },
  });
  fs.writeFileSync(path.join(root, ".spec-flow.json"), JSON.stringify(changed, null, 2));
  await assert.rejects(audit(root, "1"), /implementation changed after spec_impl/);
});

test("project profile: changed contract can re-impl when verify runs contracts-only", async () => {
  const cli = fileURLToPath(new URL("./core.mjs", import.meta.url));
  const root = project({
    "package.json": JSON.stringify({ scripts: { verify: "node verify.mjs" } }),
    ".spec-flow.json": JSON.stringify(profile(), null, 2),
    "verify.mjs": `import { execFileSync } from "node:child_process"; execFileSync(process.execPath, [${JSON.stringify(cli)}, "check", "--ci", "--contracts-only"], { stdio: "inherit" }); if (process.env.FAIL_VERIFY === "1") process.exit(1);\n`,
    "specs/1.done.md": exampleAppSpec({ id: 1, status: "done", check: true }),
    "specs/2.feature.md": exampleAppSpec({ id: 2, dependsOn: [1] }),
  });
  try {
    init(root);
    await begin(root, "2");
    assert.match(await impl(root, "2"), /PASS/);
    const file = path.join(root, "specs/2.feature.md");
    fs.appendFileSync(file, "\nNew contract: demonstrate re-implementation.\n");
    let consistency = await checkCI(root, { runProjectGates: false });
    assert.equal(consistency.pass, false);
    assert.match(consistency.output, /contract_hash 已过期/);
    // A failed prior audit record must not be forwarded to the project gate.
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    fm.data.audit = { verdict: "fail" };
    fs.writeFileSync(file, writeFrontmatter(fs.readFileSync(file, "utf8"), fm.data));
    assert.match(await impl(root, "2"), /PASS/);
    let current = findSpec(root, "2").frontmatter;
    assert.equal(current.impl.pass, true);
    assert.equal(current.audit, undefined);
    assert.equal((await checkCI(root, { runProjectGates: false })).pass, true);

    process.env.FAIL_VERIFY = "1";
    const failed = await impl(root, "2");
    assert.match(failed, /FAIL/);
    current = findSpec(root, "2").frontmatter;
    assert.equal(current.impl.pass, false);
    consistency = await checkCI(root, { runProjectGates: false });
    assert.equal(consistency.pass, false);
    assert.match(consistency.output, /impl.pass 不是 true/);
  } finally {
    delete process.env.FAIL_VERIFY;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
