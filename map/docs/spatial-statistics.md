# 空间统计与时空模式层（spatial-statistics）

P2 统计层把「密度表达」与「显著性检验」分开：版本化方法契约、种子置换检验、多重检验校正、缺测不插补与时间前推留出。模型只经 `stats_zonal`/`stats_autocorrelation`/`stats_hotspot`/`pattern_change`/`pattern_cluster`/`pattern_flow` 六个普通 MCP 工具消费它；设计依据见[空间决策架构](../../.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md) §10.4（统计/模式工具）与 §12.2（统计科学约束）。本包是纯库：无 host 服务、无 profile 行，tools 直接 import；完整表格经 catalog 的发布配对落为不可变 artifact。

## 方法契约（`contract.ts`）

`StatisticSpec`/`PatternSpec` 固定一次统计的全部输入：精确资源 ref（`res-…@vN`）、数值字段与可选分母/分区字段、距离带宽权重（`bandMeters` 上限 500 km）、标准化（row/binary）、孤立单元规则（协议常量 `ISLAND_RULE = 'exclude-with-diagnostic'`）、置换次数（9–999，默认 199）与种子（默认 20260924，同种子逐位复现全部 p 值）、多重检验策略（fdr-bh 默认/bonferroni/none）、观察窗口（半开 `[from,to)`）、UTC 日历粒度（day/week/month）、覆盖率下限（默认 0.6）、前推留出块数、空间分块网格。`validate*Spec` 在边界一次返回全部结构化问题；`statSpecDigestOf` 是键序无关摘要——每个默认值都由工具层写进解析后的 spec，绝不藏在算法函数里。

## 数值方法与交叉验证（`stats.ts`/`weights.ts`/`rand.ts`）

- **zonal**：分区 count/missing/sum/mean/min/max/总体标准差（ddof=0），分母字段启用加权均值与 sum-rate，缺失分母逐单元具名排除。
- **全局 Moran's I**：稀疏边表实现 `I = (n/S0)·ΣΣw·z·z / Σz²`，`E[I] = −1/(n−1)`，全值置换 p 值；Cliff–Ord 闭式离散度（大样本近似，文档明示小样本以置换 sd 为准）。测试用独立稠密矩阵实现逐位交叉核对（1e-12），并用 **9! 全枚举**核对置换机制的均值/离散度。
- **LISA**：条件置换（焦点值固定）局部 I_i 与四象限分类；校正后 p 才进 0.05 显著性（协议常量 alpha）。
- **Getis-Ord Gi\***：自包含邻居和，置换 z 与独立稠密实现核对到 1e-9；热点/冷点标签是统计关联，绝不升级为因果结论。
- 适用性拒绝是诚实状态不是错误：有效单元 < 8、全常数场、带宽内零邻居分别返回 `not_applicable`（`too-few-valid-units`/`constant-field`/`no-weight-neighbors`），不发明 p 值；单元表上限 5000，证据表内联上限 256 行（全表走 artifact）。

## 时空模式（`patterns.ts`）

- **change**：两个有序子窗口（比较窗起点 ≥ 基线窗终点——时间前推在 schema 层强制）；单元缺任一窗口保持 unknown（不零填），覆盖率低于声明下限返回 `not_applicable('time-coverage-insufficient')`；稳定性 = 前缀（末 `holdoutBlocks` 个比较 bin 剔除）与全窗均值的漂移，外加按 `blockMeters` 网格的分块 delta 行。`unitField` 把多时相观测归并为同一空间单元。
- **cluster**：空间×时间的 DBSCAN（米 × 粒度 bin），噪声标注不硬塞簇；前推留出 = 前缀拟合后统计 holdout 观测被前缀核到达的比例。
- **flow**：实体链相邻观测贡献 cell→cell 迁移，链间隙超过 `maxGapBins` 断链计数（`never-interpolate`：绝不造中点），稳定性 = 前缀/全窗 top-K Jaccard。
- 窗外/迟到观测按 `LATE_DATA_RULE` 排除并具名；证据声明占用 bin 数/期望 bin 数/比率。

## 证据与表达（`evidence.ts` + `stat-meta.ts`）

- **谱系分组**：`groupEvidenceByLineage` 以排序后的输入 ref + 方法版本为谱系 id——同源产物归一组，绝不重复计为独立证据。
- **多尺度阶梯**：`compareScales` 对声明的带宽阶梯逐档重算真实统计（同种子），逐档记录 I/p/孤岛数；符号分歧即公开 `signAgreement: false` 的尺度敏感警告，绝不平均掉。
- **图例域**：`legendDomainOf` 从冻结结果数值一次性导出分位断点（quantile-5/7）——图层、图例、属性摘要与 evidence 引用同一方法版本与分类，渲染样本永不重算统计。
- 成功结果携带 `spatial-stat` 持久 meta（v1：工具、状态、方法版本、spec 摘要、headline 统计量、not_applicable 原因、artifact refs、限制文案）；模型 content 只携带有界摘要与限制，完整矩阵走 `art-…@vN` 引用。

## 接入

- 工具：`map/tools` 的 `stat-tools.ts` 解析 catalog 版本字节 → 解析 spec（默认值显式写入）→ 校验 → 经 `requirePendingPublish` 的已接受调用配对发布 artifact → 携带 `spatial-stat` meta；身份表六行 `family: 'stat-analysis'`、`metaKind: 'spatial-stat'`，与 `catalog_register`/`geo_buffer` 同列 `PUBLISH_TOOL_NAMES` 配对投影。
- 门禁归属见 [verification-matrix](verification-matrix.md) 的 `spatial-statistics/` owner 行。

## 限制

- 本部署无工作区内成熟空间统计依赖（Turf 无自相关/热点检验；新增外部依赖需改根 lockfile，超出 map 层边界），交叉验证采用解析小样例 + 独立稠密实现 + 全枚举 + Cliff–Ord 闭式四路对照；接入外部统计 provider 属后续阶段（设计 §13.1）。
- 服务器大数据分块、栅格 zonal、稳定性的预测区间口径等在负载证据具备后引入；本包不实现预测、归因或因果。
