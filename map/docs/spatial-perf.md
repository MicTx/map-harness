# 空间性能容量与基准门禁（spatial-perf@2）

本文是性能容量能力的现行契约：版本化 `spatial-perf@2` 方法、冻结 workload 与钉定 fixture 摘要、闭表分段测量词表、hard/estimated 分离的预算平面、同运行校准比值门与七条绝对门，以及 advisory 趋势/基线比较。设计依据：[空间决策架构](../../.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md)（§13.3 运行指标：分段耗时、峰值内存、Session/meta/投影字节、扫描量；「阈值在冻结测试集前由测量确定，文档不编造数字」）与[审计结论](../../.spec/docs/2026-09-23_refactor-spatial-plan-audit_audit.md)（D10：「一次输入合法但累计地图超限必须在提交前拒绝」；「性能阈值用固定硬件/数据基准确定」）。

## 范围与不承诺

**做什么**：冻结五个 workload 的输入（种子化生成 + 摘要钉定）；对真实生产面（session 投影折叠、目录事务发布、turf 运算、worker 子进程取消）做分段计时与字节/内存采样；在最终操作提交前检查累计 hard 预算；用冻结 workload 实测三条校准比值门、七条绝对门，并保留历史绝对吞吐 advisory 与趋势/基线比较。

**不做什么**：

- 不承诺百万要素/大栅格/网络 workload：首期五 workload 对应设计 §13.3 的首期基准清单，对应 provider 落地后另设 gate。
- 不测量浏览器帧渲染与真实 GUI 时延：`render` 段是 Node 侧显示派生（wire view 生成与校验）的成本；浏览器 paint 归 composition lane。
- 不强制供应商费用：`PerfEstimatedCost` 只记录，任何 admission 路径都不接受它——估计项永远不会拒绝 hard 预算允许的操作。
- 无测量证据不优化（spec §3.3）：本包只提供测量与门禁，不做没有基准依据的性能改动。
- Loader 启动时延归 Loader smoke lane，不在本包十门内。

## 冻结 workload

固定 workload（`PERF_WORKLOAD_FIXTURE`）：种子 20260925、每 workload 3 次重复、定位/显隐 12 层×200 要素（add→hide→show 各一折叠）、解析/发布 4,000 点要素、空间运算 20 次 buffer+area、恢复重放 24 次接受变更。fixture 由纯整数确定性 PRNG 生成，其规范内容摘要在 `PERF_FIXTURE_DIGEST` 钉定；基准每次运行前重新生成并校验——不匹配即响亮拒绝（fixture 变更是重录阈值事件，不是静默换字节比较）。跨次运行的 workload 聚合（折叠数、revision 增量、面积和、坐标计数）必须逐位一致；只有墙钟与内存在阈值带内浮动。

## 分段测量

闭表词表（`PERF_SEGMENTS`）映射设计 §13.3 的测量点：`context` 请求装配/参数序列化、`mcp` 编解码、`compute` 领域计算（admit 步进、turf、候选校验、冷重放）、`commit` 接受调用阶梯（tool/call + 成功 tool/result 的折叠+落盘）与目录事务发布、`flush` 耐久 checkpoint barrier（`ctx.sessions.flush`，rig 挂载真实 JSONL 后端）、`render` 显示派生（wire view）、`scan` 有界数据搬运（字节回读、ref 列举）、`cancel` 取消请求→worker 静止。

- **标签不带载荷**：标签键来自闭表（workload/stage/unit），值 ≤64 字符；把结果文档、几何或错误文本当标签在采样器处响亮拒绝。
- **失败不被吞**：抛错的被测函数先记录 `failed`（或标记后 `cancelled`）样本再原样重抛；采样器绝不把失败转成成功样本。
- **溢出显式降级**：记录缓冲定容；超容后 `degraded` 置位、逐样本计数丢弃——不无界增长，也不假装超额部分被测到。

## 预算平面

hard 预算（`PerfHardBudgets`）八项：session/meta/projection/display 四个字节平面与步数为**累计**判定（单项合法但累计越线照样拒绝），扫描行数与墙钟为**单次终局操作**判定，并发为槽位判定。`admissionFor` 是纯检查；`admitOrThrow` 在通过后记账——被拒提案零变更，调用方保留旧状态（workload 在拒绝路径先以无 meta 错误结果结算挂起调用，已接受地图逐字节不变）。预算在最终操作（发布、折叠）提交**前**检查，从不作为回滚出现。

## 校准探针

v2 的闭表校准词表只有 `compute-mix`。每个批次执行冻结的 JSON 序列化/解析、有界 `Map` 插入与插入序淘汰、每 256 单元一次的数值数组排序复制；单元不读时钟、不访问网络或文件、不导入 map 代码。规格为 50,000 units × 3 batches，工作摘要由 `PERF_CALIBRATION_WORK_DIGEST` 钉定，改规格或工作即要求重录阈值。

整轮先做一次不计入的 warmup，随后 locate、parse/register、spatial-op 的每个重复在被测区段开始前紧邻测一次探针。每个重复的比值为目标吞吐 ÷ 探针 units/s；门值是三个逐重复比值经包内 `medianOf` 统计量后的结果。探针读数离散度只进入 `calibration` 报告块，不参与门判定。

## 基准门禁

十门保持原有数量：三条吞吐门改为同运行校准比值门（`folds/unit`、`features/unit`、`ops/unit`），其余恢复冷重放、双点链路墙钟、取消→静止、flush barrier、显示派生、运行堆增长和重复离散度保持绝对判定。2026-10-08 忙宿主三次实录的比值门值为 locate 0.000122–0.000132、parse 0.265–0.298、spatial-op 0.000396–0.000425；记录下限分别为 0.0000610、0.132、0.000198。历史绝对吞吐带（2026-09-25）保存在 `PERF_ADVISORY_THROUGHPUT`，只作 advisory 趋势参考，不参与 verdict。不同硬件先重录再比较；跨 run 比较用 `compareWithBaseline`（异方法版本/异架构/异 workload 拒绝比较），趋势渲染用 `renderTrendReport`。

## 运行入口

- **CI gate**：`map/spatial-perf/tests/benchmark-gate.spec.mjs`（`node map/bin/test.mjs` 聚合第 14 lane）——固定 workload 双次完整运行，逐门断言、逐重复配对与聚合摘要跨次逐位相等。
- **诊断**：`pnpm --filter @map-harness/spatial-perf run bench [--json <out.json>] [--baseline <report.json>]`——输出 workload、校准块、十门（含比值分子/分母）、advisory、趋势和 verdict，可选写入 v2 JSON。缺失、损坏、缺字段或异版本基线分别具名拒绝或标记不可比；不带前导 `--`。两条入口都是 plain Node（`--experimental-strip-types`），不经 TSX。
- 基准经端口注入真实生产面（`tests/perf-rig.mjs`：真实 Session store + JSONL 持久后端 + 投影 registry、真实目录 store、真实 worker 子进程）；校准探针只依赖 Node 内建能力，src 零 map 依赖，sibling 包只在测试/诊断装配处经 src 相对导入。
