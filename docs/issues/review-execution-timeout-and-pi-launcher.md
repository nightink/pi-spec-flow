# 已修复（parent-only）：复用 review job 的 timeout 语义与共享 Pi 启动入口

| 项 | 值 |
|---|---|
| 来源 | 用户反馈：复用 job 时不刷新 timeout；宿主 PATH 无 pi 时，review 与 audit 一样需要 shim，目前只有 caller 的 spec:audit 脚本处理 |
| 归母 | [S1.7 — Unified review and Spec creation](../specs/S1.7-unified-review-and-spec-creation.md)，共享 review/audit executor |
| 状态 | **Resolved / parent-only**；代码、回归和真实隔离验收通过，未独立审查 |
| 范围 | 执行参数生效、复用诊断、可信审计可执行文件的配置与就绪检查 |

本记录是归母缺陷和验收档案，不是新的 governing contract，也不改写已关闭 Spec 的历史证据。施工前已在 S1.7 的 Review 与决策 maintenance 区记录 parent-approved 计划及用户 B 选择。修复不改 example-app 文件、不借用旧授权、不重启生产；原 done/audit 只代表历史 endpoint。

## 1. 复用 job 后调整 timeout 不生效

### 反馈与代码核对

用户报告：提高 timeout 后复用原 job，仍沿用原超时设置。尚未提供现场 job ID、状态、引擎版本及 requested/effective timeout，不能把所有复用场景归为同一个缺陷。

登记时 baseline `2164ffb` 的 `review-engine.mjs:308–330` 行为：

- `prepared` 首次执行时读取当前 `SPECFLOW_AUDIT_TIMEOUT`，验证后写入 `job.execution.timeout`；默认 180000 ms，上限 1800000 ms。因此当前代码并非在 prepare 时就冻结 timeout。
- `running` 或 `completed/failed/cancelled/skipped` 会提前返回，不重新读取执行参数。
- `review-worker.mjs:28–35` 使用保存的 `job.execution.timeout` 创建子进程计时器。更改后续 frontend 的环境不会改变已运行 worker 的计时器。
- lifecycle audit 在 `core.mjs:2061–2082` 通过保存的 job ID 复用同一 executor，因此 review/audit 都受此语义影响。

### 待解决要求

1. 在复用入口明确提示 job 状态、实际 timeout，以及当前请求参数是否被忽略；区分「等待既有执行」「返回既有结果」与「启动一次新执行」。
2. 用现场 job 确认：是运行中/终态复用的参数反馈不足，还是未启动的 prepared job 存在 stale timeout。后者若出现，应按实际版本单独定位。
3. 若需要更长 timeout 的新调用，应明确创建新的执行/job 并消耗同一适用授权；不得偷偷重启旧 job、删除历史证据、退款或重置额度。
4. 不通过改写 receipt 的 timeout 假装改变运行中 worker；已执行 job 的参数仍是原始 provenance。

### 后续机械回归

用无 provider 的 fake executor 覆盖：prepare 后改变 timeout 再首次 run；running 时以新 timeout 复用；completed/failed/cancelled 重放；确需新执行时的明确计次。断言生效参数、诊断、spawn 次数与预算一致。登记时尚未执行；本次实际结果见下方验收。

## 2. 宿主 PATH 无 pi 时，review 缺少 audit wrapper 的 shim 支持

### 反馈与代码核对

- 共享 executor 在 `review-engine.mjs:325` 选择 `SPECFLOW_AUDIT_BIN || "pi"`；review 与 audit 本身都支持这个显式 bin 配置。
- worker 继承启动进程环境，并通过该 bin 启动子进程。若宿主 PATH 不含 pi 且未显式设置 bin，则启动无法解析该命令；交互 shell 能运行 pi/npx 不证明宿主 worker 能运行。
- 只读查看 example-app：`package.json` 的 `spec:audit` 指向 `scripts/spec-flow-audit.mjs`。该脚本用项目已安装的 Pi CLI 与 `process.execPath` 生成 `output/.spec-flow-bin/pi`，先做版本探测，再将 shim 的路径通过 `SPECFLOW_AUDIT_BIN` 传给 audit。脚本目前只封装 audit，没有对应 review 路由。
- 所以缺口是可信 launcher 的复用与入口配置，不是 review 完全不支持 shim。上述 caller 文件未被修改或执行；未检查生产 PATH、凭据或 agent sessions。

### 待解决要求

1. review/audit 共用一处可信 launcher 配置/包装，显式传递同一个已选定的 bin；短期 review 可直接配置既有 shim 的绝对路径。
2. 在 budget charge 前检查选定可执行文件的就绪性，给出缺失文件、无执行权限或 PATH 解析失败的可操作错误。目前 reserveReviewCall 先于 worker 的实际子进程启动，缺失 pi 可在已计预算后才报错；后续修复不追溯退款既有调用。
3. 不自动安装 Pi、不从 npx 缓存猜版本、不修改全局 PATH、不重启 daemon，也不自动执行未受信目标项目中的 launcher；探测只针对显式选择的可信入口。
4. 保留显式 bin override 与原始执行参数，确保 shim 转发 argv/@file 不变、packet/child bytes 与隔离 flags 仍一致。

### 后续机械回归

在临时 fixture 中移除 PATH 的 pi，验证 review/audit 使用显式可信 shim 均可启动 fake executor；缺失 bin 的 preflight 不 spawn、不计预算；覆盖空格路径、argv/@file 转发和重复 entry 不二次调用。登记时尚未执行；本次实际结果见下方验收。

## 本次边界

首次登记仅做静态核对；该阶段没有运行门禁或模型。后续用户明确要求处理并选择 B，允许本地修复、机械回归及真实隔离验收，不授权独立模型审查。本次不新建真实 grant、不改既有 job/预算、不修改远端或生产；执行结果在下方单独归档，不能把旧静态核对或假审计 verdict 称为本次独立 PASS。

## 实际修复与验收

- `review-execution.mjs` 为 review/audit 提供同一份参数读取、filesystem launcher preflight 和复用说明。prepared 首次 run 使用当前 timeout；running/终态参数不改写，明确返回 executionInfo 和 ignored/new-job 提示。实际 timeout 保留非通过原因及原时长。
- `SPECFLOW_AUDIT_BIN`（可信既有 shim）优先；未设置时可通过 `SPECFLOW_PI_CLI` 指定已安装的可信绝对 CLI 路径，由当前 Node 直接启动，不需要 PATH pi 或生成 shim。缺失/权限错误和非法 timeout 在计次前失败。
- Node22 targeted **31/31 PASS**（含 8 项新增回归）；真实独立 CLI 进程 **3 PASS**；完整 `npm run check` **169/169 units + 八组 E2E** 通过；实际隔离 Pi CLI/SDK smoke 通过，无 provider 调用。
- 归档：[S1.7 execution-fix validation](../reviews/S1.7/execution-fix/validation.md)，含 pre-fix 原失败、最终日志、13 份 changed-product source hashes 及 parent 核验；夹具开发失误单独留档，不算产品复现。
- 用户选 B，**未独立审查**；不新建真实授权、不重跑母 Spec lifecycle、不改其原 frontmatter/audit/semantic contract。当前旧 done 仅代表历史 endpoint。未 push、发布、重启或修改 example-app。
