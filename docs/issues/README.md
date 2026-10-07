# Issues

按日期归档的缺陷记录（现场证据 + 复现步骤 + 根因 + 建议修法）。

| 日期 | 文件 | 摘要 | 状态 |
|---|---|---|---|
| 2026-10-07 | [2026-10-07-recoverable-review-output.md](./2026-10-07-recoverable-review-output.md) | S1.7 归母：协议错误与产品 FAIL 分层、零模型派生修复/绑定附加；真实 Spec70 原结论救回、原 job/预算 2/2 不改；194 单测/九组 E2E/完整 Pi smoke | resolved / parent-only（未独立审查） |
| 2026-10-06 | [2026-10-06-native-review-object-schema.md](./2026-10-06-native-review-object-schema.md) | S1.7 归母修复：spec_review object 根节点、全部九工具三种 API 离线序列化与严格 action/no-spawn 回归；184 单测/八组 E2E/完整 Pi smoke 通过 | resolved / parent-only（未独立审查） |
| 2026-10-06 | [2026-10-06-daemon-ui-notify.md](./2026-10-06-daemon-ui-notify.md) | S1.2 归母修复：daemon 缺失 notify 不再中断 impl；原生工具进度、失败提交拦截与人工确认边界；183 单测/八组 E2E/真实 Pi SDK 回归通过 | resolved / parent-only（未独立审查） |
| 2026-10-04 | [review-execution-timeout-and-pi-launcher.md](./review-execution-timeout-and-pi-launcher.md) | S1.7 归母修复：timeout 生效/复用诊断、review/audit 共用可信 launcher 与计次前检查；169 单测/八组 E2E/实际 Pi smoke 通过 | resolved / parent-only（未独立审查） |
| 2026-09-15 | [2026-09-15-gate-cache-tree-null.md](./2026-09-15-gate-cache-tree-null.md) | `treeHash()` 返回 null 时门禁缓存退化为 TTL 内无条件命中（假红/假绿） | open |
