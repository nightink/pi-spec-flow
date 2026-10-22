# S2.2 实施与验收计划

## 授权与边界

用户已明确要求 deepseek-flash fork worker 实现、父 Agent 验收并推进收敛，最终本地提交。2026-10-22 问卷另明确允许：核对后仅清理三条 prunable Git worktree 注册元数据；本轮最多三次可能计费的 deepseek-flash 独立审查。不得自动重置预算、补失败次数、push、安装或重启宿主。真实预算与 packet/raw 存私有 Git common-dir，不提交公开日志或凭证。

正式合同：`docs/specs/S2.2-review-limits-and-agent-usability.md`。基线：`c47aa868eea75b9b2dbeb83c1bce21e3f4f3fb85`。旧 S1.7/S2.1 done 证据不作新源码验收。原 parent review/probe 留在 `docs/reviews/workflow-review-20261022/`，pre-fix probe 的“问题存在”断言不是修复后的门禁。

## 顺序与文件所有权

1. 完成固定模板正式创建、合同公共入口定义、付费提案审查、父级确认处置与 begin。
2. 并行实现（同 checkout、严格不重叠文件；worker 不提交、不改真实 Spec/预算）：
   - Worker A：`review-limits.mjs`（新）、`review-engine.mjs`、`review-worker.mjs`、大包单测与 `e2e-review-limits.mjs`。A1–A5。
   - Worker B：`core.mjs` 的 full audit prepare、结构化 outcome、board 与 CLI、相关单测及 `e2e-agent-workflow.mjs`。A6–A8；对接 A 的 `resolveReviewLimit(maxBytes,env)`。
   - Worker C：`packages/pi/index.ts`、`adapter-core.mjs`、Pi adapter 测试与 smoke、README/core README/skill 同步。A6–A10 的真实入口和显示路径。
   - Parent：`workspace.mjs` 与 worktree 诊断回归（A12）、package scripts 集成、所有共享接口冲突修复、最终验收和审查处置。不得以重跑一个 worker 的测试替代父级集成验收。
3. 父级逐项读 diff，运行完整权威 `npm run check`、大包真实 worker/CLI E2E 与实际已安装 Pi SDK 的无网络 smoke；失败从根因修正，不能删/降低断言。
4. 形成精确候选版本，做 full-current 独立审查（第二次授权调用）；核对每个源块/criterion/major 的语义映射，必要时用第三次作修复后的完整复审，不把 delta PASS 当 full audit。
5. 运行稳定 gates/真实验收，扫描交付物，更新证据与正常生命周期，提交明确任务路径。未完成的步骤或真实阻塞必须诚实保留。

## 集成接口

共享限额接口、prepareAudit/implOutcome/auditOutcome/inspectBoard、native 参数与 CLI 形式以合同的 Public entry contract 为准。跨 worker 只读别人的文件；若接口缺失先提交可独立运行的单元路径和明确依赖，不覆盖别人的修改。错误必须保留稳定 code/category 与诊断数据，不能仅靠文案反推状态。

## 逐项验证要求

- A1–A5：完整 prompt 的精确 UTF-8 边界、所有 mode 的 >512 KiB fake-worker 路径、旧 job、配置变动、metadata 与 packet 绑定、分项字节、计费前拒绝。
- A6：公开 CLI/native prepare 零调用/零计次/Spec+ledger 不变；同 job 执行/附加与中间漂移拒绝。
- A7：真实进程退出码 + native isError/structuredContent，不以绿色调用返回冒充产品通过。
- A8：默认 record-only 显式，live 避免 stale 实现误导 done；审批/人工阻塞不伪造可执行授权。
- A9：真实长 receipt 经模型可见文本仍可找到完整恢复入口；结构化完整结果未损失。
- A10：入口 schema/文档/skill 同步，核心公开文本 API 兼容。
- A11：全量权威 check 与实际 Pi offline smoke，保留证据边界，不把机械模型 fixture 当独立 review。
- A12：不可用/prunable 成员诊断、编号不变、dryRun 可用、无自动清理。

## 状态

- 注册元数据清理和正式 Spec 创建已完成；未删除用户目录或文件。
- 独立 proposal 第一调用已完成：coverage-gap（不是产品缺陷），父级确认 C9–C16 共八项验收补强，涵盖原11条gap；全部补入 A1/A3/A5/A6/A7/A8/A10/A12，原报告通过 proposal_reviews 保留。
- 用户已批准实施；父级批准修订后方案，正常 spec_begin 已运行，S2.2 为 in-progress。
- 三个实现 worker 使用 deepseek/deepseek-flash；父级独占 worktree 诊断与最终集成验收。
- 独立调用 2/3（full-current-audit，job `e0fc66d2…`）原 verdict FAIL：C10/C11/C12 已确认并修复（core README happy path/恢复表、失败信封 schema、门禁证据 command/head/tail/digest），无产品 findings。
- 详细命令、数字、审查与处置记录：`docs/reviews/S2.2/validation.md`；复审前不宣称 PASS，闭环状态以 Spec 记录为准。
