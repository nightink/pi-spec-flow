# S21 父级验证与待发布边界

治理合同：[S21](../../specs/S21-delivery-recovery-and-release-candidate.md)。代码基线 `96dde2bcbae652120d50332a498a4ed2e49607ec`，本记录验证其上的本地变更；最终提交从 Git 历史读取，不捏造未来 SHA。

**没有新增真实 reviewer/provider 调用。** 原授权 3/3 保持耗尽，原独立 FAIL 与 packet/raw/job 保留。下列测试中的 grant、worker、coverage 均是临时仓库的 synthetic plumbing，不是独立 proposal/full audit PASS。S2.2、S21 均不关闭。本地候选、远端发布、lifecycle done 是三个状态。

## 可执行证据

| 验收 | 实际入口与检查 | 证明范围 |
|---|---|---|
| A1 | `delivery-recovery.test.mjs`、`delivery-boundaries.test.mjs`：真实 CLI audit，fake 调用计数，非法/重复/空 budget/prepare+budget 前后 Spec/grant/job 比较 | 引用已有授权、不静默再计次；不是新的真实授权 |
| A2 | 同上及 `e2e-delivery-recovery.mjs`：原样 Action check step、CLI strict/change、FAIL/protocol/stale、伪造 PASS/篡改 raw/receipt、非法审批/合同/done、gate exit7 | change 只保证修复可达，不删除/升级历史；默认 strict/done 与项目 gate 仍阻断 |
| A3 | current full audit 未提交普通文件；committed 缺 HEAD 源；ignored/missing/文件及祖先 symlink/目录 | 来源及路径/reason，不读取外部链接，不声称本地证据已在远端 |
| A4 | 原始 UTF-8 非法字节/中文前缀/U+FFFD offset6；count、单文件、total/最大贡献路径，无正文回显 | 可复算的字节/超额定位；不截断或自动缩 scope |
| A5 | 默认、最大/非法 policy、21 文件/210000 bytes、70000-byte 单文件、proposal/committed/full-current、封存后改当前合同及 binding tamper | 合同策略封存；packet/blob/index 另有独立限额 |
| A6 | raw 非空缺 kind、criteria 空数组、synthetic FAIL、协议错误候选来源、330-unit FAIL | raw 与 typed 分开；未验证观察不变成产品定论/语义 PASS；不推导容量阈值 |
| A7 | CLI identity 与实际 Pi SDK native prepare 比对；同进程磁盘修改/新进程对照；真实 detached worker 的非零退出及 stopReason=length | 启动期 core 指纹；实际 stop/usage/decodePath/raw hash；不证明常驻生产 Pi 已更新 |
| A8 | add/delete/content/type/执行位、tracked ignored 产物、untracked ignored、legacy、manifest 篡改 | 相对路径级诊断；aggregate 仍判 freshness；既有 gitlink/sparse/大文件等回归随全量检查通过 |
| A9 | 实际 subprocess API/CLI 红/绿、不匹配、timeout/truncation/signal、实现与合同变化、ENOENT、无效 UTF-8 输出的 base64/hash、路径替换/越界/覆盖/symlink/大小写内部路径、秘密模式拒写 | 真实当次观察、完整性/稳定性边界；不认证历史 red-first、不替用户回退代码、不承诺任意子命令无副作用 |
| A10 | `npm run check`；实际 Pi 1.3.0 五组 smoke、9 tools × OpenAI Completions/Responses/Anthropic serializers（0 HTTP）；README/core README/skill/references/help/schema/Action/原 issue 处置 | 297 单测通过、14 个 E2E 脚本通过；宿主离线兼容，不是 hosted CI 或真实模型质量 |
| A11 | `node tests/release/verify-package.mjs <absolute-artifact-dir>`：实际 pack、源码外离线安装、11 export/bin、依赖、root/Pi private、逐文件与源码字节一致 | core 0.4.0 tarball；Action 的 install+check 两步在独立源码副本离线执行，strict/change 各运行 gate 一次 |
| A12 | [发布说明](../../releases/0.4.0.md)、[包完整性清单](../../releases/0.4.0-manifest.json)、本目录日志索引/扫描记录；提交与 clean 以最终 Git 状态为准 | 只生成本地候选，不发布/推送/tag、不重启 Pi，不伪造独立 PASS |

上述单测位于 `packages/core/test/`；E2E 位于 `tests/e2e/`。原八项反馈逐条核实/保留争议见 [原报告追加处置](../../issues/2026-10-23-delivery-friction-from-kite-spec89.md)。映射表是导航，不代替测试执行、源文件和原始审查材料。

## 验证过程与保留的失败

- 最初 `s21-red` 是实现前实际运行失败；随后七项绿灯。保留输出摘要和原始 digest；不是另一会话历史 red 的证明。
- 执行恢复动作时发现限额值自身进入 packet，精确限额会多 1 byte；建议增加有界 256-byte 头部余量，回归实际重新执行建议，而非只断言字段。
- 第一轮全量：292/293，唯一失败是旧测试匹配旧 context 文案；改为检查稳定诊断 code/actual/limit，未删除边界。
- 新增 signal 退出测试真实失败（预期 false，实际 true）；原因是通用 spawn 把 signal 映射成 code1。新增保留 exitSignal，采集明确 incomplete/不匹配；绿灯包含 binary/ENOENT/合同与路径漂移。
- 第二轮完整 check：297/297，14 组 E2E，全流程退出 0。第一次 smoke 在最后一组发现测试硬编码 ^0.3.0；改为版本一致性断言后五组全通过。
- 离仓 pack/install 第一轮成功。增加 Action 两步验收时，测试错误地期待成功 gate 的 stdout 回显（引擎只回显摘要），改为 `.git` 内独立调用计数器后成功；没有改产品实现来迎合测试。
- 正式 `impl S21` 在所有交付材料就位后运行，避免归档文件使快照过期；实际结果、门禁摘要/hash、engine 与 snapshot_manifest 以合同 frontmatter 为准。其完整输出留在本地 `.git/spec-flow/releases/0.4.0/impl.log`，不把最后一次日志写回实现树引发自失效。

本目录 `evidence-index.json` 给出保留日志的原始 SHA256 与公开副本 SHA256。公开副本仅脱敏本地绝对路径并去除行尾空白；原始日志留在本地候选目录 `evidence/`，未改写。秘密扫描范围/限制见 `secret-scan.json`。有限模式无命中不等于任意秘密/PII 都不存在。

## 未证明、未执行

- 未新增独立 proposal/full audit PASS，未调用 done；不得把父级验证、prepared、synthetic PASS/FAIL 当审计闭环。
- 未核验 Kite 最新原始 Spec/packet/raw/job/grant。A3 最新补证不能继续当确定缺口；A4 历史/red replay/mutation、A6/D12 合同冲突及真实调用数仍待原始材料。
- 未触发远端 registry 发布/安装验证、Git push/tag、调用方改动、hosted GitHub CI 或常驻 Pi reload。
- 不默认过滤 tracked 构建产物，不把 330 当模型容量，不认证补造的 red-first，不用删除/豁免/“论证等价”冒充 done。
