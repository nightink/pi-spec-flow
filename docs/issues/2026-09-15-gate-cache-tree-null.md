# Bug: `treeHash()` 返回 null 时，门禁缓存退化为「TTL 内无条件命中」

| 项 | 值 |
|---|---|
| 报告日期 | 2026-09-15 |
| 组件 | `core.mjs` · `treeHash()` / `runGates()` |
| 严重度 | 中 —— 会产出**假红**（修好仍被旧失败拦住）与**假绿**（重放旧的通过结果） |
| 关联提交 | `0b5a2ad` fix(gates): content-aware tree hash so fixed files bust the cache（只覆盖了一半） |
| 现场仓库 | `<home>/.pi/agent/extensions/example-app` |

## 现象（实测）

1. 连续两次 `git commit` 被 gate 拦下，报**同一条** typecheck 错误：
   `runtime-supervisor.test.ts(750,12): error TS18048 / TS18046`；
2. 而同期在仓库里手工执行 `npm run typecheck` → **通过**（工作区已修好该类型错）；
3. `rm <tmp>/specflow-gates-<md5(cwd)>.json` 后立刻重试 → **通过**；
4. 现场证据：缓存文件里 `tree` 字段为 `null`

```json
{"ts":1757… ,"tree":null,"result":{"typecheck":{"pass":true},"vitest":{"pass":true}}}
```

## 复现步骤

```bash
# 1) 在任一 git 仓库制造一次 gate 失败（例：测试文件留一个 TS 类型错）
# 2) 触发 gate（gate 会写入 { ts, tree: null, result: { typecheck: false } }）
git commit -m "…"
# 3) 修好代码（工作区 npm run typecheck 通过）后，5 分钟内再次提交
git commit -m "…"          # ← 仍报第 2 步的旧错误
# 4) 清缓存后重试 → 通过
rm <tmp>/specflow-gates-$(md5 -q -s "$PWD").json 2>/dev/null || rm <tmp>/specflow-gates-*.json
```

## 根因（两层）

**第一层：缓存守卫把「指纹不可用」当成「命中任何缓存」**

```js
const tree = treeHash(cwd);
if (fs.existsSync(cachePath)) {
  const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  if (Date.now() - cached.ts < 5 * 60 * 1000 && (tree === null || cached.tree === tree)) {
    return cached.result;      // ← tree === null 时无条件返回旧结果
  }
}
```

`tree === null` 的语义应该是「无法判定是否同一棵树 → **不敢用缓存**」，而不是「随便用」。

**第二层：`treeHash()` 在本环境恒返回 null（静默）**

```js
function treeHash(cwd) {
  try {
    const head = execSync("git rev-parse HEAD", { cwd, stdio: ["pipe","pipe","pipe"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { cwd, … }).toString();
    …
  } catch {
    return null;               // ← 静默吞掉，外部无从得知为什么
  }
}
```

实测：**同一组命令**在终端里手工执行全部成功（`rev-parse HEAD ok` / `status ok` / `diff HEAD ok`），
但在扩展运行时里 `tree` 落地为 `null` —— 即扩展进程的 env/cwd 与终端不同（PATH、`GIT_*`、cwd 之一），
异常被 `catch` 吞掉，于是 `0b5a2ad` 那套「内容感知 diff 指纹」在本仓库**完全没生效**。

## 影响

- **假红**：修好之后仍被旧失败拦住 → 阻塞提交，并诱导使用者用 `git commit --no-verify` 绕过门禁；
- **假绿**（同源风险）：缓存的通过结果同样会被重放 → 内容已坏而门禁看着是绿的 ——
  与 `0b5a2ad` 修掉的那类事故同源，只是入口从「状态串不变」换成了「指纹为 null」。

## 建议修法

1. **`tree === null` 时不使用缓存**（运行后照常写盘可以，但读取时必须跳过；或直接不写）；
2. `treeHash` 失败不再静默：把失败的命令与 stderr 记入调试日志 / 缓存条目的 `treeError` 字段，
   让「指纹不可用」可观测（本次排查成本主要花在这里）；
3. （可选）去掉 null 兜底分支，把缓存语义收紧为「仅同一 tree 命中」；
4. （可选）分级 TTL：失败结果 30s、通过结果 5min，缩短「修好后仍被旧红挡住」的窗口。

## 修复后的验收标准

- 同一仓库内：制造失败 → 修好 → **立刻**重试提交 → 应当通过（无需手工删缓存）；
- 缓存文件里不再出现参与命中的 `tree: null`（即使出现，也必须不参与命中）；
- `treeHash` 的失败原因可在日志里看到。

---

> 附：本次事故的旁证 —— 被拦期间 `<tmp>/specflow-gates-*.json` 里的 `ts` 与错误内容完全对应第一次失败，
> 而工作区已经修复；删除缓存文件后同一条命令立刻通过，说明 gate 结论完全由缓存决定。
