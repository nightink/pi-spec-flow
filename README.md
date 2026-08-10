# spec-flow

pi 全局扩展：spec 流程门禁。把「禁止状态声称」从道德约束变成构造约束。

## 安装

已放置在 `~/.pi/agent/extensions/spec-flow/`，pi 自动发现。

```bash
cd ~/.pi/agent/extensions/spec-flow
npm install
```

## 项目侧契约（采纳项目零配置）

约定优于配置，缺项降级跳过并注明：

| 约定 | 路径 |
|------|------|
| specs 目录 | `docs/specs/*.md`（frontmatter 纳管） |
| 门禁自探测 | `package.json` scripts.typecheck → `npm run typecheck`；`biome.json` → `npx biome check .`；vitest 配置/脚本 → `npx vitest run` |
| e2e 目录 | `tests/e2e/e2e-*.mjs`（可选） |
| 迁移目录 | `packages/db/src/migrations/*.ts`（可选，无则 migrate-alloc 拒绝） |
| 可选覆盖 | 项目根 `specflow.json` |

## 六工具

| 工具 | 语义 |
|------|------|
| `spec_board` | 全 spec 一览（推导状态 + evidence 存在性校验） |
| `spec_begin(id)` | 前置：review.decision=approved 且 deps 全 done → status=进行中 + 记 base_sha |
| `spec_impl(id)` | 跑门禁 + 逐个跑 evidence.e2e + 校验迁移注册 → 全绿写 impl{at,gates,e2e} |
| `spec_audit(id)` | 独立 LLM 审计 spec↔diff → 写 audit{at,sha,verdict,findings} |
| `spec_attest(id,item,note)` | 人工核验登记（note ≥20 字，含核验链路） |
| `spec_done(id)` | 终态闸门：impl 通过 ∧ audit pass 且 sha 新鲜 ∧ human 全 attest → status=已完成 |

## CLI（同一核心，CI 用）

```bash
node ~/.pi/agent/extensions/spec-flow/core.mjs board
node ~/.pi/agent/extensions/spec-flow/core.mjs begin S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs impl S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs audit S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs attest S3.13 R1 "核验说明..."
node ~/.pi/agent/extensions/spec-flow/core.mjs done S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs migrate-alloc
node ~/.pi/agent/extensions/spec-flow/core.mjs check --ci
```

## CI 一行

```yaml
- run: node ~/.pi/agent/extensions/spec-flow/core.mjs check --ci
```

## 事件钩子

- **tool_call**: 拦截 bash 的 `git commit` → 跑门禁（5 分钟缓存）→ 红则 block。`SPECFLOW_BYPASS=1` 放行 + 警告 + 台账记录。
- **session_start**: 有进行中 spec 则 notify 摘要，无则静默。

## 台账

`<项目>/.spec-flow-ledger.jsonl` 追加写（impl/audit/done/bypass 事件）。

## 自测

```bash
cd ~/.pi/agent/extensions/spec-flow
node --test core.test.mjs
```

## 环境变量

| 变量 | 用途 |
|------|------|
| `SPECFLOW_AUDIT_MODEL` | 审计 LLM 模型（默认 anthropic/claude-sonnet-4-20250514） |
| `SPECFLOW_PI_BIN` | pi 二进制路径（默认 `pi`） |
