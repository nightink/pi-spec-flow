---
id: S2.1
title: 可配置 review 包限额与 Agent 可执行的预检、诊断和恢复
kind: spec
author: agent
status: draft
created: '2026-10-22'
review:
  decision: pending
evidence:
  e2e: []
  migrations: []
  human: []
template:
  version: 2
  sha256: 358de590b6ba9668445b5880a12561216ed9e9d215c4a07d6b3ddfc1ab92accf
deps:
  - S1.7
  - S2.1
---

- 状态：草案

# 可配置 review 包限额与 Agent 可执行的预检、诊断和恢复

## Outcome

- 超过默认 512 KiB 的合法完整 review packet 能按显式限额完成 prepare/run/worker/status/cache，不靠截断或缩小审查范围。
- Agent 可免费准备完整 audit，得到准确的机器状态、失败退出码和下一步，不必猜测隐藏的环境与恢复规则。

## Non-goals and safety boundaries

- 不授予/提高/重置预算，不自动重试终态 job，不以 ordinary/delta PASS 关闭 full audit，不代替人工核验。
- 不截断或摘要替换合同/diff/源块，不自动修改 scope，不保证模型容纳任意 token 数或零漏报。
- 不重写 S1.7/S2.1 历史合同/审计，不自动安装、push、发布或重启；不在本任务重做 coverage 协议或扩大单源/context/raw 等独立限额。

## Design

- D1 → A1–A4：共享限额解析，默认 524288 bytes，允许安全整数 1..16777216；prepare 的显式 maxBytes 优先于 SPECFLOW_AUDIT_MAX_BYTES，其次默认。环境变量非空时必须是正十进制整数字符串；空值按未配置处理，非法值拒绝，不做 parseInt 截断或 NaN 回退。
- D2 → A2–A4：限额覆盖精确 UTF-8 child prompt；Git buffers、seal、run、worker、status/cache 共用策略。封存实际 bytes、有效限额与来源，后续读取遵循该 job 创建时策略而非当前环境；legacy 缺 metadata 按 512 KiB 兼容，raw/context/blob/索引限制不变；受支持 legacy repair 保持免费与原始绑定。
- D3 → A5：稳定错误分类带 stage、limitBytes、配置来源；完整包已构建时带 actualBytes 和按序列化口径可对账的分项字节。Git 提前中止只报告已知下界/总量未知，不能编造精确大小。给出安全 nextActions，不回显正文/秘密，不自动删除证据或缩 scope。
- D4 → A6：spec_audit 和 CLI audit 增加显式免费 prepare；复用 lifecycle 前置条件和 full-current bindings，返回 jobId/packetPath/bytes，不调 provider、不计次、不写 Spec/ledger。现有 reviewJobId 路径执行/附加同 job，计次前重验实现/合同/packet。保留默认 audit 调用兼容路径及已有授权约束。
- D5 → A7：核心提供机器结果并兼容既有公开文本 API；CLI impl/audit 在 FAIL、协议/执行错误时非零，native 给出 pass/category 与宿主错误标识。产品 FAIL、coverage gap、工具错误分别报告，不要求 Agent 解析 emoji。
- D6 → A8–A9：spec_board 增加可选 id/live；默认轻量且明确 record-only，live 查询才计算 checkout freshness。返回阶段、阻塞原因、tool+args 的 nextActions、授权/人工需求；review/audit 的有界文本摘要先放 jobId/state/category/packetPath/nextActions，完整 receipt 保留结构化输出与私有文件。
- D7 → A10–A11：README/core README/skill 同步一条推荐 happy path 和恢复表；核心、CLI、native、detached worker 行为一致。验收使用合成仓库/fake executor/无网络 Pi smoke；真实付费独立审查另需用户授权，机械 fixture 不是模型 review。
- D8 → A12：worktree 清单不可验证时继续阻止编号分配，但错误明确是哪个成员不可用、prunable 标记和只读检查步骤；不能误导为当前 checkout 非 Git，不自动 prune、不猜编号或绕过家族扫描。

## Ordered implementation plan

1. 批准合同并确定独立 proposal review 的授权方式，核对审查发现与 A1–A11 映射后才 begin。
2. 先固化 parent-only 合成探针的 pre-fix 回归，再实施共享限额、sealed metadata、legacy 读取和字节诊断。
3. 增加免费 audit prepare 与同 job 执行/附加，测试零预算与漂移拒绝。
4. 统一生命周期机器结果、CLI 退出码、native 摘要、board live/record-only 和 nextActions，保持文本 API 兼容。
5. 同步工具 schema/skill/docs，运行完整 check、真实 CLI/worker 大包验收及离线 Pi smoke；扫描交付物，独立审查仅在授权后执行，不伪造 approval/audit/done。

## Executable acceptance

- [ ] [A1] 默认 524288；显式 maxBytes > 环境变量 > 默认的优先级实测，正整数边界 1/524288/4194304/16777216 有确定结果；0、负数、小数、非数字、混合后缀、Infinity、超上限在计费前拒绝，空环境值按未配置。
- [ ] [A2] 真实 prepare/CLI/detached fake worker 中，>512 KiB 且 <4 MiB 完整 packet 分别覆盖 proposal/committed/incremental/working-tree audit；4 MiB 配置通过而默认拒绝，packet_sha256 等于实际 child_input_sha256；不只测 resolver。
- [ ] [A3] 大包 prepare 后清空/降低环境限额，run/status/cache 按封存策略处理，免费重放不计次；legacy <=512 KiB 原字节兼容，受支持 repair 免费；非法限额 metadata/packet 篡改拒绝，不把不支持的 repair 变成 PASS。
- [ ] [A4] 按完整 UTF-8 prompt 实测，限额等于实际 bytes 通过、小 1 byte 失败，中文/转义/合同索引计入；blob/context/索引/raw 独立限额不变；超限无 worker、无预算消耗、无伪 PASS。
- [ ] [A5] 完整包超限诊断包含 stage/actualBytes/limitBytes/配置来源与可对账分项字节；Git 提前超限只给明确下界/总量未知。CLI/native 提供可执行恢复动作，不泄露正文，不自动缩 scope。
- [ ] [A6] 真实 CLI/native audit prepare 返回可扫描 packetPath 和 jobId，零模型/零计次且 Spec/ledger 字节不变；授权执行只调用一次并可附加；期间合同/实现变化在计次前拒绝，ordinary/delta 仍不能附加。
- [ ] [A7] 真实 CLI impl 门禁非零以及 audit 超限/launcher/protocol/product fail 均非零退出且记录不通过；PASS 为零。native 有明确失败分类与宿主错误标识，原公开文本 API 回归不破坏。
- [ ] [A8] board 对 draft/待 impl/impl fail/待 audit/protocol error/缺人工/done-ready 给稳定 nextActions；默认明确未查 live freshness，live 模式实现或合同漂移后引导 impl 而非 done；查询不改生命周期或调用模型。
- [ ] [A9] 超过 12000 字符的真实 receipt 经 native 文本通道仍可取得 jobId/state/category/packetPath/nextActions，完整 receipt 可从结构化结果/私有文件读取；不裁剪 packet/findings 原件。
- [ ] [A10] README/core README/skill/工具声明一致展示限额优先级、免费 audit prepare→扫描→授权执行/附加、record-only/live 和失败退出语义；说明 shell 与宿主环境区别，不宣称自动 reload。
- [ ] [A11] 完整 npm run check、相关真实 CLI/detached-worker E2E、无网络 Pi schema/native smoke 通过并留证；大包只用合成输入、不创建真实 grant/调用 provider，秘密扫描通过；独立审查和生命周期状态如实记录。
- [ ] [A12] 合成家族含 prunable/不可访问 worktree 时，spec_new/spec_alloc 的 core/CLI/native 均报结构化成员诊断而非裸 Git 错误，编号与 Spec 不变；只读预览仍可用，不自动 prune/清理/跳过成员。

## Coverage and review inputs

Before approval, link every normative Outcome/Design promise to numbered acceptance and its implementation slice. Split compound observable dimensions; state units, aggregation semantics, boundaries and positive/negative examples for numeric claims. A helper's capability does not prove that the actual entry calls it; include the entry and unchanged baseline when needed. Missing context is not proof of disconnection.

Optional contract frontmatter `review_inputs` may declare `context_files` (explicit target-repository relative ordinary files) and `proposal_reviews` (retained same-Spec proposal job IDs). It participates in contract hashing: declare inputs before impl. No automatic repository crawling, cross-repository reads, execution, or imported approval. New packets bind the whole Markdown source inventory and require every source ID to be accounted for; references alone do not prove semantic completeness.

## Evidence boundary

Declare real gates, isolated E2E/migration/human evidence before implementation. Separate source binding, mechanical accounting, static judgment, recorded execution and final delivery. Runtime/remote/human facts may be visibly deferred, but required recorded evidence must still be current and bound; static wiring defects cannot be deferred as runtime facts. A generated draft, mechanical mapping or static PASS is not proposal approval, runtime acceptance or completed delivery.

## Review 与决策

Draft generated from a deterministic template. For each confirmed major/blocker, record the original source, disposition, acceptance and evidence. "Written into Design" is not closure. A verified rejection or actual approved withdrawal/waiver needs its source and rationale rather than an invented test. Do not treat an author summary as an independent report or placeholders as acceptance. Keep raw reports and parent dispositions separate.
