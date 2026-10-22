# S2.2 验收与审查记录

- 合同：`docs/specs/S2.2-review-limits-and-agent-usability.md`
- 基线：`c47aa868eea75b9b2dbeb83c1bce21e3f4f3fb85`
- 日期：2026-10-22
- 授权：用户明确要求 deepseek-flash 实现 worker、父 Agent 验收收敛并提交；经确认仅清理 3 条 prunable 注册元数据；最多 3 次可能计费的 deepseek-flash 独立审查（预算 `s2-2-agent-usability-20261022`，calls=3）。

本文件是**运行证据归档**，不是独立审查结论，也不能替代 `spec_impl`/`spec_audit` 的封存证据。机械 fixture 只证明接线与退出码，不证明模型判定质量。

## 1. 实现分工与父级验证

| 范围 | 实现 | 父级处理 |
|---|---|---|
| 限额/封存/worker（A1–A5） | Flash worker A | 逐项复验接口与边界；把 core 的重复限额解析改为单一来源 |
| core 生命周期/CLI/board（A6–A8） | Flash worker B | 审阅 diff；补 coverage-gap 的可执行恢复；CLI 增加机器 headline；统一 `prepareWorkingAudit` 的 `limit` 传递 |
| Pi adapter/smoke/docs（A6–A10） | Flash worker C | 审阅 diff；修 output schema 失败信封（C11）；补 core README happy path/恢复表（C10） |
| worktree 诊断（A12）、集成验收、独立审查处置、提交 | 父 Agent | 见下 |

未使用 `fork_worker` 做审查；三次独立审查均为 `spec-flow` 封存 packet + deepseek-flash。

## 2. 权威门禁

由 `spec_impl` 记录的门禁（`impl.gates.check`）：

- 命令：`npm run check`（`command: {file:"npm", args:["run","check"]}`）
- `pass: true`，输出 32370 bytes，`output_sha256: 85cef1527efa570deaa5c2ad1f6094ab20e6f8c46b4fcef3e7590377c3c7b432`
- `head` 记录完整链路：`typecheck && lint && test` + 12 组 E2E（含新增 `e2e-review-limits.mjs`、`e2e-agent-workflow.mjs`）+ `check --ci --contracts-only`
- `tail` 记录末尾 contracts-only 通过行

另行在 impl 之后、audit 之前手动重跑同一命令，退出码 **0**（Node v24.19.0）。`impl.e2e` 同时绑定 `e2e-review-limits.mjs`（4 PASS）与 `e2e-agent-workflow.mjs`（1 PASS）。

## 3. 真实 CLI/worker 大包验收

`tests/e2e/e2e-review-limits.mjs` 与 `tests/e2e/e2e-agent-workflow.mjs`（均在 `npm run check` 内真实执行）：

- 默认限额拒绝 >512 KiB 包；显式 4 MiB 通过，`packet_sha256 === child_input_sha256`；
- proposal / committed / incremental / working-tree audit 四条路径均经真实 detached worker；
- 降低或非法化环境限额后，已封存 job 的 status/run/cache 仍按封存策略工作且不重复计次；
- CLI `impl` 门禁失败与 audit 超限/工具失败非零退出，PASS 为 0；
- 免费 `audit --prepare` 前后 Spec/ledger 字节不变、无模型、无预算。

## 4. 父级独立复算（`parent-acceptance.mjs`）

合成仓库、零 provider、零真实授权（fake auditor 只输出机械结果）：

| 验收 | 复算结果 |
|---|---|
| A1 | `524288/default`、`4194304/environment`、`1/argument`、`16777216/argument`；0/负/小数/字符串/Infinity/超限/`null`/非法 env 全部在计费前抛 `REVIEW_LIMIT_INVALID` |
| A3 | run/status/repair 携带 `maxBytes` 被拒且 job 数不变 |
| A2/A4 | committed 包 **585783 bytes** 经 detached worker 完成，`packet_sha256 === child_input_sha256`；限额相等通过、少 1 byte 拒绝；中文合同包 12438 bytes 按实际字节对账 |
| A5 | 完整包 12376 bytes > 1024：15 个分项合计精确等于 actualBytes、含 `prompt-wrapper`；Git 早停只给下界 |
| A6 | 未 begin/未 impl 时 prepare 拒绝；免费 prepare 不改 Spec/ledger、不建 grant；prepare+`--review-job`/`--max-bytes` 组合拒绝；impl 漂移在计费前拒绝 |
| A7 | 真实门禁退出 7 → CLI impl 退出 **1** 且记录 `impl-fail`；attach 只计次一次，免费 replay 不再计次 |
| A8 | 默认 `record-only`、`fresh=null`；漂移后 `--live` 给 `stage=impl` + `spec_impl`，绝不给 done；nextActions 五字段齐全 |
| A12 | 合成 prunable 家族：core/CLI 均报 `SPECFLOW_WORKTREE_UNAVAILABLE`/`worktree-inventory`/`prunable`/`prune --dry-run`，家族清单与 Spec 不变，dryRun 仍可用 |

原始输出：`docs/reviews/S2.2/parent-acceptance.mjs`（可直接重跑）。

## 5. 无网络 Pi 冒烟

已安装 Pi SDK **1.3.0**（`~/.pi/agent/extensions/kite/node_modules/@earendil-works/pi-coding-agent`，离线，无 provider 请求）：

- `pi-rpc-load`：真实 RPC `/spec`、`/spec worktrees`
- `pi-native-review`：9 工具真实 pipeline；免费 audit prepare（零模型/零计次/ Spec+ledger 不变）、限额 env 优先级、impl FAIL `isError`、>12000 字符 receipt 摘要、board record/live、A12 worktree 诊断
- `pi-daemon-ui`：缺 `notify` 的 UI 不中断 impl；提交拦截与人工拒绝；audit 失败透出
- `pi-tool-schemas`：OpenAI Completions/Responses + Anthropic 三种序列化，9 工具全部 object 根，**0 HTTP 请求**
- `pi-skill-discovery`：root manifest 发现扩展与 skill

## 6. 独立审查记录

### 提案（调用 1/3）

- job `d2d910b2ae1815e9a9c34071b9c5aab2`，deepseek-flash，原 verdict **FAIL** / `coverage-gap`
- 50/50 源块已对账，未报产品 findings；11 条 gap
- 父级确认 8 条 evidence criteria（C9–C16）指出的验收缺口，施工前补入 A1/A3/A5/A6/A7/A8/A10/A12
- 原 packet/raw/receipt 保留；未经修改，报告如实保留 FAIL

### 实现（调用 2/3）

- job `e0fc66d25bf6bbc30fa38c3d2e26b013`，deepseek-flash，thinking high，full-current-audit
- packet **580669 bytes**（>512 KiB；先按默认拒绝，再用显式 `maxBytes=1048576` 免费重备）——本任务自身即大包场景
- 结果：verdict **FAIL**；79/79 源块对账；12 条验收全部进入 criteria；1 条 gap
- 失败项：C10（core README 缺 happy path/恢复表）、C11（native output schema 与失败信封不一致）、C12（记录中只有 contracts-only 与两组 E2E，无法静态证明完整 `npm run check`/smoke/秘密扫描）
- usage：219904 tokens（input 173828 / output 45692），provider 报告 cost $0.107；预算计次 2/3

父级处置（均为 confirmed，不做无证据驳回）：

| 发现 | 处置 | 证据 |
|---|---|---|
| C10 | 已修：`packages/core/README.md` 增加编号 happy path + 恢复表 | 本次 diff |
| C11 | 已修：`spec_board` 成功字段与 `spec_new.version` 改为 optional，使 `isError` 信封符合声明 | 本次 diff；schema smoke 通过 |
| C12 | 已修：门禁证据现记录 `command/bytes/output_sha256/head/tail`，可静态证明 `npm run check` 整体执行；本文件归档 smoke/秘密扫描 | `impl.gates.check` |

### 复审（调用 3/3）

- job `03bbfc58404bb539dbaf08cc46cfd1d8`，deepseek-flash，full-current-audit，packet 602355 bytes（显式 `maxBytes=1572864`）
- verdict **FAIL**：86/86 源块对账、12 条验收、0 gap；5 条 blocking findings（F1–F5）
- 全部 confirmed 并修复：`assertSpecFileStable`（合同并发改写）、恢复动作选择器、审计限额建议用实测值、`spec_review.reviewLimit` schema、长 summary 截断标记
- 回归：`packages/core/test/review-recovery.test.mjs` 3/3；`pi-tool-schemas` 断言 reviewLimit
- 预算 3/3 已用尽；这些修复**不是**新的独立 PASS，闭环需要另行授权的 new cycle

未决项：无已知产品缺陷；缺一次独立复审。

## 7. 交付物秘密扫描

对 23 个新增/修改源文件、文档与测试执行 `check_secrets`：无命中。封存 packet（`e0fc66…`）经宿主扫描与 `check_secrets`：无命中。真实令牌、私人 packet/raw 不进公开仓库。

## 8. 边界与未做

- 未 push、未发布、未安装、未重启/重载宿主；未修改 S1.7/S2.1 历史合同与证据。
- 清理仅限 3 条 prunable 注册元数据（`git worktree prune`），未删除任何工作目录/文件。
- 机械 fixture 与 fake auditor 只证明接线；模型判定质量不在其证明范围。
- 预算已用尽（proposal 1 + 实现 1 + 复审 1）；两份 verdict=FAIL 的 packet/raw/job 均原样保留，不以父级结论冒充独立 PASS。
