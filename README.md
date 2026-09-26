# spec-flow

Pi 的证据绑定 spec 工作流扩展。它把 `begin → impl → audit → attest → done` 做成可检查的状态机，并在提交前运行项目门禁。

> 这不是安全沙箱或不可篡改账本。拥有仓库写权限的人仍可直接改 YAML/ledger；`SPECFLOW_BYPASS=1` 也保留为显式逃生口。

## 要求与安装

- Node.js `>=22.19.0`
- Git
- 当前支持并在 macOS/Linux 验证；Windows 不是本版本的保证范围

放在 `~/.pi/agent/extensions/spec-flow/` 后，Pi 会通过 `package.json#pi.extensions` 发现 `index.ts`：

```bash
cd ~/.pi/agent/extensions/spec-flow
npm install
npm run check
```

## 项目约定

默认无需配置文件。已有项目若使用不同的 spec metadata/status，可以显式提供严格的 `.spec-flow.json` project governance profile；不会读取 `specflow.json` 或执行动态配置代码。

| 路径/字段 | 行为 |
|---|---|
| `docs/specs/*.md`、`docs/spec/*.md`、`specs/*.md`、`spec/*.md` | 扫描这些显式目录中的 spec；目录可单复数，直接合并，不递归其他路径 |
| `.spec-flow.json` | 可选的 v1 project governance profile；普通非 symlink 文件、严格 schema、非法时 fail closed |
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

安全边界：配置只允许引用当前 `package.json#scripts` 中存在的 npm script，不接受 shell、可执行路径或 JS 插件；未知键、保留/冲突字段、状态角色重叠、脚本缺失、越界或 symlink 配置一律报错，不回退到较弱默认门禁。CLI 会非零退出，commit interceptor 会把配置错误作为红门禁（显式 `SPECFLOW_BYPASS=1` 仍可放行）。配置文件参与 implementation snapshot，验证后修改会使旧证据失效。

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

v1 profile 只支持 spec 与 implementation 位于同一仓库；配置项目若声明外部 `impl.repo` 会 fail closed，避免 profile 语义落在 snapshot 之外。npm script 本身仍是项目代码，不是安全沙箱，只有在信任项目及检查脚本定义后才应执行。

## Workflow v2

spec-flow 会扫描 `docs/specs/`、`docs/spec/`、`specs/`、`spec/` 四个显式目录；多个目录同时存在时按稳定路径顺序合并，重复 ID 会在 CI 和生命周期操作中 fail closed。

`spec_begin` 会写入 `workflow_version: 2`，记录实现仓库的 `base_sha`，并清除旧 impl/audit/attestation。后续证据绑定两类 hash：

- **implementation snapshot**：实现仓库当前 tracked + untracked 内容、删除、可执行位与 submodule HEAD；排除 ledger 和当前 spec 文件。
- **contract hash**：spec 的目标、设计、验收、deps、scope、evidence 等合同内容；排除生命周期写回字段，并规范化 checklist/review 区域。

因此，代码或合同在验证后变化会让 audit/done 拒绝旧证据；仅把相同代码提交到 Git 不会使内容快照失效。

### 六个 Pi 工具

| 工具 | 作用 |
|---|---|
| `spec_board` | 状态、漂移和下一步 |
| `spec_begin <id>` | 要求 review approved、deps done；进入 v2 in-progress |
| `spec_impl <id>` | 运行 required gates、逐项 E2E、migration 检查；写 `impl.pass` 与 snapshot |
| `spec_audit <id>` | 隔离子 Pi 审计完整 base→working-tree diff；写 criteria、hash、model、prompt version |
| `spec_attest <id> <item> <note>` | 仅在交互 UI 明确确认后登记人工 evidence |
| `spec_done <id>` | record-consistency + live snapshot 双重校验后进入 done |

Pi 的 begin/impl/audit/attest/done 对同一 spec 使用 `withFileMutationQueue()` 串行化。工具失败通过 throw 呈现为真实错误，长输出会明确标记截断。

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
```

```bash
node core.mjs board
node core.mjs begin S3.13
node core.mjs impl S3.13
node core.mjs audit S3.13
node core.mjs attest S3.13 R1 "核验路径和样本（至少 20 字）"
node core.mjs done S3.13
node core.mjs migrate-alloc
node core.mjs check --ci
node core.mjs check --ci --contracts-only  # 仅做 Spec/证据检查，不运行 npm gates
```

## 审计边界

审计 patch 使用 argv 形式的 Git 命令，包含从 `base_sha` 到当前 working tree 的 committed/staged/unstaged tracked 变化和未跟踪文件。以下情况 fail closed：base 非 HEAD 祖先、非法 scope、Git 失败、diff 超限、空 diff、非法审计 JSON。

审计子进程使用 `--no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files`。spec/diff 仍是不可信输入；禁用工具降低 prompt injection 的影响，但不构成进程级沙箱。

| 环境变量 | 默认 | 说明 |
|---|---:|---|
| `SPECFLOW_AUDIT_MODEL` | 子 Pi 默认模型 | 模型名/别名 |
| `SPECFLOW_AUDIT_BIN` | `pi` | 审计可执行文件；主要用于测试 |
| `SPECFLOW_AUDIT_TIMEOUT` | `180000` | 超时毫秒 |
| `SPECFLOW_AUDIT_THINKING` | `off` | 子 Pi thinking 等级；可显式提高到 `low`/`medium`/`high` 等 |
| `SPECFLOW_AUDIT_MAX_BYTES` | `524288` | 完整 audit patch 上限；超限不截断而失败 |
| `SPECFLOW_SNAPSHOT_MAX_BYTES` | `536870912` | snapshot 总读取上限 |

通过的 audit 只有在 implementation hash 与 contract hash 均未变化时才可复用。

### 与项目 `verify` / 跨仓 GitHub Action 组合

项目的 `verify` 可以调用 `node core.mjs check --ci --contracts-only` 作为元数据门禁；`spec_impl` 仍运行 profile 的权威 `npm run verify`。**不要**在 `verify` 内调用完整 `check --ci`：它会再次执行 `verify`，产生递归。contracts-only 明示未运行 npm gates，不能单独冒充完整 CI；独立 `check --ci` 仍执行项目 gates 且缓存禁用。

此仓库根目录提供 `action.yml` composite Action。对于**同一账号**下的两个私有仓库，在 spec-flow 仓库 Settings → Actions → General → Access 中选“Accessible from repositories owned by USERNAME user”；example-app 的 `uses: nightink/pi-spec-flow@<full-40-char-commit-SHA>` 使用真实已推送 SHA，不用 `main` 等可变引用。Action 用自己的 `package-lock.json` 安装运行时依赖，然后对 caller 运行 contracts-only 与 `npm run verify`，传递只在该 Action 路径下的 `SPECFLOW_CLI`；不需要跨仓 checkout 的 PAT。Caller 应使用 `permissions: contents: read`，先 checkout 并用 Node >=22.19.0 执行 `npm ci`。本地 CLI 仍需从可信安装的 Pi 扩展运行（Action 只提供 CI，不自动部署 Pi skill 或扩展）。

**交付顺序**：本地提交 spec-flow → 用户 push 该 commit → 用户启用上述私有 Action Access → example-app CI 引用已推送的固定 SHA → 用户 push example-app、查看真实 CI。没有远端设置和 CI 运行前只能证明本地 Action 等价路径，不能宣称远端已接通；本工具不会自动 push/publish 或改 GitHub 设置。注意共享私有 Action 时，调用仓库的外部协作者可能通过 workflow 日志间接看到输出；不要在 Action 输出机密或授权不可信仓库。

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

仓库内提供 `.github/workflows/ci.yml`。`check --ci` 检查 frontmatter/body 漂移、重复 ID、evidence 路径、migration 冲突、v2 done 记录一致性，并运行当前项目门禁。

Legacy 行为：

- pending/approved：可通过 `spec_begin` 显式迁移到 v2；
- in-progress：impl/audit/attest/done 和 CI 拒绝，要求重跑 begin；
- done：只读兼容，CI 给 migration warning，不用今天的工作树否定历史结果。

## 自测

```bash
npm test                         # unit + adapter fake-Pi integration
node tests/e2e/e2e-commit-gate.mjs
node tests/e2e/e2e-trustworthy-closure.mjs
node tests/e2e/e2e-spec-discovery.mjs
node tests/e2e/e2e-project-governance-profile.mjs
npm run check                    # 权威本地门禁
npm run smoke:pi                 # 已安装 Pi 时：真实 RPC 加载 + /spec，无模型调用
```
