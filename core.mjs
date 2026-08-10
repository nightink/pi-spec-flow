#!/usr/bin/env node
// spec-flow core.mjs — zero-pi-dependency core logic
// CLI: node core.mjs board|begin <id>|impl <id>|audit <id>|attest <id> <item> <note>|done <id>|migrate-alloc|check --ci

import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileP = promisify(execFile);

// ─── Async subprocess helpers ────────────────────────────────────────────────
// Run a shell command string without blocking the event loop (TUI stays live).
// Resolves { stdout, stderr, code } — never throws on non-zero exit.
// AbortError is re-thrown so callers can propagate cancellation (Esc / abort).
export async function runCmd(
  cmd,
  { cwd, timeout = 180000, maxBuffer = 10 * 1024 * 1024, signal } = {}
) {
  try {
    const { stdout, stderr } = await execFileP(cmd, [], {
      cwd,
      timeout,
      maxBuffer,
      signal,
      shell: true,
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// Run an argv array directly (no shell, no quoting issues). Same contract.
export async function runArgv(
  file,
  args,
  { cwd, timeout = 180000, maxBuffer = 10 * 1024 * 1024, signal, env } = {}
) {
  try {
    const { stdout, stderr } = await execFileP(file, args, {
      cwd,
      timeout,
      maxBuffer,
      signal,
      env,
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// ─── Status mapping ──────────────────────────────────────────────────────────
export const STATUS_MAP = {
  pending: "待 review",
  approved: "已批准",
  "in-progress": "进行中",
  done: "已完成",
};
const REVERSE_STATUS = Object.fromEntries(
  Object.entries(STATUS_MAP).map(([k, v]) => [v, k])
);

// ─── Frontmatter ─────────────────────────────────────────────────────────────
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yamlStr = match[1];
  let data;
  try {
    data = yaml.load(yamlStr);
  } catch {
    return null;
  }
  return { data: data || {}, raw: yamlStr, fullMatch: match[0] };
}

export function writeFrontmatter(content, data) {
  const yamlStr = yaml.dump(data, { lineWidth: -1, quotingType: true }).trimEnd();
  const newBlock = `---\n${yamlStr}\n---`;
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (match) {
    return content.replace(match[0], newBlock);
  }
  return newBlock + "\n\n" + content;
}

// ─── Status line ─────────────────────────────────────────────────────────────
export function extractStatusLine(content) {
  const match = content.match(/^- 状态：(.+)$/m);
  return match ? match[1].trim() : null;
}

export function updateStatusLine(content, status, note) {
  const label = STATUS_MAP[status] || status;
  // If note not provided, preserve existing parenthetical note from current line
  let effectiveNote = note;
  if (effectiveNote === undefined || effectiveNote === null) {
    const existingMatch = content.match(/^- 状态：[^\n]*（([^）]*)）/m);
    if (existingMatch) {
      effectiveNote = existingMatch[1];
    }
  }
  const newLine = effectiveNote ? `- 状态：${label}（${effectiveNote}）` : `- 状态：${label}`;
  const re = /^- 状态：.+$/m;
  if (re.test(content)) {
    return content.replace(re, newLine);
  }
  // Insert after frontmatter
  const fmEnd = content.match(/^---\r?\n[\s\S]*?\r?\n---\n?/);
  if (fmEnd) {
    const after = content.slice(fmEnd[0].length);
    return fmEnd[0] + "\n" + newLine + "\n" + after;
  }
  return newLine + "\n\n" + content;
}

// ─── Drift detection ─────────────────────────────────────────────────────────
export function detectDrift(content, fmData) {
  const bodyStatus = extractStatusLine(content);
  if (!bodyStatus) return { drifted: false, reason: "no-status-line" };
  const expected = STATUS_MAP[fmData.status];
  if (!expected) return { drifted: false, reason: "unknown-fm-status" };
  // Strip parenthetical notes and emoji prefixes for comparison
  const bodyBase = bodyStatus
    .replace(/（[^）]*）/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}✀-➿]/gu, "")
    .trim();
  if (bodyBase === expected) return { drifted: false };
  return { drifted: true, expected, got: bodyBase };
}

// ─── Project config detection ────────────────────────────────────────────────
export function detectProjectConfig(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  const biomePath = path.join(cwd, "biome.json");
  const vitestPatterns = [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.workspace.ts",
    "vitest.workspace.js",
  ];

  const gates = [];
  let hasTypecheck = false;
  let hasVitest = false;

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.scripts?.typecheck) {
      gates.push({ name: "typecheck", cmd: "npm run typecheck" });
      hasTypecheck = true;
    }
    if (
      pkg.scripts?.test &&
      (pkg.scripts.test.includes("vitest") || pkg.scripts.test === "vitest run")
    ) {
      hasVitest = true;
    }
  }
  if (fs.existsSync(biomePath)) {
    gates.push({ name: "biome", cmd: "npx biome check ." });
  }
  if (hasVitest) {
    gates.push({ name: "vitest", cmd: "npx vitest run" });
  }

  // Check vitest config files as fallback
  if (!hasVitest) {
    for (const vf of vitestPatterns) {
      if (fs.existsSync(path.join(cwd, vf))) {
        gates.push({ name: "vitest", cmd: "npx vitest run" });
        break;
      }
    }
  }

  // e2e
  const e2eDir = path.join(cwd, "tests/e2e");
  const e2eFiles = fs.existsSync(e2eDir)
    ? fs
        .readdirSync(e2eDir)
        .filter((f) => /^e2e-.*\.mjs$/.test(f))
        .sort()
    : [];

  // migrations
  const migDir = path.join(cwd, "packages/db/src/migrations");
  const migFiles = fs.existsSync(migDir)
    ? fs
        .readdirSync(migDir)
        .filter((f) => /^\d+.*\.ts$/.test(f))
        .sort()
    : [];

  return { gates, e2eFiles, e2eDir, migDir, migFiles, hasTypecheck, hasVitest };
}

// ─── Spec discovery ──────────────────────────────────────────────────────────
export function loadSpecs(cwd) {
  const specsDir = path.join(cwd, "docs/specs");
  if (!fs.existsSync(specsDir)) return [];
  const files = fs.readdirSync(specsDir).filter((f) => f.endsWith(".md")).sort();
  return files.map((f) => {
    const fullPath = path.join(specsDir, f);
    const content = fs.readFileSync(fullPath, "utf8");
    const fm = parseFrontmatter(content);
    return {
      file: f,
      path: fullPath,
      content,
      frontmatter: fm?.data || null,
      hasFrontmatter: !!fm,
    };
  });
}

export function findSpec(cwd, id) {
  const specs = loadSpecs(cwd);
  return specs.find(
    (s) =>
      s.frontmatter?.id === id ||
      s.file === id ||
      s.file === `${id}.md` ||
      s.file.startsWith(id + "-") ||
      s.file.startsWith(id + "_")
  );
}

// ─── Git helpers ─────────────────────────────────────────────────────────────
export async function getHeadSha(cwd, signal) {
  try {
    const { stdout, code } = await runCmd("git rev-parse HEAD", {
      cwd,
      timeout: 10000,
      signal,
    });
    if (code !== 0) return "unknown";
    return stdout.trim() || "unknown";
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return "unknown";
  }
}

async function getDiff(repo, baseSha, headSha = "HEAD", scope, signal) {
  try {
    let cmd = `git diff ${baseSha}...${headSha}`;
    if (scope) {
      cmd += ` -- ${scope}`;
    }
    const { stdout } = await runCmd(cmd, {
      cwd: repo,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    return stdout;
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return "(diff unavailable)";
  }
}

// ─── Gate execution with cache ───────────────────────────────────────────────
function treeHash(cwd) {
  try {
    const head = execSync("git rev-parse HEAD", { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();
    return crypto.createHash("md5").update(head + "|" + dirty).digest("hex").slice(0, 12);
  } catch {
    return null; // 非 git 仓：指纹不可用
  }
}

export async function runGates(cwd, gates, { signal, onGate } = {}) {
  const cacheKey = crypto.createHash("md5").update(cwd).digest("hex");
  const cachePath = `<tmp>/specflow-gates-${cacheKey}.json`;
  const tree = treeHash(cwd);

  // Check cache (TTL 5min) — 且工作树指纹一致（多会话并发/修复后不再误用旧结果）
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (Date.now() - cached.ts < 5 * 60 * 1000 && (tree === null || cached.tree === tree)) {
        return cached.result;
      }
    } catch {
      // ignore corrupt cache
    }
  }

  const results = {};
  for (const gate of gates) {
    if (onGate) onGate(gate.name);
    const { stdout, stderr, code } = await runCmd(gate.cmd, {
      cwd,
      timeout: 180000,
      signal,
    });
    if (code === 0) {
      const lines = stdout.split("\n").filter(Boolean);
      results[gate.name] = { pass: true, tail: lines.slice(-3).join("\n") };
    } else {
      const output = stdout + "\n" + stderr;
      const tail = output
        .split("\n")
        .filter(Boolean)
        .slice(-10)
        .join("\n");
      results[gate.name] = { pass: false, tail };
    }
  }

  const cacheData = { ts: Date.now(), tree, result: results };
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));
  } catch {
    // cache write failure is non-fatal
  }
  return results;
}

// ─── E2E output parsing ─────────────────────────────────────────────────────
// Count ^PASS and ^FAIL lines. Pass iff PASS>0 AND FAIL==0.
export function parseE2eOutput(output) {
  const passCount = (output.match(/^PASS /gm) || []).length;
  const failCount = (output.match(/^FAIL /gm) || []).length;
  return { pass: passCount > 0 && failCount === 0, passCount, failCount };
}

// ─── Bypass detection ────────────────────────────────────────────────────────
// Only match SPECFLOW_BYPASS=1 as a prefix env assignment to git commit,
// not as a substring in commit messages or other arguments.
export function shouldBypass(command) {
  // Match SPECFLOW_BYPASS=1 as env prefix: at start of command or after ;/&/|,
  // followed by whitespace and then git commit somewhere after
  const re = /(?:^|[;&|]\s*)SPECFLOW_BYPASS=1\s+(?:.*\s)?git\s+commit/;
  return re.test(command);
}

// ─── Commit gate action (pure) ──────────────────────────────────────────────
// Pure function: decide whether to allow, block, or bypass a git commit.
// Returns { action: "allow" | "block" | "bypass", reason?: string }
const COMMIT_RE = /(^|[;&|]\s*)(?:\S+=\S+\s+)*git\s+commit/;

export function commitGateAction(command, gateResults) {
  // 1. Not a commit command → allow
  if (!COMMIT_RE.test(command)) {
    return { action: "allow" };
  }

  // 2. Bypass env prefix → bypass (even if gates fail)
  if (shouldBypass(command)) {
    return { action: "bypass" };
  }

  // 3. All gates pass (or no gates) → allow
  const results = Object.values(gateResults);
  if (results.every((r) => r.pass)) {
    return { action: "allow" };
  }

  // 4. Block — reason includes failed gate names + tail summaries
  const failedGates = Object.entries(gateResults)
    .filter(([_, v]) => !v.pass)
    .map(([name, v]) => `${name}:\n${v.tail}`);

  return {
    action: "block",
    reason: `spec-flow: 门禁未通过，禁止 commit\n\n${failedGates.join("\n\n")}`,
  };
}

// ─── Ledger ──────────────────────────────────────────────────────────────────
export function appendLedger(cwd, event) {
  const ledgerPath = path.join(cwd, ".spec-flow-ledger.jsonl");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  fs.appendFileSync(ledgerPath, line);
}

// ─── migrate-alloc ───────────────────────────────────────────────────────────
export function migrateAlloc(cwd) {
  const config = detectProjectConfig(cwd);
  if (config.migFiles.length === 0) {
    throw new Error(
      "No migration directory found at packages/db/src/migrations/ (or empty)"
    );
  }
  const last = config.migFiles[config.migFiles.length - 1];
  const num = parseInt(last.match(/^(\d+)/)[1], 10);
  return String(num + 1).padStart(3, "0");
}

// ─── board ───────────────────────────────────────────────────────────────────
export function board(cwd) {
  const specs = loadSpecs(cwd);
  if (specs.length === 0) return "(no specs found in docs/specs/)";
  const lines = [];
  for (const spec of specs) {
    if (!spec.hasFrontmatter) {
      lines.push(`${spec.file}: 未纳管（无 frontmatter）`);
      continue;
    }
    const fm = spec.frontmatter;
    const status = STATUS_MAP[fm.status] || fm.status || "(no status)";
    const drift = detectDrift(spec.content, fm);
    const driftMark = drift.drifted ? " ⚠️ 漂移" : "";
    const id = fm.id || "?";
    lines.push(`${id} [${spec.file}]: ${status}${driftMark}`);
  }
  return lines.join("\n");
}

// ─── begin ───────────────────────────────────────────────────────────────────
export async function begin(cwd, id, { signal } = {}) {
  const spec = findSpec(cwd, id);
  if (!spec) throw new Error(`Spec ${id} not found`);
  if (!spec.hasFrontmatter) throw new Error(`Spec ${id} has no frontmatter (unmanaged)`);

  const fm = spec.frontmatter;
  if (fm.review?.decision !== "approved") {
    throw new Error(
      `Spec ${id} not approved yet (review.decision=${fm.review?.decision || "null"}, need "approved")`
    );
  }

  // Check deps
  if (Array.isArray(fm.deps) && fm.deps.length > 0) {
    const allSpecs = loadSpecs(cwd);
    for (const dep of fm.deps) {
      const depSpec = allSpecs.find((s) => s.frontmatter?.id === dep);
      if (!depSpec) throw new Error(`Dependency ${dep} not found`);
      if (depSpec.frontmatter?.status !== "done") {
        throw new Error(
          `Dependency ${dep} not done (status=${depSpec.frontmatter?.status})`
        );
      }
    }
  }

  const baseSha = await getHeadSha(cwd, signal);
  fm.status = "in-progress";
  fm.impl = fm.impl || {};
  fm.impl.base_sha = baseSha;
  fm.impl.at = null;
  fm.impl.gates = null;
  fm.impl.e2e = null;

  let newContent = writeFrontmatter(spec.content, fm);
  newContent = updateStatusLine(newContent, "in-progress");
  fs.writeFileSync(spec.path, newContent);

  appendLedger(cwd, { type: "begin", spec: id, base_sha: baseSha });

  const branch = id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `Spec ${id} → 进行中\n  base_sha: ${baseSha}\n  建议分支: ${branch}/spec-flow\n  前置校验: review=approved ✓`;
}

// ─── impl ────────────────────────────────────────────────────────────────────
export async function impl(cwd, id, { signal, onGate } = {}) {
  const spec = findSpec(cwd, id);
  if (!spec) throw new Error(`Spec ${id} not found`);
  if (!spec.hasFrontmatter) throw new Error(`Spec ${id} has no frontmatter`);

  const fm = spec.frontmatter;
  if (fm.status !== "in-progress") {
    throw new Error(`Spec ${id} not in-progress (status=${fm.status})`);
  }

  const config = detectProjectConfig(cwd);

  // Run gates
  const gateResults = await runGates(cwd, config.gates, { signal, onGate });
  const allGatesPass = Object.values(gateResults).every((r) => r.pass);

  // Run e2e
  const e2eResults = {};
  const evidenceE2e = fm.evidence?.e2e || [];
  if (evidenceE2e.length > 0 && config.e2eFiles.length > 0) {
    for (const e2eId of evidenceE2e) {
      const fileName = e2eId.endsWith(".mjs") ? e2eId : `${e2eId}.mjs`;
      const filePath = path.join(config.e2eDir, fileName);
      if (!fs.existsSync(filePath)) {
        e2eResults[e2eId] = { pass: false, tail: `File not found: ${fileName}` };
        continue;
      }
      // Run via argv (no shell) — safe for paths with spaces
      const { stdout, stderr, code } = await runArgv("node", [filePath], {
        cwd,
        timeout: 180000,
        signal,
      });
      if (code === 0) {
        const parsed = parseE2eOutput(stdout);
        e2eResults[e2eId] = {
          pass: parsed.pass,
          passCount: parsed.passCount,
          failCount: parsed.failCount,
          tail: stdout.split("\n").slice(-5).join("\n"),
        };
      } else {
        const output = stdout + "\n" + stderr;
        e2eResults[e2eId] = {
          pass: false,
          tail: output.split("\n").slice(-5).join("\n"),
        };
      }
    }
  }

  // Check migrations
  const evidenceMig = fm.evidence?.migrations || [];
  const migConflicts = [];
  for (const migNum of evidenceMig) {
    const padded = String(migNum).padStart(3, "0");
    const existing = config.migFiles.find((f) => f.startsWith(padded));
    if (existing) {
      // Check if this spec owns it (via other specs' frontmatter)
      const allSpecs = loadSpecs(cwd);
      const owner = allSpecs.find(
        (s) =>
          s.frontmatter?.id !== id &&
          Array.isArray(s.frontmatter?.evidence?.migrations) &&
          s.frontmatter.evidence.migrations.includes(migNum)
      );
      if (owner) {
        migConflicts.push({ num: migNum, conflictWith: owner.frontmatter.id });
      }
    }
  }

  // Write results
  fm.impl = fm.impl || {};
  fm.impl.at = new Date().toISOString();
  fm.impl.gates = gateResults;
  fm.impl.e2e = e2eResults;

  let newContent = writeFrontmatter(spec.content, fm);
  fs.writeFileSync(spec.path, newContent);

  const allE2ePass = Object.values(e2eResults).every((r) => r.pass);
  const noMigConflicts = migConflicts.length === 0;
  const implPass = allGatesPass && allE2ePass && noMigConflicts;

  appendLedger(cwd, {
    type: "impl",
    spec: id,
    pass: implPass,
    gates: gateResults,
    e2e: e2eResults,
  });

  const summary = [
    `Spec ${id} impl 结果: ${implPass ? "✅ PASS" : "❌ FAIL"}`,
    `  门禁:`,
    ...Object.entries(gateResults).map(
      ([k, v]) => `    ${k}: ${v.pass ? "✓" : "✗"}`
    ),
  ];
  if (Object.keys(e2eResults).length > 0) {
    summary.push(`  E2E:`);
    for (const [k, v] of Object.entries(e2eResults)) {
      const countStr = v.passCount != null ? ` (${v.passCount} PASS)` : "";
      summary.push(`    ${k}: ${v.pass ? "✓" : "✗"}${countStr}`);
      if (!v.pass && v.tail) summary.push(`      ${v.tail.split("\n")[0]}`);
    }
  }
  if (migConflicts.length > 0) {
    summary.push(`  迁移冲突:`);
    for (const c of migConflicts) {
      summary.push(`    ${c.num}: 与 ${c.conflictWith} 冲突`);
    }
  }

  return summary.join("\n");
}

// ─── buildAuditorArgs ────────────────────────────────────────────────────────
// Returns argv array for pi subprocess — no shell, zero expansion.
export function buildAuditorArgs(prompt, model = "") {
  const args = ["-p", "--no-extensions", "--no-skills", "--no-context-files"];
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
}

// ─── parseVerdictJson ────────────────────────────────────────────────────────
// Parse auditor JSON output with backslash repair for invalid escapes.
// LLM auditors sometimes emit regex like \s or \. inside evidence strings;
// single backslash + non-escape char is not valid JSON.
export function parseVerdictJson(raw) {
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return {
      verdict: "fail",
      criteria: [
        {
          criterion: "审计 JSON 解析",
          status: "unverifiable",
          evidence: `审计输出中未找到 JSON 对象。原始输出片段: ${raw.slice(0, 500)}`,
        },
      ],
      scope_deviations: [],
    };
  }
  const jsonStr = raw.slice(firstBrace, lastBrace + 1);

  // Attempt 1: direct parse
  try {
    return JSON.parse(jsonStr);
  } catch {
    // fall through to repair
  }

  // Attempt 2: repair lone backslashes that aren't valid JSON escapes
  // Valid JSON escapes after \: " \ / b f n r t u (plus uXXXX)
  const repaired = jsonStr.replace(
    /\\(?!["\\/bfnrtu]|u[0-9a-fA-F]{4})/g,
    "\\\\"
  );
  try {
    return JSON.parse(repaired);
  } catch (e2) {
    // Attempt 3: fallback — verdict=fail with raw snippet as evidence
    return {
      verdict: "fail",
      criteria: [
        {
          criterion: "审计 JSON 解析",
          status: "unverifiable",
          evidence: `JSON 解析失败（修复后仍报错: ${e2.message}）。原始输出片段: ${jsonStr.slice(0, 500)}`,
        },
      ],
      scope_deviations: [],
    };
  }
}

// ─── audit ───────────────────────────────────────────────────────────────────
export async function audit(cwd, id, { signal } = {}) {
  const spec = findSpec(cwd, id);
  if (!spec) throw new Error(`Spec ${id} not found`);
  if (!spec.hasFrontmatter) throw new Error(`Spec ${id} has no frontmatter`);

  const fm = spec.frontmatter;
  if (fm.status !== "in-progress") {
    throw new Error(`Spec ${id} not in-progress (status=${fm.status})`);
  }

  const baseSha = fm.impl?.base_sha;
  if (!baseSha) {
    throw new Error(`Spec ${id} has no impl.base_sha (run spec_begin first)`);
  }

  const repo = fm.impl?.repo || cwd;
  const scope = fm.scope || null;
  const diff = await getDiff(repo, baseSha, "HEAD", scope, signal);
  const currentSha = await getHeadSha(repo, signal);

  // Build auditor prompt
  const auditorModel = process.env.SPECFLOW_AUDIT_MODEL || "";

  const prompt = `你是一个独立的 spec 审计员。你的任务是对比 spec 方案与实施 diff，逐条判定验收标准是否满足。

## Spec 原文
${spec.content}

## 实施 Diff (base ${baseSha}...HEAD)
${diff.slice(0, 100000)}

## 最近 impl 输出
gates: ${JSON.stringify(fm.impl?.gates || {}, null, 2)}
e2e: ${JSON.stringify(fm.impl?.e2e || {}, null, 2)}

## 输出要求
只输出一个 JSON 对象，不要输出其他内容。输出必须是严格合法 JSON：字符串值中的反斜杠一律写成 \\\\（双反斜杠），代码/正则引用同样遵守。schema：
{
  "verdict": "pass" | "fail",
  "criteria": [
    {
      "criterion": "验收标准描述",
      "status": "pass" | "fail" | "unverifiable",
      "evidence": "引用 diff hunk 或说明"
    }
  ],
  "scope_deviations": ["方案中声明但 diff 未覆盖的内容，或 diff 超出 spec 范围的内容"]
}

规则：
- 任何 criterion 的 status 为 fail 或 unverifiable → verdict=fail
- evidence 必须引用具体 diff hunk（行号或代码片段）
- 不要编造 diff 中不存在的内容
- scope_deviations 列出方案声明但未实现的部分`;

  let auditResult;
  try {
    const args = buildAuditorArgs(prompt, auditorModel);
    // Override for hermetic tests / custom auditor CLIs (default: pi)
    const auditorBin = process.env.SPECFLOW_AUDIT_BIN || "pi";
    const { stdout, stderr, code } = await runArgv(auditorBin, args, {
      cwd,
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
      signal,
    });
    if (code !== 0) {
      throw new Error(
        `pi 子进程退出 code=${code}: ${(stderr || "").slice(0, 500)}`
      );
    }
    auditResult = parseVerdictJson(stdout);
  } catch (e) {
    if (e?.name === "AbortError") throw e; // cancellation: don't write fake fail
    auditResult = {
      verdict: "fail",
      criteria: [
        {
          criterion: "审计执行",
          status: "unverifiable",
          evidence: `审计子进程失败: ${e.message}`,
        },
      ],
      scope_deviations: [],
    };
  }

  // Write results
  fm.audit = {
    at: new Date().toISOString(),
    sha: currentSha,
    verdict: auditResult.verdict,
    criteria: auditResult.criteria || [],
  };

  let newContent = writeFrontmatter(spec.content, fm);
  fs.writeFileSync(spec.path, newContent);

  appendLedger(cwd, {
    type: "audit",
    spec: id,
    verdict: auditResult.verdict,
    sha: currentSha,
  });

  const summary = [
    `Spec ${id} 审计结果: ${auditResult.verdict === "pass" ? "✅ PASS" : "❌ FAIL"}`,
    `  sha: ${currentSha}`,
    `  criteria:`,
  ];
  for (const f of auditResult.criteria || []) {
    const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
    summary.push(`    [${mark}] ${f.criterion}`);
    if (f.evidence) summary.push(`      ${f.evidence.slice(0, 200)}`);
  }
  if (auditResult.scope_deviations?.length > 0) {
    summary.push(`  范围偏差:`);
    for (const d of auditResult.scope_deviations) {
      summary.push(`    - ${d}`);
    }
  }

  return summary.join("\n");
}

// ─── attest ──────────────────────────────────────────────────────────────────
export function attest(cwd, id, item, note) {
  if (!note || note.length < 20) {
    throw new Error(
      `Attest note too short (${note?.length || 0} chars, need ≥20). Must describe verification path and sample.`
    );
  }

  const spec = findSpec(cwd, id);
  if (!spec) throw new Error(`Spec ${id} not found`);
  if (!spec.hasFrontmatter) throw new Error(`Spec ${id} has no frontmatter`);

  const fm = spec.frontmatter;
  const humanItems = fm.evidence?.human || [];
  if (!humanItems.includes(item)) {
    throw new Error(
      `Item "${item}" not in evidence.human (available: ${humanItems.join(", ") || "none"})`
    );
  }

  fm.attestations = fm.attestations || {};
  fm.attestations[item] = {
    at: new Date().toISOString(),
    note,
  };

  let newContent = writeFrontmatter(spec.content, fm);
  fs.writeFileSync(spec.path, newContent);

  appendLedger(cwd, { type: "attest", spec: id, item, note });

  return `Spec ${id}: 人工核验 "${item}" 已登记\n  note: ${note}`;
}

// ─── done ────────────────────────────────────────────────────────────────────
export async function done(cwd, id, { signal } = {}) {
  const spec = findSpec(cwd, id);
  if (!spec) throw new Error(`Spec ${id} not found`);
  if (!spec.hasFrontmatter) throw new Error(`Spec ${id} has no frontmatter`);

  const fm = spec.frontmatter;
  if (fm.status !== "in-progress") {
    throw new Error(`Spec ${id} not in-progress (status=${fm.status})`);
  }

  const gaps = [];

  // Check impl pass
  if (!fm.impl?.at) {
    gaps.push("impl 未执行（无 impl.at）");
  } else {
    const gates = fm.impl.gates || {};
    const failedGates = Object.entries(gates)
      .filter(([_, v]) => !v.pass)
      .map(([k]) => k);
    if (failedGates.length > 0) gaps.push(`门禁未全绿: ${failedGates.join(", ")}`);

    const e2e = fm.impl.e2e || {};
    const failedE2e = Object.entries(e2e)
      .filter(([_, v]) => !v.pass)
      .map(([k]) => k);
    if (failedE2e.length > 0) gaps.push(`e2e 未通过: ${failedE2e.join(", ")}`);
  }

  // Check audit pass + sha fresh
  if (!fm.audit?.verdict) {
    gaps.push("audit 未执行");
  } else if (fm.audit.verdict !== "pass") {
    gaps.push(`audit verdict=${fm.audit.verdict} (need pass)`);
  } else {
    // Compare against the same repo audit() used (impl.repo if set, else cwd)
    const auditRepo = fm.impl?.repo || cwd;
    const currentSha = await getHeadSha(auditRepo, signal);
    if (fm.audit.sha !== currentSha) {
      gaps.push(
        `audit sha 过期 (audit.sha=${fm.audit.sha?.slice(0, 8)}, HEAD=${currentSha.slice(0, 8)})`
      );
    }
  }

  // Check human attestations
  const humanItems = fm.evidence?.human || [];
  const attestations = fm.attestations || {};
  const unattested = humanItems.filter((item) => !attestations[item]);
  if (unattested.length > 0) {
    gaps.push(`人工核验未完成: ${unattested.join(", ")}`);
  }

  if (gaps.length > 0) {
    throw new Error(`Spec ${id} 未完成，缺口：\n  ${gaps.join("\n  ")}`);
  }

  fm.status = "done";
  let newContent = writeFrontmatter(spec.content, fm);
  newContent = updateStatusLine(newContent, "done");
  fs.writeFileSync(spec.path, newContent);

  // Build impl summary for ledger
  const gatesSummary = {};
  const gates = fm.impl?.gates || {};
  for (const [name, result] of Object.entries(gates)) {
    gatesSummary[name] = result.pass ? "pass" : "fail";
  }
  const e2eSummary = {};
  const e2e = fm.impl?.e2e || {};
  for (const [name, result] of Object.entries(e2e)) {
    e2eSummary[name] = {
      pass: result.pass ? "PASS" : "FAIL",
      passCount: result.passCount ?? 0,
      failCount: result.failCount ?? 0,
    };
  }

  appendLedger(cwd, {
    type: "done",
    spec: id,
    impl_summary: {
      gates: gatesSummary,
      e2e: e2eSummary,
    },
    audit: {
      verdict: fm.audit?.verdict,
      sha: fm.audit?.sha?.slice(0, 8),
    },
  });

  return `Spec ${id} → 已完成 ✅\n  impl: ✓ | audit: ✓ | human: ✓`;
}

// ─── check --ci ──────────────────────────────────────────────────────────────
export async function checkCI(cwd) {
  const specs = loadSpecs(cwd);
  const config = detectProjectConfig(cwd);
  const errors = [];
  const warnings = [];

  for (const spec of specs) {
    if (!spec.hasFrontmatter) continue;
    const fm = spec.frontmatter;
    const id = fm.id || spec.file;

    // Frontmatter ↔ body consistency
    const drift = detectDrift(spec.content, fm);
    if (drift.drifted) {
      errors.push(`${id}: 状态漂移 (frontmatter=${drift.expected}, body=${drift.got})`);
    }

    // Evidence file existence
    const evidenceE2e = fm.evidence?.e2e || [];
    for (const e2eId of evidenceE2e) {
      const fileName = e2eId.endsWith(".mjs") ? e2eId : `${e2eId}.mjs`;
      const filePath = path.join(config.e2eDir, fileName);
      if (!fs.existsSync(filePath)) {
        errors.push(`${id}: evidence.e2e 声明的文件不存在: ${fileName}`);
      }
    }

    // Evidence e2e coverage: check that declared e2e files match glob pattern
    // (the file must be in tests/e2e/e2e-*.mjs)
    for (const e2eId of evidenceE2e) {
      const fileName = e2eId.endsWith(".mjs") ? e2eId : `${e2eId}.mjs`;
      if (!/^e2e-.*\.mjs$/.test(fileName)) {
        errors.push(`${id}: evidence.e2e 文件不符合 e2e-*.mjs 模式: ${fileName}`);
      }
    }

    // Migration number conflicts
    const evidenceMig = fm.evidence?.migrations || [];
    for (const migNum of evidenceMig) {
      const padded = String(migNum).padStart(3, "0");
      const existing = config.migFiles.find((f) => f.startsWith(padded));
      if (existing) {
        // Check if another spec claims this migration
        const owner = specs.find(
          (s) =>
            s.frontmatter?.id !== id &&
            Array.isArray(s.frontmatter?.evidence?.migrations) &&
            s.frontmatter.evidence.migrations.includes(migNum)
        );
        if (owner) {
          errors.push(
            `${id}: 迁移号 ${padded} 与 ${owner.frontmatter.id} 冲突`
          );
        }
      }
    }
  }

  // Run gates
  if (config.gates.length > 0) {
    const gateResults = await runGates(cwd, config.gates);
    for (const [name, result] of Object.entries(gateResults)) {
      if (!result.pass) {
        errors.push(`门禁 ${name} 未通过`);
      }
    }
  } else {
    warnings.push("未探测到门禁（无 typecheck/biome/vitest 配置）");
  }

  const lines = [];
  if (errors.length > 0) {
    lines.push(`❌ check --ci 失败 (${errors.length} 个错误):`);
    for (const e of errors) lines.push(`  ✗ ${e}`);
  }
  if (warnings.length > 0) {
    lines.push(`⚠️ 警告:`);
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  if (errors.length === 0) {
    lines.push(`✅ check --ci 通过`);
  }

  return { output: lines.join("\n"), pass: errors.length === 0 };
}

// ─── nextStep: suggest next action for an in-progress spec ──────────────────
export async function nextStep(cwd, spec, signal) {
  const fm = spec.frontmatter;
  const id = fm.id || spec.file;
  // 1. impl not run yet
  if (!fm.impl?.at) {
    return `下一步：spec_impl ${id}`;
  }

  // Check impl pass: all gates green + all e2e green
  const gates = fm.impl.gates || {};
  const e2e = fm.impl.e2e || {};
  const allGatesPass = Object.values(gates).every((r) => r.pass);
  const allE2ePass = Object.values(e2e).every((r) => r.pass);
  const implPass = allGatesPass && allE2ePass;

  // 2. impl has failures → fix and rerun impl
  if (!implPass) {
    return `下一步：修复 impl 问题后重跑 spec_impl ${id}`;
  }

  // 3. impl pass, audit not run yet
  if (!fm.audit?.verdict) {
    return `下一步：spec_audit ${id}`;
  }

  // 4. audit verdict = fail
  if (fm.audit.verdict === "fail") {
    return `下一步：修复审计 findings 后重跑 spec_audit ${id}`;
  }

  // 5. audit pass but sha stale
  const auditRepo = fm.impl?.repo || cwd;
  const currentSha = await getHeadSha(auditRepo, signal);
  if (fm.audit.sha !== currentSha) {
    return `下一步：重跑 spec_audit ${id}（sha 失配）`;
  }

  // 6. all green
  return `下一步：spec_done ${id}`;
}

// ─── renderBoard: full project board (for /spec command) ────────────────────
// Returns "" when the project has no docs/specs/ dir.
export async function renderBoard(cwd, signal) {
  const specs = loadSpecs(cwd);
  if (specs.length === 0) return "";

  const config = detectProjectConfig(cwd);
  const gateNames = config.gates.map((g) => g.name).join(", ");
  const lines = [`📋 spec-flow board — ${specs.length} 个 spec`];
  lines.push(
    `门禁: ${gateNames || "无"} | e2e: ${config.e2eFiles.length} | 迁移: ${config.migFiles.length}`
  );
  lines.push("");

  for (const spec of specs) {
    if (!spec.hasFrontmatter) {
      lines.push(`• ${spec.file} ⚠️ 未纳管（无 frontmatter）`);
      continue;
    }
    const fm = spec.frontmatter;
    const id = fm.id || spec.file;
    const label = STATUS_MAP[fm.status] || fm.status || "?";
    const drift = detectDrift(spec.content, fm);
    const driftMark = drift.drifted ? " ⚠️漂移" : "";
    lines.push(`• ${id} [${spec.file}] ${label}${driftMark}`);

    if (fm.status === "in-progress") {
      const parts = [];
      if (fm.impl?.at) {
        const gatesOk = Object.values(fm.impl?.gates || {}).every((r) => r.pass);
        const e2eOk = Object.values(fm.impl?.e2e || {}).every((r) => r.pass);
        parts.push(`impl ${gatesOk && e2eOk ? "✓" : "✗"} ${fm.impl.at.slice(0, 10)}`);
      }
      if (fm.audit?.verdict) {
        parts.push(`audit ${fm.audit.verdict === "pass" ? "✓" : "✗"}`);
      }
      const human = fm.evidence?.human || [];
      if (human.length > 0) {
        const attested = human.filter((i) => fm.attestations?.[i]).length;
        parts.push(`attest ${attested}/${human.length}`);
      }
      if (parts.length > 0) lines.push(`    ${parts.join(" | ")}`);
      lines.push(`    ${await nextStep(cwd, spec, signal)}`);
    }
  }

  return lines.join("\n");
}

// ─── renderSpecDetail: single spec detail (for /spec <id> command) ──────────
// Returns null when the spec id/file is not found.
export async function renderSpecDetail(cwd, id, signal) {
  const spec = findSpec(cwd, id);
  if (!spec) return null;
  if (!spec.hasFrontmatter) {
    return `${spec.file}: 未纳管（无 frontmatter）`;
  }

  const fm = spec.frontmatter;
  const lines = [
    `📋 ${fm.id || spec.file} [${spec.file}] ${
      STATUS_MAP[fm.status] || fm.status || "?"
    }`,
  ];
  if (fm.review?.decision) lines.push(`review: ${fm.review.decision}`);
  if (fm.deps?.length) lines.push(`deps: ${fm.deps.join(", ")}`);
  if (fm.impl?.base_sha) lines.push(`base_sha: ${fm.impl.base_sha.slice(0, 12)}`);
  if (fm.impl?.at) {
    const gates = Object.entries(fm.impl.gates || {})
      .map(([k, v]) => `${k}${v.pass ? "✓" : "✗"}`)
      .join(" ");
    const e2e = Object.entries(fm.impl.e2e || {})
      .map(([k, v]) => `${k}${v.pass ? "✓" : "✗"}`)
      .join(" ");
    lines.push(`impl: ${fm.impl.at.slice(0, 16)}`);
    if (gates) lines.push(`  gates: ${gates}`);
    if (e2e) lines.push(`  e2e: ${e2e}`);
  }
  if (fm.audit?.verdict) {
    lines.push(`audit: ${fm.audit.verdict} @${fm.audit.sha?.slice(0, 8)}`);
  }
  const human = fm.evidence?.human || [];
  if (human.length > 0) {
    const marks = human.map((i) => `${i} ${fm.attestations?.[i] ? "✓" : "—"}`);
    lines.push(`attest: ${marks.join(" ")}`);
  }
  if (fm.evidence?.e2e?.length) {
    lines.push(`evidence.e2e: ${fm.evidence.e2e.join(", ")}`);
  }
  if (fm.evidence?.migrations?.length) {
    const migs = fm.evidence.migrations
      .map((m) => String(m).padStart(3, "0"))
      .join(", ");
    lines.push(`evidence.migrations: ${migs}`);
  }
  if (fm.status === "in-progress") {
    lines.push(await nextStep(cwd, spec, signal));
  }

  return lines.join("\n");
}

// ─── CLI entry ───────────────────────────────────────────────────────────────
async function main() {
  const cwd = process.cwd();
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd) {
    console.log(
      "Usage: node core.mjs board|begin <id>|impl <id>|audit <id>|attest <id> <item> <note>|done <id>|migrate-alloc|check --ci"
    );
    process.exit(1);
  }

  try {
    switch (cmd) {
      case "board":
        console.log(board(cwd));
        break;
      case "begin":
        if (!args[0]) throw new Error("begin requires <id>");
        console.log(await begin(cwd, args[0]));
        break;
      case "impl":
        if (!args[0]) throw new Error("impl requires <id>");
        console.log(await impl(cwd, args[0]));
        break;
      case "audit":
        if (!args[0]) throw new Error("audit requires <id>");
        console.log(await audit(cwd, args[0]));
        break;
      case "attest":
        if (!args[0] || !args[1] || !args[2])
          throw new Error("attest requires <id> <item> <note>");
        console.log(attest(cwd, args[0], args[1], args.slice(2).join(" ")));
        break;
      case "done":
        if (!args[0]) throw new Error("done requires <id>");
        console.log(await done(cwd, args[0]));
        break;
      case "migrate-alloc":
        console.log(migrateAlloc(cwd));
        break;
      case "check":
        if (args.includes("--ci")) {
          const result = await checkCI(cwd);
          console.log(result.output);
          process.exit(result.pass ? 0 : 1);
        } else {
          throw new Error("check requires --ci flag");
        }
        break;
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
