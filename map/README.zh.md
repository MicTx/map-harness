# Map Harness — 地图层插槽

[English](README.md) | 中文

map harness 基于 [DeepSeek Harness](../README.upstream.md)（上游）构建。本目录是本仓库**唯一的自有代码区**：品牌、地图工具、patches、profiles 全部在这里，通过上游官方扩展机制挂载，**不修改任何上游文件**。

## 插槽契约

上游以 Cordis patch 分层提供扩展点（bundle → profile patch → home patch → `--patch` overlay，按 id 覆盖行或 `insert:` 新行）。本仓库自有层只通过以下机制接入：

| 目录 | 职责 | 接入机制 |
|---|---|---|
| `tools/` | `@map-harness/map-tools` — 模型可见 `map_*` 容器工具 + `geo_*` 空间分析（Turf/proj4，WGS84 域）、数据链工具（`catalog_register`/`catalog_resolve`/`map_save`）、P0c `decision_update`、P1 run 作业工具（`run_submit`/`run_get`/`run_cancel`）与 P2 统计/模式工具（`stats_zonal`、`stats_autocorrelation`、`stats_hotspot`、`pattern_change`、`pattern_cluster`、`pattern_flow`）、P3 决策模型工具（`attribution_association`、`attribution_explain`、`attribution_effect`、`forecast_validate`、`forecast_fit`、`forecast_predict`、`scenario_compare`、`location_allocate`）、可视化工作台工具（`viz_create_style`、`viz_classify`、`viz_compare`、`viz_aggregate`）+ 协同工具（`map_apply_patch`、`map_undo`）+ 地形工具（`terrain_add_layer`、`geo_line_of_sight`、`terrain_viewshed`）+ 实时流工作台工具（`stream_open`、`stream_advance`、`stream_pause`、`stream_resume`、`stream_materialize`）+ 大规模分布式数据通道工具（`scale_ingest`、`scale_read`、`scale_scan`）、统一工具身份表（`spatial-catalog.ts`）、各持久结果 meta；`/mcp` 入口经内部 MCP provider 注册全部四十七个空间工具名，并登记嵌套 mutation guard | map-web host patch 注册 provider 与工具注册表；map-analyst preset 贡献 persona/context 行 |
| `arcgis-mcp/` | `@map-harness/arcgis-mcp` — 固定空间工具目录（五个 `map_*`、四个 `geo_*`、数据链 `catalog_register`/`catalog_resolve`/`map_save`、P0c `decision_update`、P1 `run_submit`/`run_get`/`run_cancel`、P2 `stats_*`/`pattern_*`、P3 `attribution_*`/`forecast_*`/`scenario_compare`/`location_allocate`、可视化工作台、协同对、地形对）的进程内 MCP server/provider；把调用绑定到可信 `ToolExecution` session 并委托给现有 handler | map-web host patch 提供服务与 `map-tools`；preset 消费宿主注册表 |
| `client-ui-brand/` | map harness 品牌插件（侧栏品牌行） | patch 按 id 覆盖 `ui-brand-official` 行，占 `sidebar.brand.*` 插槽 |
| `spatial-catalog/` | `@map-harness/spatial-catalog` — 事务化资源目录：复制进受控存储的不可变资源版本与稳定 featureRef、精确 ref 解析出冻结 RetrievalBundle、带权限继承的分析产物发布、敏感数据治理面（`spatial-governance@2`：宿主主体、租户键控且带单调版本的对象 ACL grant、带副本不召回说明的撤权/tombstone、审计 trail、按授权域隔离的解析缓存、受治理副本登记与具名召回拒绝）、发布配对 projection；其 plugin 行拥有进程级 `spatialCatalog` host 服务，以 `forSession(sessionId)` 会话视图路由，`dshHomePath('spatial-store')` 根下每对话一个独立 SQLite 库（会话间不共享行/字节/锁；跨会话 ref 按未找到应答） | map-web host patch insert 行；工具经 `ctx.get('spatialCatalog')` 消费（[空间目录](docs/spatial-catalog.md)、[敏感数据治理](docs/spatial-governance.md)） |
| `map-container/` | `@map-harness/map-container` — 权威 `mapContainer` 会话投影（P0a 提交协议：候选 `map-change` meta 只在成功结果被接受后折叠）、投影派生 `ctx.map` 只读面（Node）、ArcGIS MapView/SceneView 右栏 tab 与对话区 `conversation.view` tab（id `map`）、手势写通道（有界相机观察作为用户输入进入会话队列：运行中稳定观察 steer、页签显式提交 queue、程序化相机变更永不归因） | patch `insert:` 行 `map-container`；浏览器半经 `dsh.client` manifest |
| `spatial-context/` | `@map-harness/spatial-context` — P0c 空间上下文循环：DecisionFrame 领域（GoalContract/PlanState/EvidenceLedger 来源分权）、权威 `decisionFrame` 会话投影（含预算账本）、有界 pre-step 快照注入（可见 surface 去重、压缩/恢复/fork 后重建基线）、三类方法卡与 `decision-change` meta codec；host 行注册投影，agent 行注册 pre-step 监听 | map-web host patch insert 行 `spatial-context`；map-analyst preset 行 `@map-harness/spatial-context/agent`（[空间上下文](docs/spatial-context.md)） |
| `spatial-accessibility/` | `@map-harness/spatial-accessibility` — P1 可达性层：版本化 `AccessibilitySpec` 方法契约（study/retrieval/support 外延、observation/training 窗口、出行方式、阻抗、时间片、障碍、入口、容量、边界规则、直线探索标记）、受控路网/LBS provider（缺省）与经 Config 选择的高德、天地图、Mapbox、百度、腾讯 adapter、服务终态裁决取消/完成且 dispose 等待 worker 静止的持久 `run_submit`/`run_get`/`run_cancel` 存储、含守恒/容量/入口规则的人口加权网络覆盖、含可行性与敏感性的给定候选比较及固定 revision 导出；host 行注册 `spatialAccessibility` 投影与 run 服务 | map-web host patch insert 行 `spatial-accessibility`；工具经 `ctx.get('spatialAccessibility')` 消费（[空间可达性](docs/spatial-accessibility.md)） |
| `spatial-decision/` | `@map-harness/spatial-decision` — P3 空间决策模型库：版本化归因/预测/方案方法契约（`p3-spatial-decision@2`），claim level 永不升级的 association/explain 计算，带平衡/重叠/干扰诊断与诚实 `causal`/`association`/`unknown` 标签的受控效应估计（协变量调整、两期 DiD），带训练截止、简单基线、时间前推留出、空间分块、区间、漂移与域外状态的线性/阈值/二次岭预测验证/拟合/预测，以及显式覆盖/公平/成本权重、不可行候选与标记默认情景的受约束方案比较与贪心或有界全局选址分配；工具直接消费的纯库——无 host 行 | 工具直接 import 消费；产物经 catalog 发布配对发布（[空间决策模型](docs/spatial-decision-models.md)） |
| `spatial-viz/` | `@map-harness/spatial-viz` — 可视化工作台领域库与客户端面板：版本化 StyleSpec/LegendSpec 契约（`spatial-viz@1`，manual 断点必须给精确统计来源，`sty-…@v1` 版本不可篡改再生）、诚实分类（quantile 不同值秩中点、equal-interval、半开类、具名 missing/underflow/overflow、比率分类比值）、确定性时区感知时间轴状态机（缺测帧保留未占用标记；播放/暂停是纯 UI 状态、无模型通道），以及把图层、图例、属性表、图表和导出钉在同一 style/data/time revision 的共享筛选/分布图/属性行/导出清单词汇；map-container 浏览器半用同一库渲染工作台面板（图例、时间轴、可刷选分布图、分页属性表、固定 revision 导出） | 工具、map-container 协议（`set-style` 地图变更）与浏览器工作台直接 import 消费（[空间可视化工作台](docs/spatial-viz.md)） |
| `spatial-statistics/` | `@map-harness/spatial-statistics` — P2 空间统计与时空模式库：版本化 `StatisticSpec`/`PatternSpec` 契约（精确资源 ref、字段/分母、距离带宽度、标准化、孤立单元规则、置换次数/种子、多重检验策略、观察窗口、粒度、缺测规则、前推留出、空间分块网格），分区汇总、全局/局部 Moran's I 与 Getis-Ord Gi*（种子置换 + Cliff–Ord 闭式交叉核对）、带 `never-interpolate` 缺测约定与诚实 `not_applicable`/`partial`/`unknown` 状态的 change/cluster/flow 模式，以及证据谱系/多尺度/图例投影（统计、图例与证据同版本）；工具直接消费的纯库——无 host 行 | 工具直接 import 消费；产物经 catalog 发布配对发布（[空间统计](docs/spatial-statistics.md)） |
| `spatial-storage/` | `@map-harness/spatial-storage` — map 自有持久存储：`<root>/sessions/<sessionId>/` 每会话独立库（session id 在文件边界校验、清单由目录派生、整库删除仅显式 drop）、逐库版本化 schema 迁移（dry-run、写前备份、checksum、崩溃安全 journal）、分层且绝不覆盖的备份恢复、引用图 pin/lease、dry-run 先行的暂存/孤儿清理；Session 日志归上游，只按字节复制 | source 平面库，位于 spatial-catalog 服务之下（[存储生命周期](docs/storage-lifecycle.md)）；随 catalog 链入 profile |
| `presets/` | `map-analyst` agent preset（地图 persona + map/geo 工具）；组合 roster 保留上游 `standard`/`minimal`/`cordis` 可选，禁用 `ptc`（其 per-scope 呈现行会影子化 native-only 钉定） | `map/bin` 安装到 `$DSH_HOME/.agent-presets`（user root） |
| `profiles/` | map-harness profile 组装（base + web-app + map patches） | `dsh --profile map-web` |
| `bin/` | `map-harness` CLI wrapper（默认 `--profile map-web`；把 map 包链进 profile 并安装 preset），以及 `build.mjs`/`build-web.mjs`/`test.mjs` 聚合 | 调上游 launcher，不改上游 bin |
| `tests/` | map 自有工程门禁：拓扑/依赖方向、组合清单一致性、source/artifact 平面隔离、built 产物冒烟、真实 Loader 组合冒烟 | `node map/bin/test.mjs` 跑全部 map 套件 |
| `spatial-collab/` | `@map-harness/spatial-collab` — 协同提交面：版本化写者/patch/冲突词汇（`spatial-collab@1`）、纯串行提交引擎（expectedRevision 校验与接受同一段完成、逐 op 期望冲突返回可解释差异、删除不自动重放、operation id 幂等）、补偿撤销目标判定（matched / already-undone / changed）、写者 lease 生命周期（join、断线、重连、等待 in-flight 静止的 release、权限撤销）；纯库——协同工具与宿主写者服务直接消费；单服务器串行提交，不伪称分布式 CAS/CRDT，不承诺回滚外部资源 | 工具与宿主 plugin 直接 import 消费；map-container 的 fold 仍是唯一串行提交段（[空间协同](docs/spatial-collab.md)） |
| `spatial-terrain/` | `@map-harness/spatial-terrain` — 地形与视线库：版本化 `spatial-terrain@1` TerrainSpec（垂直 datum/units/epoch、水平 CRS、精确资源 revision、精度预算、采样策略、可选控制点）、格网高程面（双线性插值，洞与重复点具名拒绝）与建筑/体素障碍、采样视线计算（曲率/折射修正、firstObstruction 遮挡诊断、记录在案的切平面距离定义、声明误差预算内的掠射线诚实 `indeterminate`）、有界地形预览显示身份（revision 计入渲染 token；`TERRAIN_VERSION_CONFLICT` 钉住显示与分析同版本）；纯库——无 host 行 | terrain 工具直接 import 消费；fold 侧 terrain 图层身份在 map-container 的协议中（[地形与视线](docs/spatial-terrain.md)） |
| `spatial-realtime/` | `@map-harness/spatial-realtime` — 实时空间流库：版本化 `spatial-realtime@1` 契约（事件时间/到达时间/处理时间三钟分离、至少一次投递的 eventId 去重、watermark 与滚动窗口、有界迟到修订、数据缺口物化为可见 `empty` 窗口）、受控场景资源上的确定性 pull 驱动运行时（有界 intake 背压、单步配额、断线/重连、有界保留）、checkpoint 平面（有界编码/续跑、摘要钉定的物化导出经目录发布为不可变产物——引用场景版本、不改写已发布报告）；工作台状态搭载折叠图层记录的 `stream` 块，仅凭会话日志即可重放流——纯库，无 host 行 | stream 工具直接 import 消费；fold 侧流身份在 map-container 的协议中（[实时流](docs/spatial-realtime.md)） |
| `stream-providers/` | `@map-harness/stream-providers` — 真实流供应商接入库：版本化 `stream-providers@1` 契约（两族源——标准 SSE 端点与 OpenAI 兼容流式 completions 中继——九个闭合读取结局）、按名 cc-switch 凭据引用在打开源的执行轮解析（值只驻 reader 内存，绝不入配置/日志/报告）、停靠在途读取上的有界读轮与单轮事件配额、确定性多源融合引擎（2..8 源、逐源有界 pending 队列、单一融合事件时间水位——滞后源压住结论、干净终结源永不阻塞——`sourceId::eventId` 命名空间接入运行时首见去重、释放按线上批界分块）；host 插件加载时校验声明并提供脱敏 `streamProviders` 服务（list/verify 与 openFusion → fusionAdvance → pause/resume → closeFusion 调度面）——纯库加一行 host | 经 `streamProviders` 服务消费；融合批次喂给 `StreamRuntime.advanceLive`（[流供应商](docs/stream-providers.md)） |
| `spatial-scale/` | `@map-harness/spatial-scale` — 大规模分布式数据通道库：版本化 `spatial-scale@1` 契约（不可变内容寻址分块版本、逐块 sha256 摘要与 bbox 索引、schema/CRS/时间/授权元数据、manifest 为唯一提交点）、有界 range/tile/query 读取（digest 验证、游标断点续读、整块 bbox 剪枝、预算超限具名拒绝）、worker 子进程平面（槽位背压与有界满队拒绝、取消在子进程退出后才结算、超时 kill 结算为 failed 不伪造结果、崩溃不认领、暂存全路径清理）、发布与来源记录（scan record）平面（accepted-call 配对发布引用来源资源、retry 只回已发布产物、sha256 钉定记录从会话日志引用部件重建并具名拒绝漂移）、固定 workload 基准（五门对照实测记录阈值、跨次运行可重复）；纯库，无 host 行 | 规模工具经直接导入消费；scale store 位于目录服务的 store 根之下（[大规模分布式数据通道](docs/spatial-scale.md)） |
| `spatial-perf/` | `@map-harness/spatial-perf` — 空间性能容量库：版本化 `spatial-perf@2` 契约冻结基准 workload（种子化 fixture 与钉定内容摘要，五个 workload：定位/显隐、解析/发布、单次空间运算、恢复重放、双点链路）、闭表分段测量词表（context/mcp/compute/commit/flush/render/scan/cancel，采样只携带有界无载荷标签，容量溢出显式 degraded，失败/取消结果照样采样不被吞）、hard 累计预算（session/meta/projection/display 字节、单次终局操作扫描量与墙钟、并发槽位、步数）在最终操作提交前准入——具名拒绝并保留旧状态，供应商费用估计仅记录绝不强制——以及固定 workload 基准运行器：三条同运行校准比值吞吐门、七条绝对门、历史绝对吞吐 advisory、逐重复配对读数、跨次运行聚合摘要逐位一致、重复离散度稳定检查与趋势/基线比较；纯库，无 host 行 | CI 门禁为本包基准套件 lane（`node map/bin/test.mjs`）；诊断运行为 `pnpm --filter @map-harness/spatial-perf run bench`（[空间性能容量](docs/spatial-perf.md)） |
| `spatial-observability/` | `@map-harness/spatial-observability` — 空间观测运维库：版本化 `spatial-observability@1` 契约——规范关联身份（`op:<domain>:<sessionId>#<sourceCallSeq>` operationRef、runId、goalRevision、高基数 traceId）经 ambient scope 传播、闭表六值结果词表（succeeded/partial/failed/cancelled/outcome_unknown/degraded）与版本化错误码、低基数指标（闭表标签词表响亮拒绝载荷/trace id 入标签）、日志与导出共用的可见脱敏（凭据、几何载荷、文件系统路径）、结构化日志（warn/error/audit 永不采样、丢弃逐类精确计数）、六平面分离健康（派生 readiness 与审计迁移史）、确定性故障注入矩阵（flush/artifact-publish/provider/worker/render，解除后同点重放恢复全程审计）、字节有界的诊断导出（截断时优先保留审计事实）；遥测自身失败只计数（telemetry degraded）绝不阻塞空间主结果；纯库，无 host 行 | 采纳 correlation scope 的 map 自有面直接导入消费；runbook 与诊断流程见 [空间观测运维](docs/spatial-observability.md) |
| `spatial-connect/` | `@map-harness/spatial-connect` — 外部数据连接器（连接能力）：版本化 `spatial-connect@1` 契约——三族连接（PostGIS、S3 兼容对象存储、COG）、闭表十结局词表、跨类单一 id 命名空间、≤16 连接预算；受验证部署配置面——凭据字段是环境变量引用（值只在加载时一次性解析进内存，缺失/空值在加载时点名变量与连接响亮失败），任一泄露整条 detail 折叠脱敏；协议级连通/认证验证——PostgreSQL v3 wire 交换（SSL 协商 disable/prefer/require、SCRAM-SHA-256 含 ServerSignature 校验、MD5、cleartext、SQLSTATE 映射、帧违规绝不猜测续读）、SigV4 签名零键 ListObjectsV2（path/virtual-hosted 寻址、会话令牌入签、region 提示）、≤3 次 HTTP Range 校验 TIFF/BigTIFF 头（双字节序、tiled/striped、整对象 200 判 unsupported-channel）；全部读取受 deadline 包裹、abort 优先于 deadline、Terminate 收尾；keyless 脚本服务器契约 lane + 未设 `SPATIAL_CONNECT_*` 自跳过的 key-activated 复验 lane；只验证连接，不同步、不驻留任何数据 | map-web host patch insert 行（无默认 config，空声明组合出空注册表零凭据要求）；部署经配置消费，见 [外部数据连接](docs/spatial-connect.md) |
| `mcp-transport/` | `@map-harness/mcp-transport` — 远程 MCP transport 客户端面（接入能力）：版本化 `mcp-transport@1` 契约——两族连接（跨进程 stdio 子进程、远程 streamable-HTTP 端点）、闭表十一结局词表、跨类单一 id 命名空间、≤16 连接预算；受验证部署配置面——凭据字段是环境变量引用（stdio 的 `envRefs`、http 的 `tokenEnv`；值只在加载时一次性解析进内存，缺失/空值在加载时点名变量与连接响亮失败），detail 有界且不携带凭据值；真实传输上的协议正确交换——`initialize` 握手（服务器身份与协商协议版本可回读）、分页 `tools/list` 发现、`tools/call` 派发（`isError` 内容是结果，绝非失败）；每次交换受 deadline 包裹、调用方中止作为协议 `notifications/cancelled` 到达对端、静止拆除（stdio 子进程退出确认 + SIGKILL 兜底）；keyless 环回 fixture 契约 lane（真实子进程、真实 `node:http` 监听）+ 未设 `MCP_TRANSPORT_LIVE_URL` 自跳过的 key-activated 复验 lane；不部署远程主机——只做接入能力 | map-web host patch insert 行（无默认 config，空声明组合出空注册表零凭据要求）；部署经配置消费，见 [远程 MCP transport](docs/mcp-transport.md) |
| `mcp-transport/` | `@map-harness/mcp-transport` — 远程 MCP 接入平面：版本化 `mcp-transport@1`，支持跨进程 stdio 与 streamable HTTP，闭表十一结局词表、全局 id 命名空间与 ≤16 连接预算；配置只保存环境变量引用并在加载时解析凭据；真实 initialize、分页 tools/list、tools/call、deadline、协议取消与静止拆除；keyless 环回 fixture 与可选 live 端点 lane，不部署远程主机 | map-web host patch 插入行（无默认 config）；部署经配置消费，见[远程 MCP transport](docs/mcp-transport.md) |
| `docs/` | 地图层设计与决策记录；工程骨架见 [docs/engineering.md](docs/engineering.md) | — |

## 构建与运行

clean checkout 有两个构建 owner：上游根构建负责上游包，随后 map aggregate 构建 wrapper 链接的全部 map 包。`build-web.mjs` 会先运行 map aggregate，再重建 Web 前端。

```sh
pnpm install
pnpm run build
node map/bin/build-web.mjs
node map/bin/map-harness.mjs --no-open
```

上游产物与 Web 前端已是最新时，`node map/bin/build.mjs` 只重建四个 map runtime 包。

## 测试与工程门禁

`node map/bin/test.mjs [--build]` 按依赖序跑全部 map 自有套件：各包 source 平面测试、工程拓扑/清单门禁、built 产物冒烟、真实 Loader `--dump-config` 组合冒烟。浏览器级 composition e2e 单独成 lane（`pnpm --filter @map-harness/arcgis-mcp run test:composition`）。所有者、依赖方向、平面、Config/凭据/健康/关闭协议与发布检查清单见 [docs/engineering.md](docs/engineering.md)。

## 不变量（收口门禁）

1. **上游文件零内容修改**：`packages/`、`apps/`、`vendor/`、`scripts/`、`docs/`、`snapshots/`、根级上游配置全部保持原样，例外见 [UPSTREAM.md](./UPSTREAM.md) 的文档化清单（`pnpm-workspace.yaml` 的 `map/*` workspace 行、`packages/client/tsdown.client.ts` 的 CSS virtual-id 兼容补丁，以及登记在册的根级自有门面文件）。
2. **上游不感知 map 层**：上游代码不 import `map/` 内任何内容；`map/` 只经 patch/插槽单向接入。
3. **上游标识豁免**：上游文件内的 `@deepseek-ai/`、`dsh`、`DSH_*`、`FishLogo` 等字样是上游文件内容，随上游更新而来，不算本仓库品牌泄漏；本仓库品牌只呈现在 `map/` 层产物（浏览器品牌行、profile 名、CLI 名）。

## 上游更新

见 [UPSTREAM.md](./UPSTREAM.md)：新版本导入 → 零冲突检查 → 重装依赖 → 重建上游与 map 层 → 冒烟。

