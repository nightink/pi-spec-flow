# 流程审查：review 包限额与 Agent 易用性

- 日期：2026-10-22
- 被审源码：`c47aa868eea75b9b2dbeb83c1bce21e3f4f3fb85`
- 类型：parent-only 源码审查 + 本地合成复现；不是独立模型审查，不是 lifecycle audit。
- 边界：检查 core/CLI/Pi adapter/skill 的主流程；未执行完整权威 `npm run check`、真实 Pi smoke 或 provider 请求。没有修改产品代码、历史 Spec 或真实预算，没有 push/reload。

## 结论

保留当前证据绑定、预算计次、只读 review 与 lifecycle audit 的分离。主要问题不是缺少门禁，而是 **Agent 难以提前知道限制、准确识别失败、找到可执行恢复动作**。应把这些规则做成统一配置和机器可消费的接口，而不是继续增加提示词。

512 KiB 是旧合同明确规定的硬上限，不是本机环境变量丢失：`S1.7` 的 Design 明写 full packet <=512 KiB，README 也声明环境变量不能提高 cap。支持更大包属于显式合同扩展；本报告没有偷偷改变历史标准。

## 已验证发现（按优先级）

### F1 / P1：包限额多处硬编码，环境变量只在部分阶段可增大

位置：

- `packages/core/src/core.mjs:888–894`：working-tree diff 使用环境变量，且以 `parseInt` 宽松解析。
- `packages/core/src/review-engine.mjs:49,729–730`：`Math.min(MAX_PACKET, Number(env) || MAX_PACKET)` 强制完整包 <=524288。
- 同文件 `:1115,1122`：committed diff 两条 Git 读取另有固定 buffer。
- 同文件 `:846,855,974,1311` 及 `packages/core/src/review-worker.mjs:32`：status/repair/run/worker 又独立按 512 KiB 读取。

实测设置 `SPECFLOW_AUDIT_MAX_BYTES=4194304`：614517-byte working-tree diff 生成成功，seal 仍报 `Complete review packet exceeds limit; no truncation`，committed prepare 更早报 `Review Git operation failed/oversize: diff`。只删除 `Math.min` 不能修复全链路。

完整包不等于 patch：469121-byte 的合成文本 diff（小于 512 KiB）在 JSON 转义和其他字段加入后仍被拒绝；240 KiB 正文经合同与源块索引重复携带，加 40 KiB diff 也被拒绝。最小探针包已有 9991 bytes，其中序列化数据 924 bytes，其余为提示协议。本次没有对真实用户包作 token 或容量估算。

额外复现：`invalid`、`0`、`524288junk` 在 seal 默默回退，`-1` 则被误报为包超限。解析规则与 diff 阶段不一致，Agent 无法区分配置错误和内容过大。

建议：共享严格解析 + 有界显式增大 + 封存有效策略。完整包按精确 UTF-8 bytes 计算；新 job 在环境变化后仍可读取/运行/复用。legacy 按原边界兼容，不重解释其结果。新策略不能顺带放宽 raw/context/blob/索引等独立限制，也不代表 provider 的 token 窗口足够。

### F2 / P1：CLI 的业务失败仍退出 0，native 也缺少机器失败信号

位置：`packages/core/src/core.mjs:1859–1893,2504–2532,3421–3440`；`packages/pi/index.ts:69–74,304–324,328–372`。

真实临时 CLI 复现：

- 门禁子进程 `exit(7)` → Spec 的 `impl.pass=false`，stdout 是 FAIL，但 `spec-flow impl S1` 退出码 **0**。
- 超限 full audit → `audit.verdict=fail`、`output_info.category=execution-error`，但 CLI 仍退出 **0**。

原因是生命周期 core 返回摘要字符串，CLI 直接 `console.log`；native 包装同样只返回 text/details，没有此类失败的 `isError`/结构化 pass。抛出的参数异常仍会非零，问题仅发生在被转成阶段结果的失败。

影响：`&&` 链和只检查退出码的 Agent 会继续推进；**不等于 done 能绕过已有 FAIL**，闭环检查仍会阻止。

建议：保持原公开文本 API 兼容，另提供共享机器结果；CLI 对已执行但不通过的 impl/audit 返回非零，native 暴露准确分类。不能把 coverage gap、工具协议错误都描述为产品 bug。

### F3 / P2：完整 audit 缺少公开的免费 prepare 操作

位置：`packages/core/src/core.mjs:2337–2408`；`packages/core/src/review-engine.mjs:1018,1398–1403`；`packages/pi/index.ts:328–344`。

普通 `spec_review prepare` 是免费入口，但拒绝 `mode=working-tree-audit`，也不能执行 lifecycle job。`spec_audit`/CLI audit 则在准备后直接进入执行；没有 prepare-only 参数。内部 `prepareWorkingAudit` helper 的存在不等于原生 Agent 有可用入口。

这使 skill 推荐的“检查封存 packet、执行 check_secrets、再消费授权”在 full audit 的公开路径上不自然：不能要求 Agent 故意用缺失 budget/launcher 制造失败来截住执行。内置 high-risk scanner 仍存在，本项不是声称当前没有任何扫描。

建议：增加免费 audit prepare，返回 jobId/packetPath/大小，不写 Spec/ledger、不计次；显式执行/附加同 job，计费前再次验证。保留普通/delta 不能关闭 full audit 的隔离。

### F4 / P2：Agent 看板没有下一步，实时漂移边界不显式

位置：`packages/pi/index.ts:160–168` → `packages/core/src/core.mjs:1490–1508`；`nextStep :3107–3143`。

原生 `spec_board` 和 CLI board 调用简版 `board()`，本次超限后的实际输出仅 `S1 [S1.md]: 进行中`，没有错误类型/恢复动作。较丰富的 `renderBoard` 主要用于 `/spec` 命令，不是同一入口。

`nextStep` 有意只看记录、不核验当前实现；现有测试 `packages/core/test/core.test.mjs:1175–1181` 明确证明代码变化后它仍建议 done，最终 done 才拒绝。这是现有设计，不应夸大为闭环漏洞，但会让 Agent 反复走错下一步。

建议：同一诊断模型服务 native/CLI/TUI；轻量默认明确 record-only，按需 `id/live` 查询 freshness；给出带参数的 nextActions，标明付费/人工前置条件。

### F5 / P2：长 receipt 的文本投影可能截掉恢复入口

位置：`packages/pi/index.ts:69–83`；`packages/pi/adapter-core.mjs:9–24`；`packages/core/src/review-engine.mjs:884–894`。

`structuredResult` 先把整个结果 pretty JSON，再截取前 12000 字符；完整 receipt（含 coverage_index）排在 packetPath/result/outputInfo 前面。用真实 sealed 20k-character 合同生成 receipt，再经过实际 `truncateToolText`：jobId 仍可见，**packetPath 被截掉**。

完整 `structuredContent` 仍保留，因此这里不是指所有宿主都会丢失数据；对主要消费文本的 Agent，恢复路径不可靠。

建议：文本先输出紧凑状态/诊断/jobId/packetPath/nextActions，完整 receipt 继续留在结构化输出和私有文件。不能裁剪送审原包或原始 findings 来解决显示问题。

### F6 / P2：不可用 worktree 正确阻止分配，但报错误导

位置：`packages/core/src/workspace.mjs:28–46`；`packages/core/src/core.mjs:3288` 附近的 `reserveSpecIdUnlocked`。

本会话尝试 native `spec_new` 与可信 CLI 创建草案，均失败为裸 Git 错误 `not a git repository`。只读检查确认当前 checkout 正常，但 Git 家族另有 **3 个 prunable 条目**：目录存在，`.git` 标记不存在。没有删除、prune 或修复这些用户目录。

已在独立合成仓库复现：创建 linked worktree 后仅删除临时成员的 `.git`，`newSpec` 报同样错误；`dryRun` 仍可用。

阻止分配是正确的 fail-closed 编号策略，不建议自动跳过成员。问题是错误未说明出错成员和恢复方式，让 Agent 误判当前 cwd。

建议：结构化成员诊断、prunable 状态和只读检查指引；清理仍由 owner 决定，禁止自动 prune/猜编号。

## 修订顺序与验收映射

1. **先通大包全链路**：共享限额、严格解析、sealed policy、大小诊断（F1 → A1–A5）。建议默认仍 512 KiB，显式允许最高 16 MiB；`maxBytes` 参数 > 环境变量 > 默认。16 MiB 是待批准的资源上限，不是实测模型容量承诺。参数入口避免长驻 daemon 无法继承 bash export 的问题。
2. **使执行可预检、失败可判定**：免费 full audit prepare（F3 → A6）、CLI/native 机器结果（F2 → A7）。
3. **使恢复可执行**：board live/record-only（F4 → A8）、紧凑摘要（F5 → A9）、worktree 诊断（F6 → A12）；同步 skill/docs 和真实入口测试（A10–A11）。

建议路径：创建/完善合同 → 提案审批 → begin → 实现/真实验收 → impl → **audit prepare → 扫描完整 packet → 获授权后执行/附加同 job** → 必要人工确认 → done。

不建议：简单增大一个常量、删测试/历史报告以凑大小、静默截断、让模型摘要代替原文、故意缩 scope、把 delta PASS 当闭环、遇错就新建付费 job。

## 草案与当前阻塞

- [proposal-input.json](./proposal-input.json)：完整结构化创建输入，12 项编号验收；尚未批准。
- [proposal.preview.md](./proposal.preview.md)：可信 CLI `spec-new --json` 的 **dryRun 模板 v2 原样输出**。
- **预览内 ID 是占位值，未预留，不能作为 S2.1 的新版本，也不能直接复制到 Spec 扫描目录。**
- 正式分配被上述不可用家族成员阻止。先由 owner 检查/处理清单，再用原生 `spec_new` 或可信 CLI 从保存的输入正式生成；本次没有手写编号、伪造审批或开始实现。
- 旧硬 cap 是 S1.7 的明文要求；此提案同时增加公开 API、失败语义和限额策略，因此作为依赖 S1.7/S2.1 的新扩展草案，而不是改写已 done 的历史合同。单独回修缺陷时仍可归母。
- 产品修改需提案批准；独立付费 review 需单独明确授权，本次未创建或消耗真实 grant。

## 可重复证据

[probe.mjs](./probe.mjs) 是 **pre-fix 复现脚本**，断言当前问题存在；修复后相应断言应失效，不能当成修复后的通过测试。仅使用自己创建的临时仓库，结束清理；不调用 provider。

```bash
node docs/reviews/workflow-review-20261022/probe.mjs "$PWD"
node --test packages/core/test/core.test.mjs \
  packages/core/test/review-creation.test.mjs \
  packages/core/test/review-execution.test.mjs \
  packages/core/test/review-coverage.test.mjs \
  packages/core/test/review-repair.test.mjs
```

本次 Node `v24.19.0`：现有相关测试 **149/149 通过**；[targeted-tests.log](./targeted-tests.log) 为原始日志；[probe-results.json](./probe-results.json) 为复现输出。未宣称 Node22 权威门禁、真实宿主 native 行为或独立模型判定已验收。native 的映射/错误标识判断来自源码，文本截断 helper 已实际执行。
