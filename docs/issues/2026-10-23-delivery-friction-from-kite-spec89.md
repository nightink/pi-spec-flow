# 交付摩擦：一个真实 Spec 跑完 10 次审计后暴露的 8 个问题

| 项 | 值 |
|---|---|
| 报告日期 | 2026-10-23 |
| 报告来源 | Kite 仓库 `specs/89.http-hono-convergence.md`（34 提交 / 126 文件 / 61 条路由迁移） |
| 组件 | `core.mjs`（CLI audit / check / impl）· `review-engine.mjs`（packet 与错误信息）· `review-coverage.mjs`（context 上限） |
| 影响版本 | 0.3.0（`~/git/github.com/nightink/pi-spec-flow` @ `4bce1e7`，与 Kite 安装版本一致） |
| 严重度 | 中：交付流程可跑通，但存在**死锁**与**不可达的验收要求**，逼使用者绕过或伪造 |
| 状态 | **Open** |

> 说明：本报告只列**当前版本仍存在**的问题。原先的 "512 KiB 包体硬上限 / `SPECFLOW_AUDIT_MAX_BYTES` 只能调低"
> 已被 `4bce1e7 fix(S2.2): configurable review packet limits` 修复（现在默认 512 KiB、上限 16 MiB、
> env 显式优先），**不在此列**。

---

## 1. CLI `audit` 不接受 `--budget`，只有 MCP tool 能审计

**现场**：预算存在且有效，但 CLI 路径必然失败：

```
$ spec-flow audit 89 --budget kite-spec89-20261022
Spec 89 审计结果: ⚠️ 工具/协议错误（非产品 FAIL）
工具执行/证据绑定错误：Invalid delivery-cycle budget ID
```

**根因**：`auditUnlocked(cwd, id, { budgetId, reviewJobId })` 支持 `budgetId`，
但 CLI 的 `case "audit"` 只解析 `--review-job`，从不传 `budgetId`；`budgetPath(cwd, undefined)`
直接抛 `Invalid delivery-cycle budget ID`。

同时 `review --action run` 明确拒绝 lifecycle audit job：

```
Error: Ordinary review cannot execute or attach lifecycle audit jobs
```

**结果**：审计**只能**经由 Pi 进程内的 MCP tool 执行。如果那个进程里的模块是旧版本（本次现场就是：
sessiond 进程 08:02 启动，缓存了旧的 512 KiB 常量），用户**无法从 CLI 绕过**——两条路都堵死。

**建议**：`audit <id> [--budget <id>] [--review-job <job>]`，与 `spec_audit` 工具参数一致。

---

## 2. `audit` 失败 → `check --ci` 红 → commit 被拦 → 而审计要求文件已在 HEAD（死锁）

**现场**（反复发生 4 次）：

1. `spec_audit` 返回 `protocol-error` 或产品 fail → 引擎把 `audit:` 段写回 Spec frontmatter
2. `spec-flow check --ci --contracts-only` 报：
   ```
   ✗ 89: audit verdict/criteria 未全绿
   ✗ 89: audit v3 覆盖对账缺失、未通过或绑定不一致
   ```
3. `git commit` 被 pre-commit 门禁拦下（"spec-flow: 门禁未通过，禁止 commit"）
4. 但审计的 `context_files` 要求**文件已在 HEAD**（`review-engine.mjs` 用 `git ls-tree` 取 blob）
5. 于是：想修 Spec → 要 commit → commit 要 check 绿 → check 要 audit 绿 → audit 要已 commit

**本次的绕过方式**：手工把 `audit:` 段从 frontmatter 删掉，把结论写进正文，再 commit。
这等于**为了能提交而隐藏审计结论**——流程把诚实的用户推向造假。

**附带问题**：`--no-verify` 无效（本仓库没有 git hooks；拦截发生在别的层），所以这条路也走不通。

**建议**：`check --ci` 区分「审计未通过」与「审计结果自相矛盾」：
- 审计 fail 是**产品状态**，不应阻塞提交（否则无法提交修复）
- 只有「audit hash 与当前树不匹配」这类**证据绑定错误**才拦

---

## 3. red-first 是硬性验收要求，但引擎不提供采集入口

**现场**：验收 `D8/A4` 要求

> four failure regressions exist red-first (failure-before-fix output retained)

但 `spec_impl` 只记录三样东西：`gates.<name>.tail`（成功输出尾部）、`e2e`、`migrations`。
**没有任何字段记录"修复前跑红"的输出**，也没有 `--capture-red` 之类的入口。

本次只能人工做：把实现改回旧行为 → 跑测试 → 记录输出 → 恢复。

```
### red-1: 413（移除 bodyLimit 中间件）
     × I4：统一 bodyLimit —— 超过 1 MiB → 413   Tests 1 failed | 11 passed
### red-2: 405 + Allow（移除 notFound 的 405 分支）
     × method 错 → 405 + Allow（A4）             Tests 2 failed | 10 passed
### red-3: 400 畸形 JSON（回退成静默折成 {}）
     × JSON reader 语义（spec 89 D4）            Tests 1 failed | 1 passed
### red-4: 404 未知 /api/*（回退成 text/plain 404）
     × 未知 /api/* → JSON 404（A4，不回落 SPA）  Tests 1 failed | 11 passed
```

**问题**：这条要求在引擎层面**不可满足**（除非人工造），而它又是 `done` 的前置条件之一。

**建议**：给 `spec_impl` 加 red 采集，例如
```
spec-flow impl <id> --expect-red <test-path>[:<filter>]
```
在跑 gate 前先对指定测试做一次"当前实现下应失败"的断言并把输出存进 `impl.red[]`。
退一步：允许 Spec 声明 `red-first: not-applicable`（附理由），由评审判定是否接受。

---

## 4. packet 相关错误信息不指明对象（4 处）

实测遇到的四条报错，全部只说"错了"，不说"哪个文件 / 什么值 / 超了多少"：

| 报错 | 实际情况 | 缺陷 |
|---|---|---|
| `Review context source must be an available regular file, never a symlink` | 文件**不是** symlink，而是被 `.gitignore` 的 `*.log` 挡住，`git ls-tree` 里查不到 | 错误归因错误，排查方向被带偏（我去查了 20 个文件的 `lstat`） |
| `Review context source must be supported UTF-8 text (no binary/replacement/control bytes)` | 某个 `.txt` 含终端产生的 `U+FFFD` | 不说是哪个文件、哪个字节偏移 |
| `Review context source exceeds single/total byte limit; no truncation` | 总量 134427 > 131072 | 不报当前值/上限/超出量 |
| `Invalid context source list (max 20 unique files)` | 21 个文件 | 不报数量也不报名字 |

`review-engine.mjs:1328` 的 `if (size > 65536 || bytes > 131072)` 与 `review-coverage.mjs:153`
的 `max 20`，报错时都不带上下文。

**建议**：每条都带上对象，例如
```
context source packages/../verify.log: not a regular git blob (untracked or ignored)
context source docs/evidence/a3.txt: control byte U+FFFD at offset 812
context sources: 134427 B > 131072 B limit (exceeds by 3355 B); largest: library.ts (26050 B)
context sources: 21 files > 20 limit; drop at least 1
```

---

## 5. 硬编码的三处上下文上限与新方向（S2.2 可配）不一致

| 位置 | 值 | 可配？ |
|---|---|---|
| `review-coverage.mjs:153` | unique files ≤ **20** | ❌ |
| `review-engine.mjs:748` | 总量 ≤ **131072** | ❌ |
| `review-engine.mjs:753`（校验）/ `1328`（生成） | 单文件 ≤ **65536** | ❌ |

S2.2 已经把 **packet** 上限变成可配（512 KiB 默认 / 16 MiB 上限 / env 显式优先），
但这三处仍是硬编码常量。一个 126 文件的中型迁移就会顶到 20 文件 / 131 KB 的边，
而"把关键文件从 context 里删掉"是唯一出路——这会**降低审计质量**。

**建议**：与 packet limit 走同一套配置（`review-limits.mjs`），并让 `prepare` 支持
`contextMaxFiles` / `contextMaxBytes` / `contextMaxFileBytes` 显式参数。

---

## 6. `protocol-error` 把真实内容发现一起埋掉

**现场**：两次 `protocol-error`（`repairable: false`）的 issues 里，全是**真实缺陷**：

```
S15: S15 forbids a default body limit, but S23/S141 introduce 1 MiB — contract contradiction.
S48: A10: verify is claimed as 9/9 while A10 says 8 steps.
S75: text/plain error count claimed 0, but guard() in hono/http.ts returns text/plain 401/403
S175: States 1904 passed vs 1907 in S90/S91 evidence.
```

这些内容按上表逐条修完，Spec 质量实质提升。但**从引擎返回结构上**，
"模型输出协议不合规"与"模型输出了 10 条真缺陷"是同一个 `category: protocol-error`，
使用者只能靠"顺手读 issues 文本"才发现。

更极端的一次：`productCriteria: 0` / `evidenceCriteria: 0`（模型输出里**没有任何 criteria**），
错误文案仍是"工具输出协议错误"——与"输出为空"很难区分。

**建议**：
- 给 `outputInfo` 加 `rawCounts: { criteria: 0, issues: 10, units: 228 }`
- 区分 `REVIEW_OUTPUT_EMPTY`（0 criteria）与 `REVIEW_OUTPUT_PROTOCOL`（有内容但字段不合规）
- 若 `issues` 非空且能解析，明确提示"以下内容发现可用于人工修复"

---

## 7. `spec_impl` 的 snapshot 包含构建产物，导致每次 build 后都要重跑

**现场**：

```
$ spec-flow impl 89      # 内部会跑 verify（含 build）
$ spec-flow audit 89
Error: Spec 89 implementation changed after spec_impl (5966e2f8912a → 17d78ae0616b); rerun spec_impl
```

`repositorySnapshotHash(repo, { excludePaths: [spec.path] })` 默认只排除 Spec 自身，
所以 `dist/`、`dist-chrome/` 等产物一变更，snapshot 就漂移。表现是：**改一行注释 → build → audit 报快照不符**。

**建议**：默认排除 `dist/`、`dist-chrome/`、`coverage/`、`node_modules/`、`.git/`（工程上这些
从来不是"实现内容"），或提供 `KITE_SNAPSHOT_EXCLUDE`。

---

## 8. 规模临界点：321 units 成功，330 units 模型输出为空

**实测**（同一 Spec，同一模型，同一 packet 上限 4 MiB）：

| 轮次 | source units | packet_bytes | 结果 |
|---|---|---|---|
| 第 9 次 | 321 | ~884 KB | **321/321**，criteria 13+2，8 项 pass |
| 第 10 次 | 330 | 885 KB | **0/330**，productCriteria **0**，evidenceCriteria **0** |

第二次 `timed_out: false`、`output_truncated: false`、`state: completed`，也就是
**调用成功但输出里没有任何 criteria**。这与 packet 大小无关（只多 1 KB），
而是"要求模型逐条输出 330 行账本"这件事本身超出了单次输出能力。

**后果**：一旦 Spec 超过这个规模，**每一次修订（哪怕只加三行说明）都会让 unit 数上涨**，
从而离可用更远——修复方向与失败原因相反。本次最终只能停止追加审计预算。

**建议**：
- 账本支持**分片**：`review --chunk 1/3` 分段输出后合并，或在 prompt 里按章节分批
- 或对 `source_units > N`（如 250）的 Spec，自动提示"建议拆分 Spec"
- 至少在失败时明确报 `units: 330 > model capacity`，而不是"协议错误"

---

## 附：本次交付的实际消耗

| 预算 | calls | 结果 |
|---|---|---|
| `kite-spec89-20261021` | 2/2 | 2 次 fail（各有真实 findings） |
| `kite-spec89-20261021-r2` | 2/2 | 2 次 protocol-error（issues 有价值） |
| `kite-spec89-20261022` | 3/3 | 第 7 次 fail（6/12）、第 8 次 fail（7/9） |
| `kite-spec89-20261022-r2` | 1/1 | 第 8 次（7 pass / 2 fail），A3/A4 暴露 |
| `kite-spec89-20261022-r3` | 1/1 | 第 9 次（**321/321，8/10 pass**） |
| `kite-spec89-20261023-r4` | 1/1 | 21 files > 20，准备阶段失败 |
| `kite-spec89-20261023-r5` | 1/1 | **330 units → 输出为空** |

另有 4 次在准备阶段失败（未扣预算）：symlink 误报 1 次、控制字符 1 次、context 超限 1 次、20 文件 1 次。

**净结果**：代码与证据层面完成（`verify` 9/9、1907 测试、A3 三宿主实测、A4 red-first 四例），
但 `spec_done` 因第 8 条**在流程上不可达**。
