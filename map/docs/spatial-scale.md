# 大规模分布式数据通道（spatial-scale@1）

本文是大规模数据通道能力的现行契约：版本化 `spatial-scale@1` 方法、不可变分块对象 provider（GeoParquet 风格 row-group，逐块 sha256 摘要与 bbox 索引）、有界 range/tile/query 读取、worker 子进程扫描平面（槽位背压、取消静止、超时不伪装、暂存资源全路径清理）、发布与溯源（暂存→校验→accepted-call 配对发布→引用）、以及固定 workload 基准（实测记录阈值）。设计依据：[空间决策架构](../../.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md)（「大数据不会通过模型 JSON 或单进程内存无界搬运」）与[审计结论](../../.spec/docs/2026-09-23_refactor-spatial-plan-audit_audit.md)（「性能阈值用固定硬件/数据基准确定，不能用文档承诺替代测量」）。

## 范围与不承诺

**做什么**：把一个已注册、已授权的资源版本复制为不可变分块版本；对版本做有界的范围/瓦片/查询读取（返回计数、聚合、游标、封顶样本，永不返回批量几何）；在独立 worker 进程里跑谓词扫描并把固定结论发布为目录产物；从会话日志引用的部件重建溯源记录；用冻结 workload 实测五项性能门。

**不做什么**：

- 不接 PostGIS/对象存储/COG 真实服务：首期唯一 provider 是本地分块对象 store（`map/spatial-catalog` store 根下的 `scale/` 区）；真实连接器按部署输入另行发布。
- 不承诺跨系统原子性：发布顺序是暂存 → 校验（digest+行数）→ 提交（manifest 最后落盘）→ 引用；文件与目录是两个系统，失败各自治愈，孤儿暂存按路径清理。
- 不承诺恰好一次网络执行：worker 至少一次运行，崩溃/超时不认领结果，游标+续跑重放保证结论一致。
- 不建设通用集群/队列/SQL 平台：没有 workload 证据不平台化（spec §3.3）。
- 大数据不进模型通道：模型摘要按构造有界（计数/聚合/游标），行载荷只进产物与封顶样本。

## 不可变版本（ingest）

- 版本身份 = 内容寻址：`scl-<resourceId>@<contentDigest 前 12 位>`。相同字节再摄取返回既有版本（幂等）；字节变化自动成为新版本，新旧版本互不失效。
- 布局：`versions/<resourceId>/<digest12>/manifest.json` + `chunks/<i>.ndjson`。行格式 NDJSON：`{i: 要素序号, g: 原始几何, p: 原始属性}`。
- chunk：固定行数的 row-group，各带 sha256 digest、字节长度、bbox。manifest 携带 schema（逐列观察类型）、geometryTypes、featureCount、nativeCrs、时间字段观察范围（可选）、授权域、chunk 索引、总字节、ingestedAt。
- 提交点唯一：manifest 最后落盘；没有 manifest 的版本目录是未完成暂存，任何读取都不可解析。摄取失败清空暂存目录，零残留。
- 来源可追溯：manifest 记录 `sourceRef`（注册资源 ref）与 `sourceDigest`；读取时的授权域检查与目录一致（域不符具名 `SCALE_FORBIDDEN`）。

## 有界读取（range/tile/query）

- **range**：连续 chunk 窗口，逐块 digest 验证后解析；字节与行预算超限在 I/O 前具名拒绝；返回 `nextChunk` 游标——断点续读由游标驱动，窗口钳制到版本末（`exhausted`）。
- **tile**：版本 bbox 上的 2^z×2^z WGS84 格网（非 web 墨卡托，诚实命名 extent grid）；先按 chunk bbox 整块剪枝（`chunksPruned` 计数），幸存块才读盘并验证 digest；样本按读取预算封顶并如实置 `truncated`。
- **query**：谓词（field/op/value，六算子固定集合）跨全版本折叠，O(1) 聚合（count/sum/min/max），样本按 `scanSampleRows` 封顶；非数值字段值是非匹配而不是崩溃。
- 所有读取：先解析 ref（外来形式 `SCALE_INVALID_REF`），再验授权域，再对 manifest 检查 digest 前缀；chunk 摘要不符是 `SCALE_IO` 错误——损坏字节拒绝扫描，绝不静默替换。

## Worker 进程平面

- 扫描在真实子进程执行（`process.execPath` + 私有暂存目录内的自包含 entry，凭据形环境变量全部剥离）；父子间是单行 JSON 协议（request in，progress/cancelled/result/failed out），双方不共享代码，谓词协议保持极小。
- **背压**：runner 持有至多 `jobSlots` 个存活子进程；超出的提交进入有界队列（`queueDepth`），计入 `heldByBackpressure`；满队具名拒绝而不是增长。
- **取消静止**：取消写 cancel 行，子进程在 chunk 边界停止；runner 只在子进程真正退出后结算。取消/完成竞争由子进程自己产生的终态消息裁决——先完成的仍是完整结果。
- **超时不伪装**：超预算的子进程被 kill，结算为 `failed(timeout)`，绝不伪装成 cancelled 或成功；崩溃（非零退出且无协议终态行）结算为 `failed(worker-crash)`，退出码与信号独立如实报告。
- **临时资源**：每个作业私有暂存目录（0600 entry），成功/取消/崩溃/超时/dispose 全路径 `finally` 清理。
- **断点**：每 chunk 一条 progress（chunksDone/rowsScanned/bytesScanned/matches）；崩溃后按游标续扫剩余块，`前缀 + 续跑 = 不间断` 逐字段成立（测试断言 count 与 sum）。

## 发布与溯源

- `scale_scan` 经 accepted-call 配对（`requirePendingPublish`）发布：产物 = 封顶样本 GeoJSON + 聚合与方法身份（digest、游标、截断标志），`inputRefs` 引用来源注册资源、继承其授权域。
- retry_of 只返回已发布产物（`lookupPublication`），缺记录具名 `OPERATION_NOT_PUBLISHED`，不重算、不重读可变源。
- 溯源记录（`buildScanRecord`）：资源块（ref/digest/manifest digest/sourceRef/CRS/块数/字节/域）+ 请求块（谓词/预算摘要）+ 作业块（终态/游标/checkpoint 轨迹）+ 产物引用 + 显示块（封顶要素数/截断标志/显示摘要）。整个记录由 sha256 钉定；重启/重算从会话日志引用的部件重建，任一部件漂移具名拒绝（`RECORD_MISMATCH`）。
- 模型摘要（`boundedSummaryOf`）只含计数/聚合/游标，8 KiB 硬上界；批量行载荷只存在于产物与封顶样本。

## 固定 workload 基准

冻结 workload：种子 20260925、24,576 行、2,048 行/块、均匀 WGS84 点、`value` 均匀 [0,1)、谓词 `>= 0.5`、并发 4、崩溃点 6 块。每次基准在新 store 上摄取完全相同的字节，因此每次运行的聚合必须逐位相等；只有墙钟与内存在阈值带内浮动。

五项门（记录于 `SCALE_RECORDED_THRESHOLDS`）：摄取吞吐、扫描吞吐、协调进程扫描堆增长、并发墙钟比、恢复续算墙钟。阈值是 2026-09-25 在 darwin arm64 / node v25.2.1 上的实测结果（三次运行：摄取 821,686–1,629,933 行/s、扫描 333,855–339,386 行/s、堆增长 0–392,072 B、并发比 1.039–1.061×、恢复 133–141 ms），取保守带（下限留约一个数量级余量、上限收紧）；未达门即基准失败，不用文档承诺替代测量。不同硬件先重录再比较。

## 工具面

三个工具由 tools 包承载（native 直调 for ingest/scan；read 允许嵌套分发），全部携带版本化 `spatial-scale` durable meta：

- `scale_ingest(source_ref, resource_id, chunk_rows?, time_field?)`：复制注册资源为不可变分块版本；幂等。
- `scale_read(resource_ref, kind, …)`：单一有界读取；range 返回游标，tile 返回剪枝计数，query 返回聚合；样本封顶 32 行进 content。
- `scale_scan(resource_ref, field, op, value, retry_of?)`：worker 进程扫描 + 配对发布；取消在子进程静止后才结算；retry 只回已发布产物。

存储根：`spatialCatalog.storeRoot()`（会话视图，返回该会话独立库根 `<root>/sessions/<sessionId>/`）下的 `scale/` 区（与目录同库同会话、同授权域；域检查在每次读取时独立执行；跨会话不共享）。
