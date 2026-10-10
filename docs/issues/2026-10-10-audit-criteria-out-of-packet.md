# Audit criteria 会把运行时/跨仓库事实列为判据，导致多仓库调用方结构性不可达 pass

- Status: resolved by S1.7 parent-only maintenance; no new independent review of this repair code.
- Governing contract: `docs/specs/S1.7-unified-review-and-spec-creation.md`（统一审查引擎/审计 prompt 的归母 Spec）。
- Baseline: `1d3d259` (`fix(gates): 门禁超时可配`), i.e. `origin/main` at the time of the fix.
- Upstream report: GitHub issue #2（由另一个调用方项目在 5 次送审后归纳；本记录不复制其私有 packet）。

## Reproduction

调用方（实现跨仓库、把远端 CI 与人工验收写进验收清单）的 `spec_audit` 第 5 次送审得到
`3 pass / 4 unverifiable / 0 fail` ⇒ verdict fail。4 个 `unverifiable` 中有 3 个**原理上无法由本地静态审计满足**：
外部 Action 是否真的跑了 `check`/`npm run verify`、独立仓库引擎的 strict-parse/parity 矩阵、
Node 22 全量 verify 与远端 CI + 人工 R1（审计**已读到** run 记录与 R1 原文，仍判 unverifiable）。
第 4 次送审的 criteria 集合与第 5 次毫无重合 ⇒ 判据由模型按送审内容自行生成。

fail-closed 规则叠加后形成闭环：任一 `fail`/`unverifiable` criterion ⇒ `verdict=fail`（`review-engine.mjs` 的
prompt：`Any failing/unverifiable criterion requires verdict fail`）⇒ `spec_attest`（要求
`audit.verdict === 'pass'`）与 `spec_done`（`recordConsistencyGaps`）同时锁死。

本仓库以确定性方式复现了同一层的两条事实（不需要真实模型）：

1. 修复前基线 `1d3d259` 的封存 packet（prompt v4）**没有任何判据可采性约束**：既没有要求 criteria 只能由 packet 内证据判定，
   也没有把运行时/跨仓库/人工事实指向 `out_of_scope`；同时 `out_of_scope` 只存在于结果 schema，
   既不进入 Spec `audit` 记录、也不在任何输出里显示。
2. 运行时专用判据一旦标成 `unverifiable`/留空 criteria，归一化与生命周期仍然 fail：
   `docs/reviews/S1.7/criteria-admissibility/pre-fix.log`（5 个新增/更新回归在基线 `1d3d259` 上失败）。

## Root cause

设计意图是「运行时证据与静态评审分离」，但这句只写在 prompt 的**总则**里，没有在**判据生成阶段**执行：

- 没有禁止把运行时/跨仓库/人工事实**列为 criterion**；
- 没有给出这类验收条目的替代落点（`out_of_scope` 未定义类型/理由，且落地后不可见）；
- 于是「静态审计 + 任一无解 ⇒ fail」⇒ 只要契约含运行时/跨仓库验收项，静态审计必然 fail。

附带的可观测性缺陷：模型即使把事实放进 `out_of_scope`，core 的 `normalizeAuditResult` 只保留
`verdict/criteria/scope_deviations`，该字段被静默丢弃，调用方看不到"哪些验收被延后、为什么"。

## Repair

选择 issue 建议 1（prompt 侧最小改动），并补上"延后可见"和"fail-closed 不变"两块：

- `review-engine.mjs`：prompt 从 v4 升到 **v5**（`REVIEW_PROMPT_VERSION`，结果协议仍为 2），新增
  `Criteria admissibility` 段：criterion 必须仅凭封存 packet 判定；运行时/远端 CI/其他仓库/人工事实**不得**作为
  criterion，合同里的这类验收只判 packet 内记录证据的存在、时效与绑定，残余事实写入
  `out_of_scope`（理由 `runtime|remote|cross-repository|attestation-deferred`）；超出 bindings 覆盖范围的条目
  同样进 `out_of_scope`；`unverifiable` 仅保留给 packet 内真正有歧义/矛盾的证据，必需记录证据缺失或未绑定一律 `fail`；
  可静态判定的验收条目仍必须作为 criterion。`out_of_scope` 增加 string[]/限额说明。
- `core.mjs`：`AUDIT_PROMPT_VERSION` 同步到 5；审计摘要新增「范围外」区块；非空的
  `out_of_scope` 写入 Spec `audit.out_of_scope`（`deferredScopeNotes`：string 保留、其他类型 JSON 无损化、
  100 项 × 5000 字符上限）。**空数组不写字段**，因此历史记录字节与 `result_sha256` 保持不变
  （旧记录不回算、不重写，`assertRetainedAuditEvidence` 语义不变）。

未采用 issue 建议 2/3（契约声明 `acceptance_deferred`、只审 delta 的新模式）：两者都要改 profile/校验层或
引入新结果协议，而合同正文的验收项是散文（`## Executable acceptance` 之外无稳定 ID），无法在不改协议的前提下
做确定性推导。当前改动把"可静态判定"与"运行时/人工覆盖"分层，已消除闭环，同时不新增 fail-open 面。

## Acceptance and limits

- 新增/更新回归（基线 `1d3d259` 上 5 个失败，修复后全绿）：`docs/reviews/S1.7/criteria-admissibility/pre-fix.log` 与
  `targeted.log`（120/120）。
  - 延后项可见且 PASS 可达：使用 fake auditor 产出「记录证据存在且绑定」criterion + 3 条
    runtime/remote/human 延后项 ⇒ audit PASS、`audit.out_of_scope` 持久化、摘要显示「范围外」、随后
    `spec_attest`/`spec_done` 可用（端到端生命周期）。
  - fail-closed 不变：同一场景下把运行时事实标成 `unverifiable` ⇒ audit FAIL、`spec_attest` 拒绝；
    criteria 为空 + `out_of_scope` 全是延后项 ⇒ verdict 仍为 fail。
  - packet 断言：sealed packet 含 `Criteria admissibility`、`MUST NOT be criteria`、`attestation-deferred`、
    `out_of_scope MUST be string[]`，且 `prompt_version === 5`（proposal 与 working-tree-audit 两条路径）。
- 全量门禁：`npm run check` = typecheck + eslint + 198/198 单测 + 10 组真实 E2E + `check --ci --contracts-only` 通过
  （`full-check.log`）。私有 Pi smoke 全绿、三种 provider 序列化 0 次 HTTP（`pi-smoke.log`）。
- 边界（不夸大）：本机没有 Node 22 运行时，门禁在 **Node v24.19.0** 上执行（`engines >=22.19.0`）；
  宿主 PATH 无 `pi`，smoke 使用显式可信 shim + `SPECFLOW_PI_SDK`。**没有真实模型审计**（无付费授权），
  因此"模型是否遵从新规则"只有 prompt 内容断言与确定性分层回归，没有真实 provider 证据；
  旧 job/packet/raw/receipt/预算未改动，也未被这次语义更新回算。真实跨仓库调用方的五连送审未被重放。
- 未做：不改 result protocol、不改 `normalizeAuditResult` 输出形状、不新增 profile 字段、不触碰历史 Spec 的
  `impl/audit/attestations`、不 push/deploy。

Evidence: `docs/reviews/S1.7/criteria-admissibility/`.
