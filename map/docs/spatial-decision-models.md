# 空间决策模型层（spatial-decision）

P3 决策模型层把「相关、模型解释、因果、预测、优化」分成五种互斥的结论形态，每种都自带前置条件、诊断、区间和诚实的降级标签。模型只经 `attribution_association`/`attribution_explain`/`attribution_effect`/`forecast_validate`/`forecast_fit`/`forecast_predict`/`scenario_compare`/`location_allocate` 八个普通 MCP 工具消费它；设计依据见[空间决策架构](../../.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md) §6.2（归因/预测/决策工具）与 §12.2（统计、归因与预测约束）。本包是纯库：无 host 服务、无 profile 行，tools 直接 import；方法版本 `p3-spatial-decision@2` 固定全部公式，spec 摘要键序无关。

## 方法契约（`contract.ts`）

三个 spec 族固定一次分析的全部输入：**AttributionSpec**（结果字段、1–8 个因子字段、处理字段与 treated 标记、识别设计 `covariate-adjustment`/`difference-in-differences`（可缺席——缺席时工具仍计算但标签降级）、pre/post 标记、面板单元字段、干扰带宽、区间水平 0.8/0.9/0.95）；**ForecastSpec**（训练窗 `[from, cutoff)`、特征可得性 `known-at-origin`/`concurrent`、粒度 day/week/month、模型族 `linear`/`threshold`/`quadratic-ridge`、基线 naive/mean、前推留出步数、空间分块米数、区间水平）与 **ForecastPredictSpec**（模型 artifact ref `art-…@vN`、预测起点资源、horizon 步数）；**ScenarioCompareSpec/LocationAllocateSpec**（需求组、候选方案、站点容量/成本、预算、`mode: greedy|global`、显式 `coverage/equity/cost` 权重——缺省时写进解析 spec 的是被打上 `defaultScenario` 标记的记录默认情景，绝不称唯一最优）。`validate*Spec` 一次返回全部结构化问题；协议常量（`BALANCE_SMD_LIMIT = 0.25`、`OVERLAP_SHARE_MIN = 0.8`、`INTERFERENCE_SHARE_LIMIT = 0.1`、`FEATURE_DRIFT_LIMIT = 0.5`、`MIN_THRESHOLD_LEAF_SAMPLES = 2`、`QUADRATIC_RIDGE_LAMBDA = 1`、`VIF_COLLINEAR_LIMIT = 5`）不是配置。

## 归因（`attribution.ts` + `causal.ts`）

- **association**：逐因子 Pearson/Spearman + 种子置换 p 值（p 的下界是 1/(count+1)，完美相关也绝不为 0）；常数结果/行数不足是诚实 `not_applicable`。claim level 恒为 `association`。
- **explain**：OLS 标准化贡献份额（|β·sd| 归一）、R²/调整 R²、VIF 共线诊断（近重复列照常报告，完全重复列按 `no-factor-variation` 拒绝）。claim level 恒为 `model-explanation`。
- **effect**：协变量调整（OLS + Student-t 区间）或两期 DiD（单元一阶差分 + Welch 区间）。诊断：逐协变量 SMD 平衡、包络重叠、干扰带宽内 control 的 treated 邻居暴露。**只有设计已声明、全部诊断通过、干扰已评估时 claim level 才是 `causal`**；缺设计、失衡、重叠不足、疑似溢出、未评估干扰分别具名降级到 `association`，无处理变异返回 `unknown`。causal 结果仍然声明「未观测混杂不被这些诊断排除」，适用域不外推。
- 限制文案固定声明：同源产物与探索性因子选择不是独立确认性证据；干预后反馈数据不自动作为验证。

## 预测（`forecast.ts`）

- **validate**：训练截止（`window.to`，迟到行具名排除）+ 末 `holdoutSteps` 个时间 bin 的时间前推留出 + 按 `blockMeters` 网格的分块验证行；线性、阈值、二次岭模型与声明的简单基线（naive/mean）并排报告 MAE/RMSE、skill = 1 − MAE_model/MAE_baseline、经验区间覆盖率。**concurrent 特征在 validate 被拒绝**（留出值在截止时不存在，属泄漏）。
- **fit**：线性趋势+特征 OLS、单特征单分割阈值模型或显式平方项岭回归，发布可复现的模型 artifact（系数、设计逆矩阵、σ、特征包络、逐行末观测、模型族与方法版本）。样本内 R² 明示不是预测能力。
- **predict**：读取模型 artifact（方法版本不匹配拒绝），模型含 concurrent 特征时拒绝（未来值不可知）；按序列化设计逐行预测 + t 区间 + naive/mean 基线；特征越出训练包络逐行具名 `outOfDomain`，特征均值漂移超过 0.5 个训练 sd 具名 `driftedFeatures`——从不静默外推。

## 方案优化（`optimize.ts`）

- **scenario_compare**：给定候选（≤16）对照隐含现状零点排序；目标 = w_cov·覆盖份额 + w_eq·最差组份额 − w_cost·归一成本（权重和归一）。不可行候选（超诺、超容量、超预算）保留具名原因且无排名；敏感性 = 固定扰动集（每权重 ×0.5/×2 再归一）逐情景重排并公开 `rankStable`。只比较给定候选，不是全局最优。
- **location_allocate**：默认是预算/容量约束下的贪心开门（边际目标增益，平局按 id），容量封顶的最近站点分配；`mode: global` 在声明的预算内站点域上做确定性有界穷举，返回枚举域、最优开站集、贪心目标值和差值，超过 `MAX_COMBINATION_NODES = 4096` 时具名拒绝并建议贪心或分区。预算外站点关门具名，容量缺口/未覆盖行保持诚实 `partial`；两种模式都用同一权重扰动集公开稳定性。

## 数值内核（`linalg.ts`）

偏主元高斯消元/ Gauss–Jordan 求逆、正规方程 OLS（奇异即拒绝）、正则化不完全 Beta 函数 + Student-t/正态分位数（bisection；夹具钉住 R `qt()`/`qnorm()` 公开值到 1e-9）、Pearson/Spearman（平均秩）。维度 ≤ 9，全部夹具可手算。

## 接入

- 工具：`map/tools` 的 `decision-model-tools.ts` 解析 catalog 版本字节 → 解析 spec（默认值显式写入）→ 校验 → 经 `requirePendingPublish` 的已接受调用配对发布 artifact（scenario_compare 为纯内联输入，不发布 artifact、不要求配对）→ 携带 `spatial-decision` 持久 meta（v1：工具、状态、claim level、方法版本、spec 摘要、headline、artifact refs、限制文案）；身份表八行 `family: 'decision-model'`，与 `catalog_register`/`geo_buffer`/`stats_*` 同列 `PUBLISH_TOOL_NAMES` 配对投影。
- 门禁归属见 [verification-matrix](verification-matrix.md) 的 `spatial-decision/` owner 行。

## 限制

- 因果识别与公平权重包含领域判断：机器校验只报告条件，不替用户做价值决定；权重的默认情景是显式标记的取值，不是客观最优。
- 本部署无工作区内成熟因果/预测依赖；交叉验证采用解析小样例、已发表分位数表、独立复算与包内第二实现对照；外部 provider 接入属后续阶段（设计 §13.1）。
- 预测模型限于线性、单阈值和二次岭三族；大规模分布式训练、实时反馈评价按设计 §3.2 的独立发布条件扩展。
