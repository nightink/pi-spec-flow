# Precision fixtures — frozen parent oracle, not model evidence

- `scenarios.json`：十三个脱敏合成场景与代码，不能声称复现任何外部产品。
- `oracle.json`：另存的 parent 预期分类、理由及实际观察值；无模型观测或独立评审含义。
- `manifest.json`：两文件分别冻结 hash；改变预期需显式说明理由，不能看模型输出后偷偷改答案。
- `review-precision-oracle.test.mjs`：验证输入/预期集合与 hash、源块定位，真实执行十一个**受信测试模块**核对观察值；不验证模型能发现问题。

未来真实模型探针必须获授权：只封存场景所需的合同、diff、选定 context 与声明的合成记录假设，**排除 oracle、测试断言、expected 分类及场景 ID 中的诊断提示**，否则不是盲测。保留实际 job/packet/raw/模型/usage/预算与逐项 parent 判读；实现 diff 审查与这一语义探针是不同证据，不能复用一次审查冒称两者。

静态 PASS 只评价供给的材料。runtime 场景中的 record 明示 synthetic assumption，不是真实 gate/浏览器执行；其最终交付仍须 human R1。并行跨度求和大于一天、不同 fork ID 计两会话均有明确口径，不能借不相关现场数据擅改定义。跨午夜反例特指本 fixture 的连续区间裁剪定义，不是对其他聚合定义的推断。

授权后的真实探针使用原十三场景加 `dispositions.json` 六个处置对照；`probe-plan.json` 在首轮真实输出前冻结单独判读规则和信任假设，原 oracle 字节不变。首场景同时有缺验收和可见静态断接，预先允许保留 gap 的 product-fail，不能为了单一类别掩盖另一层。批准正例只依显式外部 synthetic harness 假设，负例覆盖作者自述和待批准，不能宣称测试了生产批准真实性。

`tests/probes/review-precision.mjs prepare <绝对私有目录>` 仅生成十九个真实 engine prompt 的盲包，`score` 仅解码留存输出并按冻结规则对账；两者均不调用模型、不执行 fixture 模块或写生命周期。opaque ID 与原场景映射、预期分类、测试断言均不发送。模型分类命中还须 parent 逐项核验语义；运行记录及最终实测结果见仓库 evidence-precision 归档，不能把机械覆盖或 fake executor 填入真实指标。
