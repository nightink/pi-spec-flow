---
review_inputs:
  context_files:
    - review-engine.mjs
    - review-coverage.mjs
    - review-worker.mjs
    - review-storage.mjs
    - review-execution.mjs
    - spec-creation.mjs
    - tests/fixtures/review-precision/scenarios.json
    - tests/fixtures/review-precision/dispositions.json
    - tests/fixtures/review-precision/oracle.json
    - tests/fixtures/review-precision/probe-plan.json
    - tests/probes/review-precision.mjs
  proposal_reviews: []
---
# Review precision：义务覆盖与证据分层缺口（修复提案）

- 状态：closed / **技术维护分层验收**；第七次修后独立复审 PASS、无 blocker，232/232 单测、完整门禁/CLI/Pi 及当前十九样本证据分别满足；实际用7/8次，通过即停。不是新全量审计或 lifecycle Spec done；[关闭依据与边界](../reviews/S1.7/evidence-precision/closure-20261015/closure.md)。下文保留第七次封存时的实施记录/计划，原始 FAIL 和历史施工前独立提案批准缺失均不改写；不调用 spec_done。后经用户授权脱敏发布：原始施工证据/旧未推历史留存私有，公开导出仅保留源码、合成 fixtures 及明确标注的摘要。
- 归母合同：`docs/specs/S1.7-unified-review-and-spec-creation.md`。
- 本仓库基线：`7c831e1`。
- 用户目标：spec-flow 的判定必须精准，否则作为交付证据层不可信。
- 来源边界：来自私有调用方反馈并经 parent 只读核验；此文件仅记录通用机制与脱敏反例，不复制私有 gist、源码、packet、raw、标识或运行数据。
- 授权边界：同一 `precision-20261015` 周期保留原3次、首次追加2次、再次追加1次的原生账本。用户先说「需要我授权吗？若是 同意 close」，又选累计6次；第六次发现兼容回归后，再明确选择「同意，累计最多 8 次」。新 continuation calls=8 / used=6 承接全部消耗，最多再两次，通过即停。不是新周期、重置、退款或自动重试；不 push、部署、重启或全局安装。fake fixtures 无真实 provider 消费；close 不追认历史施工前批准，不豁免新发现。

## 问题与已确认事实

证据绑定的正确性不等于判定的正确性。完整 packet 和相符 hash 可以证明审查输入没有漂移，却不能证明审查覆盖了全部义务，也不能证明数值口径符合用户语义。

基线 `7c831e1` 有以下机制缺口（不是对当前实现的重复结论）：

1. `review-engine.mjs::promptFor()` 包含完整合同，但结果中的 criteria 仍由模型选择；不能因为一条承诺不在 checkbox 中，就认定评审无义务检查它。
2. `normalizeReviewResult()` 检查输出结构、结果内部一致性和显式 prior_findings 的闭环，没有与合同义务全集对账。纯内存反例：只有一个 passing criterion 的 protocol 2 working-tree-audit 结果仍可通过。该反例没有模型调用，也不是一次实际 audit。
3. `prepareWorkingAudit()` 没有结构化继承方案评审 blockers；正文中的“已处置”表格不等于经验证的验收闭环。
4. full-current-audit 包含合同、当前实现 diff、impl 和静态 Pi 元数据，不等于包含全仓库源码。未改变的真实入口可能不在 packet 中；缺少相关上下文与确认实现缺失必须区分。
5. 当前模板及交付 skill 未要求 major 处置明确关联验收及接入证据。内部 helper 可用，不等于用户入口已经接通。

这可以造成“真实承诺未交付，但所有已列出的 criteria 都通过”。它不是 hash 损坏，也不能由再加一句 prompt 或 fake auditor PASS 证明已解决。

## 精准性的边界

本次修复不承诺模型永不漏审。可信度来自可核对的义务集合、明确的证据层级、可见的覆盖缺口和不越界的结论，而不是更自信的措辞或更多 FAIL。

必须区分：

| 层级 | 可以证明 | 不能顺带证明 |
|---|---|---|
| 来源与绑定 | 评审使用了指定且未漂移的输入 | 输入覆盖全部需求、模型判断正确 |
| 覆盖对账 | 被封存的义务均有有效处置 | 自然语言义务提取绝无遗漏 |
| 静态判断 | packet 内代码、测试和记录支持相应断言 | 实际浏览器、远端 CI 或人工已执行 |
| 运行时证据 | 指定版本、环境和路径发生过相应行为 | 其他环境、版本和未执行路径也正确 |
| 交付结论 | 合同要求的各层证据分别满足 | 单次静态 PASS 可代替全部交付验收 |

缺证据或未覆盖必须阻断相应 PASS，但应报告为覆盖/证据缺口，不能据此指控产品已被证实有 bug。反之，已证实的静态缺陷也不能借 runtime/out_of_scope 被隐藏。

## 修复范围与非目标

仅修复本仓库的合同引导、审查输入、版本化结果约束及相关验证。保留 issue #2 的静态/运行时分界及既有隔离、字节限额、secret scan、预算和绑定规则。

不修改调用方产品、不公开私有报告、不自动覆盖已安装的同名全局 skill，不推送、部署或重启。旧 Spec/job/packet/raw/receipt/grant 和旧版本 hash 语义不改；不能重解释历史 PASS 使其看起来满足新覆盖标准。以后如需标记某项旧结论已被质疑或被新证据取代，应另留可追溯记录，而不是篡改原结果；本提案不暗中引入完整撤销系统。

## 设计约束（用户批准实施；具体细化见下）

### D1：先形成义务集合，再判断是否满足

- 合同义务不能只等于现有验收 checkbox。必须对用户目标、设计承诺、范围变更及实际评审处置做覆盖核对，然后封存可定位的义务与验收索引。
- 区分语义提取与机械校验：程序能保证已封存 ID 的穷尽对账，不能仅靠关键词正则证明自然语言完整。作者自填“已覆盖”的矩阵也不是独立证据。
- 新合同引导稳定验收 ID；现有合同采用明确版本、确定性、只读的定位方式，不为迁就新协议批量改写已完成合同。
- 义务集合及其来源与 packet/job 绑定；超过限额应在执行前明确拒绝，不能静默丢项。

### D2：major/blocking 必须有可验证处置

- 已确认需修复的 finding 必须关联新增/修订的验收项及实际证据，不能仅凭“已写入设计”关闭。
- 被证据推翻的 finding 可以被驳回；明确批准的范围撤销或豁免可以作为单独处置。必须保留理由、来源与实际批准，不强迫为不存在的需求编造测试。
- 有历史方案评审的全量审计必须核对其适用处置，不能只有 incremental 模式才防止“口头关闭”。来源仅为作者摘要时，不能冒充已绑定的独立原始报告。

### D3：新增结果版本实行覆盖对账

- 新 job 的结果必须对应其封存义务，机械拒绝漏项、未知/重复 ID、矛盾状态及缺失的必要 closure。
- 覆盖完整性、工具协议有效性、产品判断及执行失败分层显示。具体 schema 和兼容策略须在提案评审后确定，不用新增字段的数量冒充解决问题。
- PASS 必须说明其范围和证据层级；deferred/out_of_scope 不等于通过，也不自动等于产品失败。
- 新结果规则仅解释相应版本的新 job。旧缓存和 repair 保持原语义，不得标榜为新标准下的穷尽覆盖。

### D4：验证接入，不只验证能力

- 为真实入口的静态判断提供必要、显式、受限、hash-bound 的目标仓库上下文。
- 只读取安全普通文件；不跟随链接、不跨仓库自动取数、不执行目标模块。路径、数量、字节限制与执行前扫描保持 fail-closed。
- 文件未出现在 diff 中不等于接入缺失；基线可能已满足。材料不足应明确请求补充，不可编造证据或笼统延期。
- 静态接线、可执行测试存在、运行时实际执行分别判断，不能互相冒充。

### D5：同时验证漏报和误报

- 反例至少覆盖：正文承诺没进入验收、复合指标遗漏维度、验收公式本身偏离目标、helper 可用而真实入口未接通。
- 正确例至少覆盖：基线已接通、经批准撤销的承诺、确属运行时/人工的延后、多个并行区间的跨度求和可以超过一天。
- 对数值定义先明确对象、单位、边界、聚合方式与反例；不能把适用于区间并集的不变量套在区间求和上。
- 机械回归证明硬约束，真实模型行为验证证明其在所测样本上的语义遵从；两者都不是零漏审保证。没有实际模型验证时，必须保留该证据缺口。

## 实施细化（原设计已冻结；后续协议修订逐次留痕）

1. 新 job 使用 result protocol **3** / prompt **9**（初始 6；分类/驳回误报修正为 7；决策引用澄清为 8；第四次发现正文 finding ID 混入 previous_closure，明确历史 ID 命名空间后为 9）。版本 1/2 解码、repair 及已留存 prompt 6 的无 kind 输出原样保留。prompt 7 要求 criterion 显式 kind=product|evidence：缺上下文、合同冲突、缺批准/绑定等证据判断不能仅因 status=fail 就冒充产品缺陷；失败 evidence criterion 必须对应可见 gap。旧缓存不升级覆盖标准，不回写首轮探针结果。
2. 新增确定性 `review_index`：按 Markdown 源块穷尽编号（正文、列表、表格行、代码块；剔除 YAML 和结构性分隔），保留原行号/section/text/hash。checkbox 与明确验收节中的条目标为 acceptance，评审表的 major/blocking 行标为待处置；这只是定位，不宣称完成自然语言语义提取。上限 400 源块，不能静默截断。
3. protocol 3 保留原有结果字段；criteria 增加稳定的结果内 `id`，prompt 7 增加上述显式 `kind`（旧 prompt 输出不补默认字段），新增 `coverage` 数组，要求每个源块恰好一项。每项引用源块 ID、实际 acceptance ID、criterion ID 和非空证据，区分 covered/context/deferred/gap/rejected/withdrawn。acceptance 与 major 不能以 context 隐去；撤销/驳回必须引用不同的决策源块及静态 criterion。单独的 gap 阻断通过并报告为 coverage-gap，而非已证实的产品 FAIL；同时有有效静态失败时保留 product-fail 与 gap，不能相互洗掉。非法/遗漏/重复引用属于协议错误。
4. coverage 对账只能保证已索引来源均有处置，不能证明 context 分类正确或引用语义有效。prompt 要求逐一核对正文承诺与验收语义、复合维度、数值口径、反例及入口；必须保留真实模型验证缺口。
5. 可选合同 frontmatter `review_inputs: {context_files: [...], proposal_reviews: [...]}` 为唯一显式上下文入口；字段参与现有 contract hash，无需扩展原生工具参数。context 最多 20 个目标仓库普通文件、单文件 64 KiB/合计 128 KiB，仅从选定 head 或对应工作树读取并封存 hash；拒绝越界、链接、Git 内部与明显凭证文件，仍扫描整个 packet。输入不是执行指令。
6. `proposal_reviews` 最多 5 个同一 Spec 路径的已完成 proposal job：核验原 packet/raw/result，带入明确来源的 blockers/failed criteria/显式 evidence gaps（gap 不是已确认产品缺陷）；它不是批准导入。新增全量审计的 prior closure 与对应 coverage 必须关联 acceptance。正文作者摘要与绑定原报告明确区分。增量仍只审 delta，基线可明确标为 reviewed-coverage 延后，不升级成全量结论。
7. 新 coverage/index 与 packet/job 绑定并在执行前、worker、状态读取时核验；确定性重建完整合同和声明清单，继承来源不能替换成作者摘要，直接声明的原 proposal job/packet/raw/result 丢失或篡改即阻断，不递归认证无限历史图；生命周期记录保留新增覆盖摘要和 hash，不改旧 normalized result hash。新标准的结论需要留存 job 才能验证，不沿用旧记录的缺失私有 journal 兼容例外；仍有新覆盖标记的记录不能只删版本字段就绕过校验。
8. 内部机械 fake helpers 仅补齐合成 fixture 的协议字段，不能自动用于生产解码，也不能作为 A4/A6/A7 的真实语义发现证据。用固定脱敏 fixtures 留出实际模型验证；无授权则相应验收保持 pending。

## 义务 → 验收 → 实施对应

| 义务 | 验收 | 实施步骤 |
|---|---|---|
| R1：不再把输入绑定当作结论正确 | A1、A4、A5、A10 | 1、2、5 |
| R2：正文承诺及 major 不能隐形消失 | A1、A2、A3、A4 | 1、2、3 |
| R3：未覆盖、延期、失败应准确区分 | A2、A5、A8 | 2、4 |
| R4：能力与接入分别验证且不误伤基线 | A6、A9 | 3、4 |
| R5：旧证据、授权和隔离边界保持 | A8、A9 | 2、4、5 |
| R6：数值语义及模型遵从不能由自证测试替代 | A4、A7、A10 | 1、3、5 |

## 有序实施计划

1. 评审本提案，明确义务提取、既有合同定位、closure 来源、结果版本及证据不足的呈现。先冻结脱敏正反例和预期，不依新实现输出反向编写 oracle。
2. 建立封存索引、版本化覆盖对账及精确的诊断；先补可复现的失败回归，再改生产逻辑。保留旧 job 的解码、缓存与无损 repair。
3. 贯通 major 处置、真实入口上下文、模板与仓库 skill 指引；逐项核对 D1–D5，没有验收支撑的新增设计先修改合同。
4. 通过真实 CLI/隔离宿主贯通输入、封存、执行、状态和生命周期消费者；验证安全、限额、无额外消费及旧版本兼容。
5. 运行权威门禁、扫描精确 packet 和交付物；在获得独立调用授权后验证真实语义反例并审查实现。分别归档机械、模型和运行时结果，未验证的层不标记完成，不重写历史 evidence。

## 可执行验收

以下勾选表示对应机械/兼容/运行或所测样本的真实语义证据已满足，不表示本次独立实现审查已批准或全量交付完成；独立结论另行记录。历史证据见 [validation](../reviews/S1.7/evidence-precision/validation.md)，当前续行记录单独归档。

- [x] **A1 索引与绑定**：同一合同生成确定的索引；相应义务/来源改动后绑定改变；packet 与 job 引用同一集合；限额溢出在消费前拒绝，不截断。
- [x] **A2 机械对账**：对一个至少两项的封存集合，遗漏、未知/重复 ID、矛盾状态均不能获得 PASS；完整合法结果可达 PASS。诊断表明覆盖或协议缺口，不捏造产品缺陷。
- [x] **A3 处置闭环**：已确认 major 只有“写入设计”而无验收/证据时不能关闭；有效关联可以关闭；经验证的驳回、批准撤销或豁免有明确独立路径，不制造虚假验收。
- [x] **A4 语义覆盖**：对“正文有承诺、checkbox 没有”的脱敏反例以及“公式与用户目标冲突”的反例，分别检验语义发现和机械阻断；不能用预制 fake findings 宣称模型已发现问题。记录实际发现结果与遗漏。
- [x] **A5 分层判断**：缺少必要静态上下文或绑定记录时不能宣称相应断言已满足；已确认静态接线缺失不能洗入 runtime 延后；真实运行事实可正确延期且不会凭空使静态层失败；交付完成仍检查合同所需的真实证据。
- [x] **A6 入口反例**：内部刷新 helper 可用、实际入口未调用的 fixture 不得被当成已接通；相同需求在基线已接通、无需改该文件的 fixture 不得仅因 diff 无该文件被判失败。
- [x] **A7 数值反例**：缺字段、边界和单位错误有明确 oracle；合法并行跨度总和超过一天的样本不被错误的日上限规则拒绝；统计口径有歧义时显式报告，不自行选择产品语义。
- [x] **A8 历史兼容**：既有版本的解码、packet/raw/result hash、免费缓存、repair 与授权计数不变；旧结果不被重算，也不被展示成满足新增覆盖标准；已完成母 Spec 的历史记录不改。
- [x] **A9 安全与集成**：真实 CLI/隔离宿主能看到并使用新增契约；危险路径、链接、超限和不合法输入在消费前拒绝；没有额外 provider 调用、跨仓库/生产读写、全局安装或 grant reset。
- [x] **A10 证据可信**：`npm run check` 和适用的真实集成验收通过，交付物与精确 packet 完成扫描；真实模型调用只在授权内进行。公开报告区分机械回归、实际模型判定、parent 核验及实际执行路径，不能把任一替代另一项，也不能以少数样本承诺零漏审。

## 本次实施与未完成项

已实施版本化索引/对账、来源继承与留存复核、显式 caller 封存、生命周期消费者、模板 v2 和仓库 skill 1.2.0。完整门禁、真实 CLI 与隔离 Pi 宿主的结果单独归档，不复用上一修复的通过结论。

### 原始独立发现的处置（不是作者自批）

原始完整报告为 `docs/reviews/S1.7/evidence-precision/independent-review.result.json`，真实原 job 为 `f15a636a953c27252a47dc5d4c20580c`，其 packet/raw/receipt 留存不变。以下为 parent 处置，新的独立模型必须核对可读原报告及修复，不能只采信此表。

| 来源 | 严重性 | 原始问题 | 验收与当前处置 |
|---|---|---|---|
| F1 | major | 新 job 删协议版本可绕到 legacy，丢覆盖而 PASS | A2/A8：`review-engine.mjs` 统一 coverage protocol guard；normalize、run 预算前、worker、status/cache 与去掉所有 job marker 后的 packet 检查；红/绿回归及原始 raw 需复核 |
| 第六次/F1 | major | reviewOutputInfo 对合法 v3 file/note 对象误构造 v2 job，被 guard 拒绝，status/cache 抛错 | A8/A9：仅 version=1 的 legacy 修复诊断才做 v2 试探；真实 v3 原样走 v3，补 prompt6–9 / pass-fail / status-cache / 原 raw 与预算不变回归 |
| C9 | evidence gap | 当前 prompt 的 approved withdrawal 正例缺失 | A3：第五次 prompt 9 批准正例完整通过；决策只引用真实 S 源块，APR-1 只作证据，previous_closure=[]；未拿历史成功替代 |
| C10 | evidence gap | 原包排除了真实 gates/CLI/Pi 日志 | A9/A10：本轮提供完整可读日志、执行命令、环境和源 hash；仅证明记录存在/绑定，不冒充模型亲自运行 |
| C12 | evidence gap | gzip 的 binary patch 不能直接语义核查 | A4/A7/A10：提供当前完整模型最终文本、fixture 输入与 oracle、opaque 映射及 hashes；私有完整 journal 不公开，不把压缩包当已读证据 |
| C13 | evidence/procedure boundary | 施工前独立批准及原冻结时序无法由作者 hash 独立鉴真 | 不补造历史事实；当前用户授权与限额明确留存。当前技术验收只检查记录/绑定与行为，不宣称获得 provider 签名、独立时间认证或历史流程全合规 |

历史 16/19、18/19 及第三次独立 FAIL 保留原样；第四次 prompt 8 为 13/19，六个 major 虽语义正确但非法 previous_closure 被拒，原始失败保留。第五次用新 opaque ID、无答案/无历史/无工具的生产 prompt 9 对未改十九场景盲测，分类匹配 19/19；parent 逐项核验入口、缺验收、缺上下文、公式/单位/边界/并行/fork、驳回、批准撤销和运行 handoff 的实际语义均符合冻结计划。该样本结果不等于总体准确率或零漏审；批准只按明确 synthetic harness 假设，不是生产认证。

第六次独立报告保留 FAIL：C1–C3/C5–C11 确认索引、硬约束、原降级修复、来源、旧语义及当前十九样本/门禁记录；C4 发现合法 v3 scope 对象的诊断回归，已先红后绿本地修复。C12/C13 另缺扫描、红灯/冻结次序及实际授权/预算记录，下一私有封存包补入记录，不将实际人工同意或独立时间认证假装为 packet 内可判事实。后续材料不能反称已被原审查看过。施工前独立提案批准不存在，不补造；当前 close 只覆盖本技术维护，不宣称历史流程全合规。

## 当前收尾计划与历史边界

1. 冻结场景/oracle/信任假设字节不变；首场景事先允许 gap 或保留 gap 的 product-fail，不能看结果改预期。历次原始失败、原生预算和 journal 留存，不借母 Spec 的历史 done 关闭当前修复。
2. 当前 prompt 9 仅澄清已存在的 ID 约束：previous_closure 只引用 metadata 显式 prior IDs，空集合必须为 []；正文 F1 用 S 源块 coverage/criterion 对账。生产校验不放宽；旧 prompt 6/7/8、缓存与 repair 不重解释。
3. 更新权威门禁、真实 CLI/隔离 Pi 宿主、扫描和源绑定。新独立模型需可读完整原 FAIL、当前十九场景最终 JSON/映射、冻结输入和真实门禁记录；无损 JSON 格式规范化的派生副本须保留全部键值/数组顺序并注明非原始字节，原字节另行保存。
4. 第六次使用共享 engine 的 committed-range 修后复审：原始全量范围为 `7c831e1..edea8b3`，本次检查 `edea8b3` 后全部修复。此前完整代码加可读记录的包为 583240 字节，512 KiB 硬限前拒绝且未计费，未截断。改用 Git 隔离快照，所有44个源码与主线逐文件/模式校验，仅省旧生成归档；声明11个当前核心/fixture/probe文件（118897字节）补足复审上下文，完整合同/声明上下文仍不裁剪。原始完整 FAIL 和当前完整模型 JSON 可读提供，不能仅采信作者闭环表。原全量与本次修后结论、真实门禁/CLI/Pi/盲测各自证明对应层；本次不是新全量 base→current 审计、native incremental 批准或产品生命周期验收，不以 delta PASS 冒充全部通过。
5. 上述为第六次封存时的范围；该次返回 FAIL，原报告/packet/journal 不改。新增 scope 兼容修复不改变 prompt9、schema 或旧结果解释，不能靠降级来计算 v3 诊断。
6. 用户已授权累计最多8次；种入used=6，最多再两次独立复审，必要收敛且通过即停。新包用共享 sealReview/run 引擎，绑定完整前次原始报告、F1 历史 ID 与全部当前变更；补入私有原生预算/授权观察、扫描和红灯/冻结记录，不将这些原件提交公开 Git，也不把作者摘要代替原报告。实际人工批准/时钟认证仍为外部事实，仅静态检查可见记录和绑定。
7. 当前样本语义、独立静态结论、真实运行验收及源绑定证据分别满足后，才关闭本技术维护。历史施工前批准缺失仍公开记为流程偏差，不追补、不宣称历史流程全合规；否则保留 pending。
