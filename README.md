# spec-flow

Pi 的证据绑定 spec 工作流扩展。它把 `begin → impl → audit → attest → done` 做成可检查的状态机，并在提交前运行项目门禁。

> 这不是安全沙箱或不可篡改账本。拥有仓库写权限的人仍可直接改 YAML/ledger；`SPECFLOW_BYPASS=1` 也保留为显式逃生口。

## 要求与安装

- 扩展/CLI 自身运行需要 Node.js `>=22.19.0`，**被管理项目不限 JS/TS**
- Git（worktree 协调使用 `--path-format=absolute`）
- 本仓库全量自测还需要 Python 3；不会自动 pip/uv/npm 安装被管理项目的依赖
- 当前支持并在 macOS/Linux 验证；Windows 不是本版本的保证范围

`package.json#pi` 声明 `index.ts` 扩展入口与 `skills/` 目录，仓库公开并通过 Pi 的 git 包机制安装（扩展与 skill 随包一起加载）：

```bash
pi install git:github.com/nightink/pi-spec-flow   # 可加 @<tag-or-commit> 固定版本
pi list                                           # 确认包已注册
pi update --extensions                            # 按配置的 ref 更新
```

本地开发/自测直接使用源码仓库，不改变安装方式：

```bash
git clone https://github.com/nightink/pi-spec-flow.git
cd pi-spec-flow
npm ci
npm run check
```

静态声明不等于当前宿主已加载或工具可调用。Pi 1.x 支持本版本的 typed/structured 新工具；安装或修改后现有会话需要 `/reload`，不要为此自动重启生产进程。

## 项目约定

默认无需配置文件。已有项目若使用不同的 spec metadata/status，可以显式提供严格的 `.spec-flow.json` project governance profile；不会读取 `specflow.json` 或执行动态配置代码。

| 路径/字段 | 行为 |
|---|---|
| `docs/specs/*.md`、`docs/spec/*.md`、`specs/*.md`、`spec/*.md` | 扫描这些显式目录中的 spec；目录可单复数，直接合并，不递归其他路径 |
| `.spec-flow.json` | 可选的 v1 project governance profile；普通非 symlink 文件、严格 schema、非法时 fail closed |
| `.spec-flow.json#gates.commands` | 显式 argv 门禁，适用于 Python/Go/Rust/Make 等，不要求 package.json |
| `pytest.ini` / `pyproject.toml#[tool.pytest.ini_options]` | 保守探测 `python3 -m pytest -q`，优先当前 worktree 的 `.venv/bin/python` |
| `package.json#scripts.typecheck` | 默认 profile 下的 `npm run typecheck` 门禁 |
| `package.json#scripts.test` | Vitest 或通用 `npm test` 门禁 |
| `biome.json` | `npx --no-install biome check .` 门禁 |
| `tests/e2e/e2e-*.mjs` | 可声明的 E2E evidence |
| `packages/db/src/migrations/NNN*.ts` | 可声明的 migration evidence |
| `.spec-flow-ledger.jsonl` | 本地追加式生命周期/绕过记录 |

E2E evidence 只能填写 `e2e-*.mjs` basename（可省略 `.mjs`），不能包含目录或符号链接。每个脚本必须退出 0、至少输出一行行首 `PASS `，且不能输出行首 `FAIL `。

### Project governance profile（可选）

Profile 用于渐进接入已有本地治理，不会把项目强制迁到 spec-flow 的默认字段。v1 示例：

```json
{
  "version": 1,
  "lifecycle": {
    "preReview": ["draft", "in-review"],
    "startable": ["approved"],
    "active": "in-progress",
    "done": "done",
    "ignored": ["archived"],
    "dependenciesField": "depends_on",
    "updatedField": "updated",
    "bodyStatusLine": false,
    "legacyActive": "external-warning",
    "externalActiveIds": ["7", "8"],
    "approval": {
      "reviewersField": "reviewers",
      "reviewedAtField": "reviewed_at",
      "minimumReviewers": 1,
      "placeholderReviewers": ["pending"]
    }
  },
  "gates": {
    "mode": "replace",
    "npmScripts": ["verify"]
  }
}
```

安全边界：`gates` 使用 `mode: "replace"`，必须二选一：当前 package.json 中存在的 `npmScripts`，或具名的 `commands` argv 数组。不使用隐式 shell、插值、动态配置/JS 插件；命令本身仍是**受信任的项目代码**，并非安全沙箱。未知键、保留/冲突字段、重复门禁名、状态角色重叠、脚本缺失、越界或 symlink 配置一律报错，不回退到较弱默认门禁。CLI 会非零退出，commit interceptor 会把配置错误作为红门禁（显式 `SPECFLOW_BYPASS=1` 仍可放行）。配置文件参与 implementation snapshot，验证后修改会使旧证据失效。

`external-warning` 只适用于 `externalActiveIds` 明确列出的历史 active spec；未列出的 legacy active 仍报错，不能通过删除 `workflow_version` 绕过 CI。workflow v2 active spec 始终执行完整闭环。profile 声明的 `updated/reviewers/reviewed_at` 等 lifecycle metadata 不扰动 contract hash，但 proposal approval 在后续阶段持续重验；依赖、目标、验收和 evidence 仍受绑定。Frontmatter 仍必须是 `js-yaml` 可解析的合法 YAML，profile 不提供宽松解析兜底。

可选 `validation`（仍为 v1 严格 schema）用于**替代**既有项目自己的元数据扫描器：

```json
"validation": {
  "requiredFields": ["id", "title", "kind", "status", "created", "updated", "author", "depends_on"],
  "kindField": "kind", "allowedKinds": ["spec", "plan", "analysis"],
  "numericFileId": true, "checkDoneCheckboxes": true,
  "forbidAddendumFilename": true, "dependencyIntegrity": true
}
```

仅配置此对象时生效；要求字段非空、种类合法、`N.*.md` 文件名前缀对应非负安全整数 ID、`done` 正文不能有行首未勾选项，禁止 addendum 文件，依赖必须是存在的非负整数 ID 且不可成环。这些检查作用于**所有** spec（包括 archived 和历史 active/done），不会被 legacy warning 跳过。未知键/非法类型会拒绝整个 profile。

Profile 的 `lifecycle` 和 `gates` 均可省略，分别沿用默认状态/审批语义和默认探测。配置项目的合同与实现须在**同一 checkout**；不要从 main 的 spec 填 `impl.repo: ../worktree`，而应 `cd` 到该 worktree 执行完整生命周期。无 profile 的历史外部 impl.repo 行为保留。

### Python / 通用命令配置

不需要 package.json，也不必复制 JS 项目的 lifecycle 字段：

```json
{
  "version": 1,
  "gates": {
    "mode": "replace",
    "commands": [
      { "name": "test", "argv": ["python3", "-m", "unittest", "discover", "-s", "tests"] }
    ]
  },
  "evidence": {
    "e2e": { "dir": "tests/e2e", "extension": ".py", "runner": ["python3"] },
    "migrations": { "dir": "migrations", "extensions": [".py", ".sql"] }
  }
}
```

也可明确配置 `.venv/bin/python -m pytest -q`、`uv run --no-sync pytest`、`make verify`、`cargo test` 等 argv；省略 evidence 时仍使用旧 JS/TS 路径。runner 最后追加已验证的 E2E 文件绝对路径；仍需退出 0、输出行首 `PASS ` 且无 `FAIL `。migration 只验证编号/文件，不推断 Alembic/Django/数据库执行。

门禁名必须安全且唯一；argv 非空、无 NUL/换行，首项是 PATH 名或项目相对执行路径（不能绝对/`..`/选项开头）。常见 venv 解释器 symlink 可用，但 **E2E 文件**必须普通非 symlink 文件，配置目录必须在 checkout 内。仅明确的 pytest 配置会自动探测；没有明确门禁的 Python 项目会要求配置，不会凭空跑 ruff/mypy 或安装工具。`impl` 没有门禁时不会通过。门禁生成的缓存/日志应 gitignore；门禁前后实现内容变化会记录 FAIL，生成 tracked 产物后需要重跑一次稳定验证。

## Workflow v2

spec-flow 会扫描 `docs/specs/`、`docs/spec/`、`specs/`、`spec/` 四个显式目录；多个目录同时存在时按稳定路径顺序合并，重复 ID 会在 CI 和生命周期操作中 fail closed。

`spec_begin` 会写入 `workflow_version: 2`，记录实现仓库的 `base_sha`，并清除旧 impl/audit/attestation。后续证据绑定两类 hash：

- **implementation snapshot**：实现仓库当前 tracked + untracked 内容、删除、可执行位与 submodule HEAD；排除 ledger 和当前 spec 文件。
- **contract hash**：spec 的目标、设计、验收、deps、scope、evidence 等合同内容；排除生命周期写回字段，并规范化 checklist/review 区域。

因此，代码或合同在验证后变化会让 audit/done 拒绝旧证据；仅把相同代码提交到 Git 不会使内容快照失效。

### Pi 工具

| 工具 | 作用 |
|---|---|
| `spec_board` | 当前 worktree 的状态、漂移和下一步 |
| `spec_alloc {prefix?}` | 在 Git common directory 原子预留编号，例如 prefix 为 `S1.` |
| `spec_new {title,…,dryRun?}` | 固定版本模板、共享编号、独占创建未批准 draft；预览不分配 |
| `spec_review {action,…}` | prepare/run/status/repair：只读项目审查与零调用协议修复；不写生命周期 |
| `spec_begin <id>` | 要求 review approved、deps done；进入 v2 in-progress |
| `spec_impl <id>` | 运行 required gates、逐项 E2E、migration 检查；写 `impl.pass` 与 snapshot |
| `spec_audit <id>` | 隔离子 Pi 审计完整 base→working-tree diff；写 criteria、hash、model、prompt version |
| `spec_attest <id> <item> <note>` | 仅在交互 UI 明确确认后登记人工 evidence |
| `spec_done <id>` | record-consistency + live snapshot 双重校验后进入 done |

Pi 的 begin/impl/audit/attest/done 仍使用 `withFileMutationQueue()`；核心还在 Git common directory 使用按 Spec ID 的跨进程锁，CLI/多 Pi 会话/多个 worktree 也受保护。冲突报 busy 并给 owner/锁路径，不静默覆盖；正常异常/取消释放锁，SIGKILL 等留下的锁**不会自动抢占**，须确认 owner 已退出后由用户清理。写回前重验 spec 文件，保留门禁期间的并发人工改动。工具失败通过 throw 呈现为真实错误，长输出会明确标记截断。

### 模型请求中的工具 schema

九个原生工具的输入 schema 均为显式 `type: "object"` 根节点；`spec_review` 不使用顶层 action union。模型请求会携带整个工具清单：一个声明不兼容可使**其他工具的请求**也在执行前被 HTTP 400 拒绝，不能只验工具注册或本地调用。

`spec_review` 缺省 action 为 prepare；run/status/repair 必须有 jobId，prepare-only 字段不能混入 run/status，budgetId 仅用于 run。平铺声明不取代共享引擎的逐 action 精确校验：非法字段/动作/ID 不被静默丢弃，不消耗授权或启动执行器。现有宿主与 executor 可能缓存旧声明；owner 需按实际加载机制 reload/rebind，源码修复不等于生产已采用，也不会自动重试原请求。

`smoke:pi` 使用实际已安装 Pi SDK，在 OpenAI Completions/Responses 与 Anthropic 的 onPayload 边界检查全部声明、随后中止并以 fetch guard 禁止发送。它是零 HTTP 的离线序列化验收，不是远端 provider 成功或独立模型审查。

### SDK / daemon 的可选通知

`ctx.hasUI` 不保证自定义宿主的每个 UI 方法都可调用。例如 class 型 UI 经对象展开包装后，原型上的 `notify` 可能丢失，但 `hasUI` 仍为 true。`spec_impl` 将门禁/诊断进度发送到工具 `onUpdate`，并仅在实际有 callable `notify` 时尝试通知。通知和进度传输失败只影响展示，不中断门禁、不改变 `impl.pass`；审计、提交拦截、命令和启动通知使用同一防护。真实核心异常仍传播，失败门禁仍阻止提交。

这不是自动补齐宿主全部 UI API，也不降低人工核验要求：`spec_attest` 仍需 callable `confirm` 和用户明确同意，缺少确认能力时拒绝且不写入。源码更新不等于运行中 daemon 已采用新版；宿主 owner 需按其加载机制 reload/rebind，spec-flow 不自动重启生产进程。

### 并行 Git worktree

```bash
cd /path/to/agent-worktree
node /path/to/spec-flow/core.mjs spec-alloc --prefix S1.  # 跨 worktree 预留 S1.N
node /path/to/spec-flow/core.mjs begin S1.N
node /path/to/spec-flow/core.mjs impl S1.N
node /path/to/spec-flow/core.mjs worktrees                 # 仓库家族看板 + 实时 freshness
node /path/to/spec-flow/core.mjs check --ci --contracts-only --live
```

每个 worktree 的 spec、门禁、ledger 和完整内容快照独立；main 的脏文件不影响隔离分支的证据。看板支持 detached checkout 和带空格路径。`spec-alloc` 从所有已注册 worktree 的 Spec/文件名及预留记录中取 PREFIX 命名空间的最大数字 + 1；删除 worktree 不回收编号。编号记录和锁位于 `.git` 的 common directory，不提交、不当作第二份合同；仅协调本机同一 Git 仓库，不保证手写编号、独立 clone/其他机器的唯一性。不可访问/非法 Spec 的 worktree 会阻止分配，避免猜测空闲编号。

合并后只有内容相同才可继续使用 hash-bound evidence；集成其他修改后在目标 checkout 重跑 impl/audit。`check --ci` 校验历史记录，`--live` 额外比对当前 **active** 的实现快照；done 历史不会与今天的代码比对。不能把普通 contracts-only 的绿灯当成合并后的实测通过。`/spec worktrees` 也可查看该看板。

### 人工核验

Pi 工具要求 `ctx.hasUI` 且用户在确认框中看到 item + note 后同意；无 UI 时拒绝。CLI `attest` 被视为用户在终端中的显式操作：

```bash
node core.mjs attest S3.13 R1 "在 staging 的设置页验证保存与刷新，样本账号 qa-17"
```

note 至少 20 个字符，并与当前 implementation/contract hash 绑定。

## TUI 与 CLI

```text
/spec          项目看板
/spec board    同上
/spec <id>     单个 spec 详情
/spec worktrees 同仓库全部 worktree 与 active 实时 freshness
/spec new <JSON> 固定模板草案/预览
/spec review <JSON> 封存审查 prepare/run/status
```

```bash
node core.mjs board
node core.mjs begin S3.13
node core.mjs impl S3.13
node core.mjs audit S3.13
node core.mjs attest S3.13 R1 "核验路径和样本（至少 20 字）"
node core.mjs done S3.13
node core.mjs migrate-alloc
node core.mjs spec-alloc --prefix S1.
node core.mjs worktrees
node core.mjs verify                     # Action 同款：配置门禁 / 旧 npm verify / 默认探测
node core.mjs check --ci
node core.mjs check --ci --contracts-only --live  # 不运行项目 gates，但比对 active 实时快照
```

## 固定模板 `spec_new`

```bash
node core.mjs spec-new --json '{"title":"Observable outcome","prefix":"S1.","slug":"feature","goals":["What works"],"nonGoals":["What is excluded"],"design":["Smallest complete design"],"plan":["First slice"],"acceptance":["Executable observable case"],"dryRun":true}'
```

同款 `/spec new <JSON>` 和 native tool。缺省语义项留下明确 TODO，不捏造要求或审批；默认 `draft` 是 preReview，旧 pending/startable 保留。新文件没有 impl/audit/attestations；完成合同并按项目规则批准、转为 startable 后才能 begin。新 Spec 会改变其他 active 的全仓快照，宜在 impl 前创建。

可选严格 `creation: {directory, template, defaults}`：目录仅四个扫描目录；未配置时零目录用 docs/specs，一个目录沿用，多个则拒绝。模板是 checkout 内 <=64 KiB 的非 symlink body-only Markdown，heading 开头，六个 literal slots 各一次：title/goals/non_goals/design/plan/acceptance；不执行 JS 或插值。安全 defaults 仅补项目允许的必需元数据（scalar/array），不能覆盖 ID/status/approval/evidence 等保留字段。缺失/无法填的必需字段或 custom lifecycle 无 preReview 时，在预留前失败。生成文件 <=256 KiB，记录模板版本/hash；结构化输入拒绝未知字段、路径/换行注入，永不覆盖；发布失败的编号仍烧掉。数字项目写 YAML integer 与 N.slug.md，prefixed 写 ID-slug.md。预览 ID 是示意值，不是预留。

## 统一封存审查与预算

```bash
# 仅在本 delivery cycle 得到用户授权后由终端/API 初始化；已用外部审查必须计入 used。
node core.mjs review-budget --json '{"id":"delivery-example-1","calls":3,"used":1,"note":"User explicitly authorized this delivery cycle; one external proposal call already used."}'
node core.mjs review --json '{"action":"prepare","id":"S1.7","base":"BASE_COMMIT","head":"HEAD_COMMIT"}'
# 检查输出 packetPath，对同一完整文件做 check_secrets；prepare 无模型调用。
node core.mjs review --json '{"action":"run","jobId":"PREPARED_JOB_ID","budgetId":"delivery-example-1"}'
node core.mjs review --json '{"action":"status","jobId":"PREPARED_JOB_ID"}'
```

`/spec review <JSON>` / native `spec_review` 相同。committed 解析完整 commit SHA、验证祖先，只读指定 head 的 Spec/profile/package 与精确 base..head；缺省拒绝脏 tracked/staged/untracked，allowDirty 明示排除项。incremental 还需要 prior engine job ID，保留 original implementation base、独立 review base、report hash 与 closure matrix；阻断需准确 changed-line + introduced-by-diff/regression/incomplete-fix 分类，baseline 观察不阻断。合同/profile 改变需 full review。proposal 读取当前声明 Spec，不以空 diff 批准；普通空 diff skipped，无模型、不是 PASS。

只有 full current working-tree-audit 能写 lifecycle audit；prepare/run/status 普通审查永不修改 approval/status/audit。`spec_audit` 的 budgetId 或 `SPECFLOW_REVIEW_BUDGET_ID` 引用同一授权，reviewJobId 可无二次调用地 resume/attach 匹配的 full job；必须匹配 snapshot/contract/Spec/scope/diff/impl。当前 Spec 整体单独送审，重复的生命周期 diff 与 reserved ledger 排除；新文件 headers 稳定。delta/历史批准不能 import 为 full PASS。旧 v2 合法记录仍兼容。

Git common-dir 的 `spec-flow/review-v1/{budgets,jobs}` 私有保存完整 packet、原始 stdout/stderr、hash/scan/usage/receipt/state（0700/0600）；不触碰旧 `spec-flow/jobs/*`。整个实际 child prompt <=512 KiB、raw <=32 MiB，不静默截断；名为 high-risk-patterns/v1 的有限扫描与 @file 字节 hash 在执行前重检，不能冒充通用 check_secrets。raw verdict 与归一化失败/父级 dispositions 分开；错格式/超限/取消绝不 PASS。

模型工具不能建/提高/重置授权。经过 preflight 后、spawn 前共享锁原子计次；失败/取消/中断不退款，同 job 不自动 respawn；completed cache 在 budget lookup 前免费。独立 worker 的结果先落盘，再交付 frontend，frontend 消失不会自动重审；未知 running 状态须查 owner/证据，不抢旧锁或换 cycle 逃避预算。已失败 job 重放不重审，明确 re-impl 后可创建新 job（仍消耗原授权）。授权 metadata 可写，不是防篡改/付费权限沙箱。

Pi 项目识别只读取目标 tree/snapshot 的声明/常规入口、路径/mode/hash 与标记 lexical hints，不 import/load；128 declarations、256 matches、256 KiB/source 限制，记录缺失/不支持/越界/symlink diagnostics。静态 recognized 不是真实宿主加载证明。

### 工具协议错误可修复，不等于产品 FAIL

`outputInfo` 明确区分 `protocol-error` / `execution-error` / `product-fail` / `pass`。审计摘要、下一步和人工登记拒绝提示不再把字段格式问题说成产品 findings，也不会自动要求另付费重审。新 packet 明确声明 `scope_deviations: string[]` 及限额；结果协议 v2 可无损兼容**恰好只有非空 string file/note** 的有界观察对象，编码成可逆 JSON 字符串。未知/额外字段（尤其 blocking）、缺少判断/证据、截断或未完成执行不能被偷偷补齐。

已完成 legacy job 的原 packet/raw/receipt/FAIL 不改；缺版本字段继续用 legacy 规则校验。若 `outputInfo.repairable=true`，可以在**预算耗尽、没有 pi/launcher** 时免费修复：

```bash
node /trusted/spec-flow/core.mjs review --json '{"action":"repair","jobId":"ORIGINAL_32_HEX_JOB_ID"}'
# 返回独立 derived jobId；原始独立结论、raw 字节、版本绑定和原计次引用都保留。
# 仅 full-current-audit 且当前证据仍匹配时才附加；此步骤也不重新调用模型。
node /trusted/spec-flow/core.mjs audit SPEC_ID --review-job DERIVED_32_HEX_JOB_ID
```

native `spec_review {action:"repair",jobId}` / `/spec review <JSON>` 等价；native 附加用 `spec_audit {id,reviewJobId}`。repair 不接受 budgetId、verdict、criteria 或自定义修补内容。完整原始证据和派生来源均重验；重复 repair/replay 幂等，写入失败不留半成品，既不消耗新调用也不退款/重置旧授权。它只修工具格式，不做第二次审查：真正的产品 FAIL 仍是 FAIL，普通/delta 仍不能冒充 full audit，当前实现/合同/scope/diff/impl 绑定不匹配仍须先解决版本/证据问题，人工确认规则不变。源码更新不会刷新运行宿主缓存；旧宿主可先走可信 CLI，不需要为 CLI 修复重启生产。

### timeout 生效与无 PATH pi 的启动

`prepared` job 首次 run 才读取当前执行参数；提高 `SPECFLOW_AUDIT_TIMEOUT` 后可直接启动尚未执行的同一 job。`running` 只等待原 worker，终态只重放原结果，不刷新 timeout/bin/model/thinking，也不重启或退款。run 返回 `executionInfo`（requested/effective timeout、是否 applied/ignored、started/wait-existing/reuse-result）；native tool 同时更新进度，audit 缓存也显示沿用值。`receipt.execution` 始终保留原参数。需要更长 timeout 的**新执行**须 prepare 新 job 并使用仍有效的授权，不能靠重放旧 job 自动再调用。

review/audit 共享计次前 launcher preflight：显式 `SPECFLOW_AUDIT_BIN`（包括已有可信 shim）优先；否则显式 `SPECFLOW_PI_CLI` 使用当前 Node + 已安装 CLI 的绝对路径，**不需要 PATH 中有 pi 或生成 shim**；均未配置时才从宿主 PATH 查找 pi。缺失/不可执行 bin、缺失/不可读 CLI、非法 timeout 在 spawn/charge 前失败，prepared job 可修正配置后再次 run。只做文件系统检查，不执行 `--version` 探测、不自动安装/发现目标项目 CLI、不猜 npx 缓存、不修改全局 PATH 或重启服务。已计费之后的失败仍不退款；preflight 不是版本兼容性或防文件替换的安全沙箱。

```bash
# 选择已安装、明确受信的 Pi CLI；不要求它在宿主 PATH 中。
export SPECFLOW_PI_CLI=/absolute/trusted/pi/dist/cli.js
export SPECFLOW_AUDIT_TIMEOUT=600000
# 使用相同环境执行 review run 或 lifecycle audit，无需 caller 的 spec:audit 专用 wrapper。
node core.mjs review --json '{"action":"run","jobId":"PREPARED_JOB_ID","budgetId":"AUTHORIZED_CYCLE"}'
node core.mjs audit SPEC_ID
```

配置应传入**实际宿主/worker 的环境**；交互 shell 能运行 pi/npx 不证明 daemon 能解析它。现有 shim 仍可通过 `SPECFLOW_AUDIT_BIN=/absolute/trusted/shim` 使用；此变量优先于 `SPECFLOW_PI_CLI`。

## 审计边界

审计 patch 使用 argv 形式的 Git 命令，包含从 `base_sha` 到当前 working tree 的 committed/staged/unstaged tracked 变化和未跟踪文件。以下情况 fail closed：base 非 HEAD 祖先、非法 scope、Git 失败、diff 超限、空 diff、非法审计 JSON。

审计子进程使用 `--no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-approve --mode json`。spec/diff 仍是不可信输入；禁用工具降低 prompt injection 的影响，但不构成进程级沙箱。

| 环境变量 | 默认 | 说明 |
|---|---:|---|
| `SPECFLOW_AUDIT_MODEL` | 子 Pi 默认模型 | 模型名/别名 |
| `SPECFLOW_AUDIT_BIN` | PATH 的 `pi` | review/audit 共用可信可执行文件或 shim；显式设置优先 |
| `SPECFLOW_PI_CLI` | 无 | 可信已安装 Pi JS CLI 的绝对路径；未指定 BIN 时使用当前 Node 执行，无需 PATH pi |
| `SPECFLOW_AUDIT_TIMEOUT` | `180000` | 首次执行的超时毫秒（1..1800000）；复用不修改旧计时器 |
| `SPECFLOW_AUDIT_THINKING` | `off` | 子 Pi thinking 等级；可显式提高到 `low`/`medium`/`high` 等 |
| `SPECFLOW_AUDIT_MAX_BYTES` | `524288` | 限制 patch/完整 child packet，不能提高 512 KiB packet cap；超限失败 |
| `SPECFLOW_REVIEW_BUDGET_ID` | 无 | 已显式授权的 delivery-cycle grant；不自动创建 |
| `SPECFLOW_SNAPSHOT_MAX_BYTES` | `536870912` | snapshot 总读取上限 |

通过的 audit 只有在 implementation hash 与 contract hash 均未变化时才可复用。

### 与项目 `verify` / 跨仓 GitHub Action 组合

项目的 `verify` 可以调用 `node core.mjs check --ci --contracts-only` 作为元数据门禁；`spec_impl` 仍运行 profile 的权威 `npm run verify`。**不要**在 `verify` 内调用完整 `check --ci`：它会再次执行 `verify`，产生递归。contracts-only 明示未运行项目 gates，不能单独冒充完整 CI；独立 `check --ci` 仍执行项目 gates 且缓存禁用。

此仓库根目录提供 `action.yml` composite Action，仓库公开，任意仓库可直接按完整 SHA 引用：调用方 `uses: nightink/pi-spec-flow@<full-40-char-commit-SHA>`，使用真实已推送 SHA，不用 `main` 等可变引用。Action 用自己的 `package-lock.json` 安装运行时依赖，然后调用 `node "$SPECFLOW_CLI" verify`：显式 gates 优先；没有 gates 配置时保留 caller 的 npm `verify`（若存在）且只运行一次，否则用默认探测。无可执行门禁时 Action 失败。`verify` 先校验 Spec 合同/证据，失败即退出且不执行 caller gates；有效合同才运行各 gate，非零退出传播为失败。普通 `check --ci` 为兼容诊断仍执行全部配置 gates，即使文档校验失败；contracts-only 始终不执行 gates。`SPECFLOW_CLI` 指向该 Action 路径，项目 verify 内仍仅调用 contracts-only 避免递归；不需要跨仓 checkout 的 PAT。Caller 应使用 `permissions: contents: read`，先 checkout，准备 Node >=22.19.0（引擎要求）及自身 Python/uv/venv/npm 等测试环境；Action 不安装 caller 依赖。本地 CLI 仍需从可信安装的 Pi 扩展运行（Action 只提供 CI，不自动部署 Pi skill 或扩展）。

**交付顺序**：本地提交 → push 该 commit → 调用方仓库引用已推送的固定 SHA → push 调用方并查看真实 CI。没有真实推送和远端运行前只能证明本地 Action 等价路径，不能宣称远端已接通；本工具不会自动 push/publish 或改 GitHub 设置。调用方仓库的协作者可能通过 workflow 日志间接看到 Action 输出；不要在 Action 输出机密，也不要授权不可信仓库。

## Gate cache

结果缓存默认关闭：未设置 TTL 时每次都真实运行门禁。

```bash
SPECFLOW_GATE_CACHE_TTL_MS=30000 node core.mjs impl S3.13
```

显式启用后，缓存位于当前用户的私有系统临时目录（目录 `0700`、文件 `0600`），并以 Git HEAD/status/diff、未跟踪内容、门禁定义、Node 主版本和平台生成指纹。指纹不可用或为 null 时一定 miss，并报告诊断。环境变量不可能被完整观测，因此缓存只是可选性能优化，不是证据来源；`check --ci` 始终禁用它。

## Commit 门禁

Pi 的 `tool_call` 拦截器识别 `git commit`、`git -C … commit` 和常见 `cd … && git commit`，解析真实目标仓库后运行该仓库门禁：

- 失败：block，并显示仓库、门禁名和输出尾部；
- `SPECFLOW_BYPASS=1` 前缀：警告、写 ledger、放行；
- 拦截器自身异常：告警并 fail-open，避免瘫痪所有 bash 工具。

它是工作流减速带，不是恶意 shell 的安全边界。

## CI 与兼容性

```yaml
- run: npm ci
- run: npm run check
- run: npm audit --omit=dev
```

本仓库 `.spec-flow.json` 仅把完整 `npm run check` 设为权威 gate；该脚本已先运行 syntax/unit/九组 E2E，再执行 contracts-only，避免递归。仓库内提供 `.github/workflows/ci.yml`。`check --ci` 检查 frontmatter/body 漂移、重复 ID、evidence 路径、migration 冲突、v2 done 记录一致性，并运行当前项目门禁。

Legacy 行为：

- pending/approved：可通过 `spec_begin` 显式迁移到 v2；
- in-progress：impl/audit/attest/done 和 CI 拒绝，要求重跑 begin；
- done：只读兼容，CI 给 migration warning，不用今天的工作树否定历史结果。

## 自测

```bash
npm test                         # unit + adapter fake-Pi integration / partial-UI real gates
node tests/e2e/e2e-commit-gate.mjs
node tests/e2e/e2e-trustworthy-closure.mjs
node tests/e2e/e2e-spec-discovery.mjs
node tests/e2e/e2e-project-governance-profile.mjs
node tests/e2e/e2e-worktrees-python.mjs  # 真实 Python + linked worktree + Action copied CLI
node tests/e2e/e2e-review-and-spec-new.mjs # 创建竞争 / finite grant / frontend loss / cache
node tests/e2e/e2e-review-repair.mjs # 预算耗尽/linked checkout/免费修复与绑定附加/篡改拒绝
npm run check                    # 权威本地门禁
SPECFLOW_PI_BIN=/trusted/installed/pi SPECFLOW_PI_SDK=/trusted/installed/pi-package npm run smoke:pi
# 私有临时 agent/project：真实 RPC /spec、typed native/partial-UI、三种 API 的 pre-network 工具声明；无 provider 请求
```
