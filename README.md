# spec-flow

pi 全局扩展：spec 流程门禁。把「禁止状态声称」从道德约束变成构造约束。

## 安装

已放置在 `~/.pi/agent/extensions/spec-flow/`，pi 自动发现。首次使用：

```bash
cd ~/.pi/agent/extensions/spec-flow && npm install
```

## 采纳项目零配置约定

把扩展放在任何项目根目录下运行即可。约定路径：

| 约定路径 | 说明 |
|---|---|
| `docs/specs/*.md` | spec 文件（frontmatter 纳管） |
| `package.json` scripts.typecheck | 门禁：`npm run typecheck` |
| `biome.json` | 门禁：`npx biome check .` |
| `vitest.config.*` 或 scripts.test 含 vitest | 门禁：`npx vitest run` |
| `tests/e2e/e2e-*.mjs` | e2e 套件（可选） |
| `packages/db/src/migrations/*.ts` | 迁移目录（可选，无则 migrate-alloc 拒绝） |
| `specflow.json` | 可选覆盖配置 |

## 六工具

| 工具 | 说明 |
|---|---|
| `spec_board` | 全 spec 一览（状态 + 漂移检测） |
| `spec_begin <id>` | 前置：review=approved + deps 全 done → status=进行中 + 记 base_sha |
| `spec_impl <id>` | 跑门禁 + e2e → 全绿写 impl{at,gates,e2e} |
| `spec_audit <id>` | 独立 LLM 审计 spec↔diff → 写 audit{at,sha,verdict,findings} |
| `spec_attest <id> <item> <note>` | 人工核验登记（note ≥20 字） |
| `spec_done <id>` | 终态闸门：impl ✓ + audit pass + sha 新鲜 + human 全 attest → status=已完成 |

## TUI 命令

```
/spec          当前项目 spec 看板（状态、漂移、impl/audit/attest、下一步）
/spec board    同上
/spec <id>     单个 spec 详情（review/deps/impl/audit/attest/evidence）
```

Tab 可补全 spec id。

## CLI（同核心，CI 用）

```bash
node ~/.pi/agent/extensions/spec-flow/core.mjs board
node ~/.pi/agent/extensions/spec-flow/core.mjs begin S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs impl S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs audit S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs attest S3.13 R1 "核验描述..."
node ~/.pi/agent/extensions/spec-flow/core.mjs done S3.13
node ~/.pi/agent/extensions/spec-flow/core.mjs migrate-alloc
node ~/.pi/agent/extensions/spec-flow/core.mjs check --ci
```

## CI 一行

```yaml
- run: node ~/.pi/agent/extensions/spec-flow/core.mjs check --ci
```

## 门禁拦截

`tool_call` 事件自动拦截 `git commit`：门禁红 → block（reason 含失败门禁名 + 末 10 行）。
含 `SPECFLOW_BYPASS=1` → 放行 + 警告 + 台账记 bypass。

## 台账

`<项目>/.spec-flow-ledger.jsonl` 追加写（impl/audit/done/bypass 事件）。

## 自测

```bash
cd ~/.pi/agent/extensions/spec-flow && node --test core.test.mjs
```

## 实现细节

- 所有子进程（门禁 / e2e / `pi` 审计子进程）均为异步执行，不阻塞 TUI 事件循环；Esc 中止会杀掉子进程（AbortSignal 透传）。
- **审计子进程必须用 `spawn` 而非 `execFile`**：实测 Node 的 `execFile` 对 shebang 脚本（`#!/usr/bin/env node` 的 `pi`）异步管道永不 settle（挂起无回调），`spawn` + 手动收集稳定。
- **审计缓存**：base/HEAD 未变且上次 verdict=pass → 直接复用，不重复跑 LLM。
- 工具执行期间（审计等长操作）TUI 输入会排队，按 **Esc** 可中断；`spec_audit` 每 5s 推送进度心跳，避免“像死机”。
- `SPECFLOW_AUDIT_MODEL`：指定审计子进程模型（默认同主会话）。
- `SPECFLOW_AUDIT_BIN`：覆盖审计 CLI 可执行文件（默认 `pi`），测试或自定义审计器用。
- `SPECFLOW_AUDIT_TIMEOUT`：审计超时毫秒数（默认 180000）。
