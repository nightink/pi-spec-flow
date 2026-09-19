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

无需配置文件；当前实现**不读取 `specflow.json`**。

| 路径/字段 | 行为 |
|---|---|
| `docs/specs/*.md`、`docs/spec/*.md`、`specs/*.md`、`spec/*.md` | 扫描这些显式目录中的 spec；目录可单复数，直接合并，不递归其他路径 |
| `package.json#scripts.typecheck` | `npm run typecheck` 门禁 |
| `package.json#scripts.test` | Vitest 或通用 `npm test` 门禁 |
| `biome.json` | `npx --no-install biome check .` 门禁 |
| `tests/e2e/e2e-*.mjs` | 可声明的 E2E evidence |
| `packages/db/src/migrations/NNN*.ts` | 可声明的 migration evidence |
| `.spec-flow-ledger.jsonl` | 本地追加式生命周期/绕过记录 |

E2E evidence 只能填写 `e2e-*.mjs` basename（可省略 `.mjs`），不能包含目录或符号链接。每个脚本必须退出 0、至少输出一行行首 `PASS `，且不能输出行首 `FAIL `。

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
npm run check                    # 权威本地门禁
npm run smoke:pi                 # 已安装 Pi 时：真实 RPC 加载 + /spec，无模型调用
```
