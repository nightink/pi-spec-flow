// e2e-commit-gate.mjs — S1.1 原案例自动复现
// 会话项目（红门禁）+ 外部 pages 仓库（无门禁）→ 跨仓库 commit 必须放行，
// 且不被会话项目门禁牵连；会话内 commit 仍被红门禁拦截。
// 输出 PASS/FAIL 行（spec-flow parseE2eOutput 约定）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitGateDecision, appendCommitLedger } from "../../core.mjs";

function mkProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-e2e-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

function gitInit(dir) {
  execSync("git init -q && git config user.email e2e@t && git config user.name e2e && git add . && git commit -qm init --allow-empty", {
    cwd: dir,
    stdio: "pipe",
  });
}

let failures = 0;
const check = (cond, label) => {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`);
  }
};

try {
  // 会话项目：typecheck 门禁全红
  const session = mkProject({
    "package.json": JSON.stringify({
      scripts: { typecheck: "node -e \"process.exit(1)\"" },
    }),
  });
  gitInit(session);

  // 外部 pages 仓库：无 package.json、无门禁（GitHub Pages 静态站）
  const pages = mkProject({ "index.html": "<h1>hi</h1>" });
  gitInit(pages);

  // 场景 1：原案例 —— cd 到 pages 提交，不得被会话项目红门禁拦截
  const cmd = `cd ${pages} && git add . && git commit -m e2e && git push`;
  const d1 = await commitGateDecision(session, cmd);
  check(d1.action === "allow" && d1.external === true, "跨仓库 commit 放行（目标仓库无门禁，不被会话项目牵连）");
  check(d1.confidence === "resolved", "目标仓库经 rev-parse 确认");
  check(d1.repo === fs.realpathSync(pages), "裁决仓库为 pages 而非会话项目");

  // 场景 2：台账写目标仓库，含 targetRepo 字段
  const landed = appendCommitLedger(d1, { type: "allow-external", command: cmd.slice(0, 80) }, session);
  check(landed.fallback === false && fs.existsSync(path.join(landed.path, ".spec-flow-ledger.jsonl")), "allow-external 台账落目标仓库");
  const ledger = fs.readFileSync(path.join(pages, ".spec-flow-ledger.jsonl"), "utf8");
  check(ledger.includes('"targetRepo"'), "台账含 targetRepo 字段");
  check(!fs.existsSync(path.join(session, ".spec-flow-ledger.jsonl")), "会话项目无台账残留");

  // 场景 3：会话内直接 commit（无 cd/-C）→ 会话项目红门禁拦截
  const d3 = await commitGateDecision(session, "git commit -m x");
  check(d3.action === "block", "会话内 commit 仍被红门禁拦截");
  check(d3.reason.includes("仓库:"), "block reason 标明仓库");

  fs.rmSync(session, { recursive: true, force: true });
  fs.rmSync(pages, { recursive: true, force: true });
} catch (e) {
  failures++;
  console.log(`FAIL e2e 异常: ${e.message}`);
}

process.exit(failures === 0 ? 0 : 1);
