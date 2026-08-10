import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  parseFrontmatter,
  serializeFrontmatter,
  extractBodyStatus,
  renderStatusLine,
  replaceBodyStatusLine,
  detectDrift,
  detectGates,
  validateEvidence,
  migrationAlloc,
  cmdBoard,
  cmdBegin,
  cmdDone,
  cmdAttest,
  cmdCheck,
  STATUS_MAP,
} from "./core.mjs";

function makeProject(specs = [], opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "specflow-test-"));
  mkdirSync(join(dir, "docs", "specs"), { recursive: true });
  for (const s of specs) {
    writeFileSync(join(dir, "docs", "specs", s.file), s.content);
  }
  if (opts.packageJson) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(opts.packageJson));
  }
  if (opts.biome) {
    writeFileSync(join(dir, "biome.json"), "{}");
  }
  if (opts.migrations) {
    const migDir = join(dir, "packages", "db", "src", "migrations");
    mkdirSync(migDir, { recursive: true });
    for (const f of opts.migrations) {
      writeFileSync(join(migDir, f), "// migration");
    }
  }
  if (opts.e2e) {
    const e2eDir = join(dir, "tests", "e2e");
    mkdirSync(e2eDir, { recursive: true });
    for (const f of opts.e2e) {
      writeFileSync(join(e2eDir, f), "// e2e test");
    }
  }
  // Init git repo so gitHead works
  try {
    execSync("git init -q && git add -A && git commit -qm init --allow-empty", { cwd: dir });
  } catch { /* may fail in CI, that's ok */ }
  return dir;
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────
describe("frontmatter", () => {
  it("parses valid frontmatter", () => {
    const content = `---
id: S1.0
status: pending
---
# Title
body text`;
    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter.id, "S1.0");
    assert.equal(frontmatter.status, "pending");
    assert.ok(body.includes("# Title"));
  });

  it("returns null frontmatter for no-frontmatter file", () => {
    const content = "# Title\nbody text";
    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter, null);
    assert.equal(body, content);
  });

  it("roundtrips serialize → parse", () => {
    const data = { id: "S1.0", status: "in-progress", review: { by: "user", decision: "approved" } };
    const body = "\n# Title\n- 状态：🔄 进行中\n";
    const serialized = serializeFrontmatter(data, body);
    const { frontmatter, body: parsedBody } = parseFrontmatter(serialized);
    assert.equal(frontmatter.id, "S1.0");
    assert.equal(frontmatter.status, "in-progress");
    assert.equal(frontmatter.review.decision, "approved");
    assert.ok(parsedBody.includes("# Title"));
  });
});

// ─── Status mapping ──────────────────────────────────────────────────────────
describe("status mapping", () => {
  it("maps all four statuses", () => {
    assert.equal(STATUS_MAP.pending, "待 review");
    assert.equal(STATUS_MAP.approved, "已批准");
    assert.equal(STATUS_MAP["in-progress"], "进行中");
    assert.equal(STATUS_MAP.done, "已完成");
  });

  it("renders status line with emoji", () => {
    const line = renderStatusLine("in-progress");
    assert.ok(line.includes("🔄"));
    assert.ok(line.includes("进行中"));
  });

  it("replaces body status line", () => {
    const body = "# Title\n\n- 状态：📋 待 review\n\nSome text";
    const newBody = replaceBodyStatusLine(body, "in-progress");
    assert.ok(newBody.includes("进行中"));
    assert.ok(!newBody.includes("待 review"));
  });
});

// ─── Drift detection ─────────────────────────────────────────────────────────
describe("drift detection", () => {
  it("detects drift when body status doesn't match frontmatter", () => {
    const fm = { status: "in-progress" };
    const body = "- 状态：📋 待 review\n";
    const drift = detectDrift(fm, body);
    assert.ok(drift);
    assert.equal(drift.expected, "进行中");
  });

  it("no drift when body matches frontmatter", () => {
    const fm = { status: "in-progress" };
    const body = "- 状态：🔄 进行中（2026-08-10 开工）\n";
    const drift = detectDrift(fm, body);
    assert.equal(drift, null);
  });

  it("returns null when no body status line", () => {
    const fm = { status: "in-progress" };
    const body = "# Title\nno status line here\n";
    const drift = detectDrift(fm, body);
    assert.equal(drift, null);
  });

  it("returns null when no frontmatter", () => {
    const drift = detectDrift(null, "- 状态：📋 待 review\n");
    assert.equal(drift, null);
  });
});

// ─── Evidence validation ─────────────────────────────────────────────────────
describe("evidence validation", () => {
  it("flags missing e2e files", () => {
    const dir = makeProject([], { e2e: ["e2e-01.mjs"] });
    const fm = { evidence: { e2e: ["e2e-01", "e2e-99"] } };
    const issues = validateEvidence(fm, dir);
    assert.ok(issues.some((i) => i.includes("e2e-99")));
    assert.ok(!issues.some((i) => i.includes("e2e-01")));
    rmSync(dir, { recursive: true });
  });

  it("passes when all e2e files exist", () => {
    const dir = makeProject([], { e2e: ["e2e-01.mjs", "e2e-02.mjs"] });
    const fm = { evidence: { e2e: ["e2e-01", "e2e-02"] } };
    const issues = validateEvidence(fm, dir);
    assert.equal(issues.length, 0);
    rmSync(dir, { recursive: true });
  });

  it("handles missing e2e directory", () => {
    const dir = makeProject([]);
    const fm = { evidence: { e2e: ["e2e-01"] } };
    const issues = validateEvidence(fm, dir);
    assert.ok(issues.some((i) => i.includes("e2e directory missing")));
    rmSync(dir, { recursive: true });
  });
});

// ─── Migration allocation ────────────────────────────────────────────────────
describe("migrate-alloc", () => {
  it("returns next number after existing migrations", () => {
    const dir = makeProject([], {
      migrations: ["001-init.ts", "002-users.ts", "015-trail.ts"],
    });
    const result = migrationAlloc(dir);
    assert.equal(result.next, "016");
    rmSync(dir, { recursive: true });
  });

  it("returns 001 when directory is empty", () => {
    const dir = makeProject([], { migrations: [] });
    const result = migrationAlloc(dir);
    assert.equal(result.next, "001");
    rmSync(dir, { recursive: true });
  });

  it("rejects when migration directory missing", () => {
    const dir = makeProject([]);
    const result = migrationAlloc(dir);
    assert.ok(result.error);
    assert.ok(result.error.includes("not found"));
    rmSync(dir, { recursive: true });
  });
});

// ─── Gate detection ──────────────────────────────────────────────────────────
describe("gate detection", () => {
  it("detects typecheck from package.json scripts", () => {
    const dir = makeProject([], { packageJson: { scripts: { typecheck: "tsc" } } });
    const gates = detectGates(dir);
    assert.ok(gates.some((g) => g.name === "typecheck"));
    rmSync(dir, { recursive: true });
  });

  it("detects biome from biome.json", () => {
    const dir = makeProject([], { biome: true });
    const gates = detectGates(dir);
    assert.ok(gates.some((g) => g.name === "biome"));
    rmSync(dir, { recursive: true });
  });

  it("detects vitest from package.json scripts", () => {
    const dir = makeProject([], { packageJson: { scripts: { test: "vitest run" } } });
    const gates = detectGates(dir);
    assert.ok(gates.some((g) => g.name === "vitest"));
    rmSync(dir, { recursive: true });
  });

  it("returns empty when nothing configured", () => {
    const dir = makeProject([]);
    const gates = detectGates(dir);
    assert.equal(gates.length, 0);
    rmSync(dir, { recursive: true });
  });
});

// ─── Attest ──────────────────────────────────────────────────────────────────
describe("attest", () => {
  it("rejects note shorter than 20 chars", () => {
    const dir = makeProject([
      {
        file: "S1.0-test.md",
        content: `---
id: S1.0
status: in-progress
---
# S1.0 test
- 状态：🔄 进行中
`,
      },
    ]);
    const result = cmdAttest(dir, "S1.0", "R1", "short note");
    assert.ok(result.error);
    assert.ok(result.error.includes("≥20"));
    rmSync(dir, { recursive: true });
  });

  it("accepts note ≥20 chars", () => {
    const dir = makeProject([
      {
        file: "S1.0-test.md",
        content: `---
id: S1.0
status: in-progress
---
# S1.0 test
- 状态：🔄 进行中
`,
      },
    ]);
    const result = cmdAttest(dir, "S1.0", "R1", "Checked 50 samples manually and all pass the criteria");
    assert.ok(result.ok);
    rmSync(dir, { recursive: true });
  });
});

// ─── Done gaps ───────────────────────────────────────────────────────────────
describe("done", () => {
  it("lists gaps when impl/audit not run", () => {
    const dir = makeProject([
      {
        file: "S1.0-test.md",
        content: `---
id: S1.0
status: in-progress
---
# S1.0 test
- 状态：🔄 进行中
`,
      },
    ]);
    const result = cmdDone(dir, "S1.0");
    assert.ok(result.error);
    assert.ok(result.error.includes("impl not run"));
    assert.ok(result.error.includes("audit not run"));
    rmSync(dir, { recursive: true });
  });
});

// ─── Board ───────────────────────────────────────────────────────────────────
describe("board", () => {
  it("shows unmanaged specs", () => {
    const dir = makeProject([
      { file: "S1.0-old.md", content: "# S1.0 old\n- 状态：待 review\n" },
    ]);
    const rows = cmdBoard(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "未纳管");
    rmSync(dir, { recursive: true });
  });

  it("shows managed specs with frontmatter status", () => {
    const dir = makeProject([
      {
        file: "S1.0-new.md",
        content: `---
id: S1.0
status: in-progress
---
# S1.0 new
- 状态：🔄 进行中
`,
      },
    ]);
    const rows = cmdBoard(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "进行中");
    assert.equal(rows[0].drift, "✓");
    rmSync(dir, { recursive: true });
  });
});

// ─── Check (CI) ──────────────────────────────────────────────────────────────
describe("check", () => {
  it("detects drift in CI mode", () => {
    const dir = makeProject([
      {
        file: "S1.0-drift.md",
        content: `---
id: S1.0
status: in-progress
---
# S1.0 drift
- 状态：📋 待 review
`,
      },
    ]);
    const result = cmdCheck(dir, { ci: false });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes("DRIFT")));
    rmSync(dir, { recursive: true });
  });

  it("passes when no drift", () => {
    const dir = makeProject([
      {
        file: "S1.0-ok.md",
        content: `---
id: S1.0
status: pending
---
# S1.0 ok
- 状态：📋 待 review
`,
      },
    ]);
    const result = cmdCheck(dir, { ci: false });
    assert.equal(result.ok, true);
    rmSync(dir, { recursive: true });
  });
});
