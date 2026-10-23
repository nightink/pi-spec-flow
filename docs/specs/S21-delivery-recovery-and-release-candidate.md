---
id: S21
title: 交付摩擦恢复、可追溯诊断与 0.4.0 发布候选
kind: spec
author: agent
status: in-progress
created: '2026-10-23'
review:
  decision: approved
  by: parent-after-user-proposal-and-release-preparation-authorization
  at: '2026-10-23'
evidence:
  e2e:
    - e2e-delivery-recovery.mjs
  migrations: []
  human: []
template:
  version: 2
  sha256: 358de590b6ba9668445b5880a12561216ed9e9d215c4a07d6b3ddfc1ab92accf
deps: []
review_inputs:
  context_files:
    - action.yml
    - packages/pi/index.ts
    - packages/core/src/review-worker.mjs
    - packages/core/src/review-storage.mjs
    - package.json
workflow_version: 2
impl:
  base_sha: 96dde2bcbae652120d50332a498a4ed2e49607ec
  at: '2026-10-23T11:55:56.603Z'
  pass: true
  required_gates:
    - check
  gates:
    check:
      pass: true
      command:
        file: npm
        args:
          - run
          - check
      bytes: 35483
      output_sha256: fabf0fc0e59fdb0192f4508717857b5705ce188a8303162c45144304a2abb6c0
      head: |-
        > pi-spec-flow@0.4.0 check
        > npm run typecheck && npm run lint && npm test && node tests/e2e/e2e-commit-gate.mjs && node tests/e2e/e2e-trustworthy-closure.mjs && node tests/e2e/e2e-spec-discovery.mjs && node tests/e2e/e2e-project-governance-profile.mjs && node tests/e2e/e2e-private-action.mjs && node tests/e2e/e2e-worktrees-python.mjs && node tests/e2e/e2e-review-and-spec-new.mjs && node tests/e2e/e2e-review-execution.mjs && node tests/e2e/e2e-review-repair.mjs && node tests/e2e/e2e-review-coverage.mjs && node tests/e2e/e2e-review-limits.mjs && node tests/e2e/e2e-agent-workflow.mjs && node tests/e2e/e2e-monorepo-packages.mjs && node tests/e2e/e2e-delivery-recovery.mjs && node packages/core/src/core.mjs check --ci --contracts-only
        > pi-spec-flow@0.4.0 typecheck
        > node --check packages/core/src/core.mjs && node --check packages/core/src/review-engine.mjs && node --check packages/core/src/review-coverage.mjs && node --check packages/core/src/review-execution.mjs && node --check packages/core/src/review-limits.mjs && node --check packages/core/src/review-context.mjs && node --check packages/core/src/engine-identity.mjs && node --check packages/core/src/evidence-capture.mjs && node --check packages/core/src/snapshot-manifest.mjs && node --check packages/core/src/workflow-diagnostics.mjs && node --check packages/core/src/review-executor.mjs && node --check packages/core/src/executors/pi-cli.mjs && node --check packages/core/src/review-storage.mjs && node --check packages/core/src/review-worker.mjs && node --check packages/core/src/project-profile.mjs && node --check packages/core/src/workspace.mjs && node --check packages/core/src/spec-creation.mjs && node --check packages/pi/index.ts && node --check packages/pi/adapter-core.mjs
        > pi-spec-flow@0.4.0 lint
      tail: |-
        PASS exact Action change script still rejects a real product gate failure; hosted execution not claimed
        ⚠️ 警告:
          ! S1.1: legacy done spec，仅做只读兼容
          ! 仅校验 Spec 合同/证据；项目门禁未运行（contracts-only）
        ✅ check --ci --contracts-only 通过（项目门禁未运行）
  e2e:
    e2e-delivery-recovery.mjs:
      pass: true
      passCount: 5
      failCount: 0
      tail: |
        PASS stale repair can be checked but never closed
        PASS protocol error remains an error with unverified raw observations while repairs stay reachable
        PASS CLI capture preserves a real failed process without changing Spec or audit budget or certifying history
        PASS exact Action change script still rejects a real product gate failure; hosted execution not claimed
  migrations:
    pass: true
    checked: []
    problems: []
  snapshot_hash: 69d5b7ad54f09c1e00c007b723ff9d1f64c18b0a9638a875b2e3c5ee57c645f7
  contract_hash: 890eb2db34fb6830e8713bcbb651a74630b824c074b884a28b81387062f94252
  diagnostics: []
  snapshot_manifest:
    version: 1
    sha256: fe23661d75cb16385b9f7a149331932718badc2cfaa0938bcde6427a69f519e8
    file_count: 273
  engine:
    package: '@nightink/spec-flow-core'
    version: 0.4.0
    source_sha256: 91015a4c32e9aba6788b379a9fe6aa42e784bf80c165a8cea5cc5fbbb736787a
    loaded_at: '2026-10-23T11:53:01.943Z'
    measurement: core source bytes at module initialization; not hot-reload evidence
---

- 状态：进行中

# 交付摩擦恢复、可追溯诊断与 0.4.0 发布候选

## Outcome

- A1–A5：消除 CLI 预算、修复提交、context 诊断和限额的确定性阻塞；不放宽 done。
- A6–A9：分开协议状态与待核实发现，记录实际运行身份、快照漂移和测试采集事实。
- A10–A12：完成 core npm / Git Action 本地发布候选、离仓安装验证与可重复发布步骤，只把远端发布留给用户。

## Non-goals and safety boundaries

- 不调用新增付费审查、不伪造 proposal/audit PASS、不关闭缺乏独立 PASS 的 S2.2 或本 Spec；本地候选与 lifecycle done 分开报告。
- 不自动 push、publish、打远端 tag、改调用方仓库或重启 Pi；不默认排除已跟踪构建产物。
- 不将 330 units 宣称为模型容量阈值，不做无原始证据支持的审查分片；不把失败测试采集冒充历史 red-first。

## Design

- D1→A1：audit CLI 增加 --budget，与既有预算环境变量及 native 行为一致；prepare 携带预算、重复/非法参数在封存及计费前拒绝。
- D2→A2：新增显式 check --ci --for-change 与 verify --for-change。仅 active 的未通过/过期状态作为警告；结构、审批、证据收据完整性、done 声明与产品门禁仍阻断。默认 strict 和 done 保持原语义，Action 通过枚举输入显式选择。
- D3→A3–A5：review_inputs.context_limits 在批准合同内配置 max_files/max_file_bytes/max_total_bytes；默认 20/65536/131072，上限 100/1048576/8388608，严格正整数且单文件≤总量。封存合同决定保留 job 的策略，不读取后来环境；不扩大其他 blob/raw/index 限额。context 错误包含相对路径、原因、数量/字节及超额，UTF-8 异常包含 0-based 字节偏移，不输出正文；current 与 committed 来源语义明确。
- D4→A6：outputInfo 增加 rawCounts 与带来源的未验证 observations；区分零 criteria、无类型 criteria、协议错误，不改 raw/result/预算，不把 observations 认定为产品缺陷。提供源单元期望/实际计数、解码路径与真实 stop reason/usage（未知明确 null），不猜模型容量。
- D5→A7–A8：提供进程启动期 engine 身份（版本、核心模块指纹）；新 impl 私有封存逐文件快照清单，漂移只报告相对路径和变化类型，旧 impl 无清单回退说明。保留当前快照与 ignore/hash 语义，不把清单缺失变成通过。
- D6→A9：CLI 显式 capture 命令以 argv 执行测试，独占写入普通 JSON 证据，绑定真实时间、HEAD/前后快照、命令、退出状态及完整有界输出。非零不是自动证明回归；observation/historical-replay/mutation 为显式声明而非历史认证。超时、截断、运行中漂移不算预期结果满足，禁止覆盖/越界/链接输出，敏感输出拒绝写入交付文件。
- D7→A10–A12：升级 root/core/private Pi adapter 与锁文件到 0.4.0；同步 CLI/native schema/README/skill/Action。生成 core tarball、离开源码目录安装运行 CLI；固定发布说明、SHA/完整性清单与 npm/Git Action 发布步骤。保留原反馈及核实处置，不宣称远端 CI/registry 更新已完成。

## Ordered implementation plan

1. 建立本合同、父级核对前述提案及用户继续实施授权；记录无新增付费预算，完成免费回归基线。
2. 先实现 CLI 与 change-check，再实现 context 策略/诊断、协议可观测性与真实身份。
3. 实现快照漂移定位和独立证据采集，同步真实入口、负向测试与文档。
4. 升级版本并完成完整 check、真实 Pi 离线 smoke、真实 CLI/Action 等价路径与离仓 tarball 安装。
5. 秘密扫描、归档父级验收与发布清单、本地提交；远端 npm/Git/Action 发布留给用户，不篡改既有独立审查事实。

## Executable acceptance

- [x] [A1] 真实 CLI audit --budget 将现有 grant 传入一次合成 worker；重复参数、空值/非法 ID、prepare+budget 在 job/预算/Spec 变化前拒绝；环境回退兼容。
- [x] [A2] 真实 CLI 与 Action 等价路径：active 的 FAIL/protocol-error/stale 可在 --for-change 下提交修复且留下警告；默认 strict、done、伪造 PASS/收据篡改、非法合同及真实项目门禁失败仍拒绝；检查不删除/改写历史。
- [x] [A3] current full audit 接受未进 HEAD 的未忽略普通文件；ignored/missing/symlink/nonregular/committed-head-missing 各给准确路径与原因，无外部文件读取。
- [x] [A4] context 数量、单文件/总量超限及非法 UTF-8 用可复算数据定位；0-based 字节偏移按原始 UTF-8 字节定义；不回显文件正文，不静默截断/删源。
- [x] [A5] 默认、合法扩展（>20 文件/>128KiB）、边界/非法配置、已封存重放及 tamper 拒绝覆盖 proposal/committed/full-current 入口；prepare 零模型，fake worker 不代表语义审查。
- [x] [A6] 保留 raw criteria 非空但 kind 缺失、零 criteria、合法 FAIL、协议错误附候选发现、330-unit 合成响应等回归；计数/来源明确，不改原 verdict、不制造语义 PASS，不伪称模型容量。
- [x] [A7] CLI 与 native 返回可比对的版本和启动期代码指纹；进程启动后磁盘变更不被误称已热重载；解码遥测区分执行完成与有效审查。
- [x] [A8] 新 impl 后修改/新增/删除/执行位变化可报告具体相对路径；未跟踪 ignored 构建产物不漂移，已跟踪产物仍漂移；legacy 无清单安全回退，私有清单篡改不能改变通过判断。
- [x] [A9] 真实子进程 capture 预期红/绿、预期不匹配、超时/截断/树变化、unsafe/重复输出及秘密命中可复现；证据独占落盘，无 lifecycle/audit/预算改写，不自称历史 red-first。
- [x] [A10] npm run check 与实际 Pi SDK 离线 smoke 通过；CLI/native/schema/README/skill/Action 参数和恢复语义一致；原报告逐条有处置与范围边界。
- [x] [A11] 0.4.0 core tarball 在源码外临时目录离线安装，bin/exports/依赖完整；包与发布清单通过敏感信息扫描，private root/Pi adapter 不误发布。
- [x] [A12] 本地提交与 task-clean 状态、门禁日志和可复算包完整性归档；只剩明确的远端发布步骤，原独立 FAIL/预算耗尽、尚无新独立 PASS 与 lifecycle 未 done 如实保留。

## Coverage and review inputs

Before approval, link every normative Outcome/Design promise to numbered acceptance and its implementation slice. Split compound observable dimensions; state units, aggregation semantics, boundaries and positive/negative examples for numeric claims. A helper's capability does not prove that the actual entry calls it; include the entry and unchanged baseline when needed. Missing context is not proof of disconnection.

Optional contract frontmatter `review_inputs` may declare `context_files` (explicit target-repository relative ordinary files) and `proposal_reviews` (retained same-Spec proposal job IDs). It participates in contract hashing: declare inputs before impl. No automatic repository crawling, cross-repository reads, execution, or imported approval. New packets bind the whole Markdown source inventory and require every source ID to be accounted for; references alone do not prove semantic completeness.

## Evidence boundary

Declare real gates, isolated E2E/migration/human evidence before implementation. Separate source binding, mechanical accounting, static judgment, recorded execution and final delivery. Runtime/remote/human facts may be visibly deferred, but required recorded evidence must still be current and bound; static wiring defects cannot be deferred as runtime facts. A generated draft, mechanical mapping or static PASS is not proposal approval, runtime acceptance or completed delivery.

## Review 与决策

2026-10-23 用户在前述三批处置方案后明确要求「继续推进……都推进待发布阶段……只剩推包 发布 action」。父级据此批准实施与本地发布准备；此审批不是独立审查 PASS。原 3 次独立审查预算已用尽，不新建/重置预算、不调用 provider。草稿依赖校正：本工作基于 96dde2b 已存在的 S2.2 代码候选，引用其事实但不依赖它已宣告 done；因此不设置要求前项 done 的 lifecycle deps。S2.2 与本 Spec 的独立审查欠账继续可见，不转写成已完成。

父级提案检查：保持默认 strict/done；显式 change 模式只处理修复提交的可达性，不豁免完整性；context 策略放入合同而非运行时环境，避免缓存重解释；新采集仅记录真实执行，不替代 red-first；330 单元只做机械回归，不外推模型能力。A1–A12 对应 D1–D7 的公开入口与负向边界。本文件的 ordered plan 是持久实施计划。

基线复现：`/tmp/specflow-kite-feedback-probe.mjs` 在 96dde2b 的隔离仓库验证 CLI 缺参数、active FAIL 拦 check、未提交 context 可用、ignore 生效、四种 context 诊断不足、330 单元解析及缺 kind 计数歧义；零 provider。原反馈不改写，处置另附记录。
