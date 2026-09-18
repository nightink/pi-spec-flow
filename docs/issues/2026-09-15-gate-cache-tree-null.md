# 已解决：`treeHash()` 为 null 时门禁缓存无条件命中

| 项 | 值 |
|---|---|
| 报告日期 | 2026-09-15 |
| 解决版本 | 0.2.0 / S1.2 |
| 组件 | `core.mjs` · gate fingerprint / `runGates()` |
| 严重度 | 高：可产生假红，也可重放旧的通过结果形成假绿 |
| 状态 | **Resolved** |

## 现场现象

一次失败门禁写入缓存后，代码虽已修复、手工 `npm run typecheck` 也已通过，5 分钟 TTL 内再次提交仍返回原错误；删除 `<tmp>/specflow-gates-*.json` 后立即恢复。缓存记录中的 `tree` 为 `null`。

## 根因

旧实现有两个组合缺陷：

1. `treeHash()` 调用了未导入的 `execSync`。`ReferenceError` 被宽泛 `catch` 吞掉，因此扩展进程中稳定返回 `null`；此前将原因推测为 PATH/cwd/Git 环境差异并不准确。
2. 缓存读取条件使用 `(tree === null || cached.tree === tree)`，把“无法证明同一工作树”解释成“任意缓存均可命中”。失败和成功结果都会被 TTL 内重放。

```js
// 旧逻辑（错误）
if (fresh && (tree === null || cached.tree === tree)) {
  return cached.result;
}
```

## S1.2 修复

- gate 结果缓存默认关闭（TTL=0），因此默认路径每次真实运行门禁；
- 仅显式设置 `SPECFLOW_GATE_CACHE_TTL_MS>0` 时尝试缓存；
- 指纹改为异步、可取消计算，绑定 HEAD、status、tracked diff、未跟踪文件内容、门禁定义、Node 主版本和平台；
- 指纹失败或 hash 为 null 时必定 cache miss 并真实执行，同时通过 diagnostic 暴露原因；
- 缓存移到当前用户的私有系统临时目录，目录 `0700`、文件 `0600`，使用同目录临时文件 + rename 原子替换；
- `check --ci` 强制 `cacheTtlMs: 0`，不接受结果缓存作为 CI 证据。

缓存显式启用时仍不可能完整观测所有环境变量和外部服务，因此它只是一项性能优化，不是可信证据来源。

## 回归覆盖

S1.2 测试覆盖以下路径：

- 默认关闭时连续调用会连续执行真实 gate；
- opt-in 后，失败结果不会在工作树内容变化后继续命中；
- 指纹不可用/null 时连续调用仍执行真实 gate；
- 私有缓存不写入项目根目录；
- CI 调用显式禁用缓存。

权威验证命令：

```bash
npm test
node tests/e2e/e2e-trustworthy-closure.mjs
npm run check
```

## 结论

`null` 现在只表示“不可复用”，不再是通配符。默认关闭缓存同时消除了未被指纹观测的环境变化造成假证据的风险面。
