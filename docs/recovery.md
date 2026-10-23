# 0.4.0：修复可达，关闭仍严格

这些入口只解决可复现的工作流阻塞，不代表独立审查已通过。版本发布状态另见 [0.4.0 发布候选](releases/0.4.0.md)。

## 预算和修复提交

```sh
spec-flow audit S1 --budget EXISTING_GRANT
spec-flow audit S1 --prepare --max-bytes 4194304   # 免费，禁止带 --budget
spec-flow audit S1 --review-job PREPARED_JOB_ID --budget EXISTING_GRANT
spec-flow check --ci --contracts-only --for-change
spec-flow verify --for-change
```

`--budget` 只引用已有授权，不创建/补充预算；缺省仍读取 `SPECFLOW_REVIEW_BUDGET_ID`。重复/空/非法参数在封存和写 Spec 前拒绝。运行失败仍非零退出；同一 job 不自动付费重跑。

`--for-change` 显式把 **active 的未完成、FAIL、协议错误、过期记录**列为警告，让修复能够提交；不会改写历史。非法合同/审批、收据篡改、伪造 PASS、done 不一致和实际项目 gate 失败仍阻断。默认不带该参数的 strict 检查及 `done` 不变。clone 缺少历史失败 job 时明确警告无法核验，不能把它说成完整性通过；PASS 不可借此绕过 retained evidence。

Action 默认 `purpose: strict`，可显式 `with: { purpose: change }`；其他值拒绝。若 caller 的 `verify` 内嵌 strict `check --ci --contracts-only`，它仍会阻断：上层 change **不自动覆盖**下层命令/环境。由项目明确选用相应检查命令；不要偷偷改调用方仓库。完整 `verify` / `check --ci` 仍运行项目 gates；`--contracts-only` 单独绿灯不是完整验证或审计。

## context：合同内限额，明确来源

```yaml
review_inputs:
  context_files: [src/entry.ts, evidence/run.json]
  context_limits:                  # 可省略；必须在批准合同内声明
    max_files: 40
    max_file_bytes: 262144
    max_total_bytes: 1048576
```

| 字段 | 默认 | 上限 | 单位 |
|---|---:|---:|---|
| max_files | 20 | 100 | 唯一文件数 |
| max_file_bytes | 65536 | 1048576 | UTF-8 bytes / 文件 |
| max_total_bytes | 131072 | 8388608 | UTF-8 bytes / 全部文件 |

必须为安全正整数，单文件限额 ≤ 总量；未知字段、重复路径、超限均拒绝。packet 自身仍独立受 `maxBytes` 限制；其他 blob/raw/index 限额不变。封存后的 status/run/repair 使用已封存合同策略，不读取新环境来扩大或缩小旧证据。

- proposal / full-current 读取当前未忽略普通文件，**不要求已经进入 HEAD**。需提交到远端的证据仍须人工脱敏、跟踪；本地可读不是远端 CI 已有。
- committed 只读指定 head 的 Git blob；不回退到工作区。
- ignored/missing/symlink/nonregular/not-at-head 分开诊断；不跟随文件或祖先链接。
- count 报 `actual/unique/limit/excess`；字节超限报 `actual/limit/excess`，total 另列最大 5 个路径/bytes。文本错误给路径、code point 和 **0-based 原始 UTF-8 字节偏移**，不回显正文；U+FFFD 即使是合法原文也拒绝。不截断、不删验收、不自动缩 scope。

## 原始响应与运行身份

`outputInfo.rawCounts` 区分原始 criteria/typed product/evidence/untyped、findings/issues/coverage 与 expectedSourceUnits。原始 `criteria` 非空但缺 kind，不再误说成原始零 criteria。确实为空时用 `REVIEW_OUTPUT_NO_CRITERIA`。

`observations` 带 `raw.criteria[i]` 等来源、`verified:false` 和截断标记（最多 20 项、每项 2000 字符）；只用于定位原始候选发现，不是有效审查或已确认产品缺陷。完整原文在私有 stdout；不改 verdict/raw/result/预算。先读实际 `telemetry.decodePath/stopReason/usage`，未知明确 null；执行结束不代表协议有效。330-unit 机械回归不证明模型容量、零漏报或分片必要性。

`spec-flow identity` 与 native board/review/impl/audit 的 `engine` 提供版本、`source_sha256`、`loaded_at`。指纹是模块初始化时 core 源码字节的测量；CLI、常驻 Pi、worker 可分别对比，不是整个宿主/Pi adapter 的内存代码证明。磁盘更新不会改变已加载实例的身份，也不会自动重启/reload Pi。

## 快照漂移

新 `impl` 把逐文件清单私有保存在 Git common-dir 的 `spec-flow/snapshots-v1/`，引用写入 `impl.snapshot_manifest`。`board ID --live --json`、audit stale 诊断和 live check 显示新增/删除/内容/类型/执行位变化。默认 Git ignore 语义不变：未跟踪 ignored 产物不参与，已跟踪产物仍参与。

aggregate snapshot hash 仍是判断依据。缺失、legacy 或篡改清单只失去定位能力，不能变成通过；重跑稳定 impl 才能建立新基线。不要为过门禁排除 tracked 构建产物。

## 真实测试观察采集，不认证历史

```sh
spec-flow capture S1 --label A1-red --expect fail --output evidence/A1-red.json \
  --kind observation --timeout-ms 60000 --max-output-bytes 262144 \
  -- node --test tests/regression.mjs
```

`--expect pass|fail`、安全 label、相对 `.json` 输出和 `-- COMMAND ARGS` 必需；kind 默认为 `observation`，可显式 `historical-replay` / `mutation`。无隐式 shell，不自动回退代码/插入 mutation。命令是受信任的本地执行，不是沙箱；其自身可能有副作用，先检查它。

记录真实起止时间、HEAD、合同 hash、前后工作树 hash、argv、退出码、stdout/stderr 字节/hash 和完整性。默认 timeout 60000 ms（1..1800000）、stdout+stderr 总量 262144 bytes（1..1048576）。无效 UTF-8 输出以 base64 保留原字节，不丢数据。仅完整、稳定、正常退出且匹配预期时 CLI 退出 0；fail 要求正常非零退出，超时/截断/信号/启动失败/树变化均不满足，仍保留明确失败记录。

输出独占创建、0600，禁止覆盖、越界、链接及 `.git`/node_modules；自身输出文件从前后比较中排除。高风险模式命中拒绝落盘，但有限扫描**不是完整秘密/PII 审计**：共享前再人工脱敏并执行秘密扫描。capture 本身不改 Spec/audit/预算、不调用 reviewer；被指定的命令仍须受用户授权约束。

非零不是自动证明回归，`historical-replay`/`mutation` 是调用者声明而非历史认证。修复后重新构造的红灯不能补造首次修复前 red-first；历史欠缺只能明确记录并走真实合同变更/批准，不能冒充 done。
