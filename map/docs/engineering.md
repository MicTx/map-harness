# 工程骨架与发布集成

本文固化 map 层的工程承载：模块所有者、依赖方向、入口平面、配置/凭据/健康/关闭协议、测试归属与发布门禁。范围与验收见任务包 `.spec/specs/2026-09-24_add-spatial-engineering-foundation/`；地图能力设计见 `.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md`（该文是目标设计，不是当前实现文档）。运行机制的上游权威是 `docs/architecture.md` 与 `docs/testing.md`。

## 当前运行时约束

- 浏览器每会话只有一个右栏地图 occurrence，对话标题栏入口定位同一页签；`mapContainer` projection、Workbench 筛选/高亮/时间轴及手势目标均绑定该 Session。重复布局收敛、保留画布和异步卸载规则见 [地图绑定模型](map-container-binding.md)。
- projection 中的 GeoJSON `properties` 保留有界原值供分析和样式读取；ArcGIS `Graphic.attributes` 是独立的渲染投影，只接收有限标量并跳过原型键，不能把嵌套用户对象直接传给 SDK。
- 正常工具、collaboration patch、legacy replay 和 checkpoint restore 必须共用 GeoJSON admission；projection 同时受 feature/coordinate、数量和 UTF-8 字节上限约束，单独校验工具候选不足以保护持久状态。
- spatial catalog 按 `sessions/<sessionId>/` 隔离；重启验收必须先证明恢复了原 session identity，再证明 versioned resource/artifact 可读。
- map 记录的 requested WKID `4326` 在 World Imagery 场景可能由 ArcGIS Web-Mercator engine `3857` 渲染；导出和用户界面必须区分请求坐标系与实际 engine 坐标系。
- 新增网络 provider adapter 时，除 adapter 文件外必须同步 `map/spatial-accessibility/src/plugin.ts` 的 Config 面与 `map/spatial-accessibility/src/index.ts` 导出、`map/spatial-accessibility/tests/provider-config.spec.mjs`、fixture 与 key-activated contract lane（`map/spatial-accessibility/tests/vendor-contract.spec.mjs`）、`map/docs/verification-matrix.md` 的 owner 行登记，以及 `map/docs/spatial-accessibility.md` 与中英文 README 配对；只改 adapter 文件不算完成。
- 本机是长期忙宿主，load 常态约 4–9；2026-10-07 归档包 `.spec/specs/archive/2026-10-07_add-external-data-connectors/` 的 issue_0002 与 completion-summary 记录 load 6–9.3 时 locate 53–86 folds/s，基线 worktree 仍复现假红。本包 v2 以同运行校准比值门处理该环境差异，不以吞吐豁免完整聚合门禁。

## 模块所有者表

| 目录 | 包 | 职责与所有物 | 测试 | 文档 |
|---|---|---|---|---|
| `tools/` | `@map-harness/map-tools` | 模型可见 `map_*`/`geo_*` 工具定义、统一工具身份表（`spatial-catalog.ts`）、analysis-result meta（`geo-meta.ts`）、稳定错误码（`spatial-errors.ts`）、模型面 `type:'json'` 参数双形态解码（`json-param.ts`：字符串先 `JSON.parse`，畸形 `INVALID_ARGUMENT` 点名参数且不回显过长内容，解码后走既有形状校验）、MCP adapter（`/mcp` 入口 + 嵌套 mutation guard）、`arcgisMcp` 服务契约（`mcp-service.ts`） | `tools/tests/*.spec.mjs` | 本表；MCP 约定见 [arcgis-mcp.md](arcgis-mcp.md) |
| `arcgis-mcp/` | `@map-harness/arcgis-mcp` | 进程内 MCP server/provider：四十七工具 catalog 注册（5 `map_*` + 4 `geo_*` + 数据链 3 + `decision_update` + run 作业 3 + 统计/模式 6 + 决策模型 8 + viz 4 + 协同 2 + 地形 3 + 流工作台 5 + 规模通道 3）、execution token 绑定、transport 生命周期 | `arcgis-mcp/tests/arcgis-mcp.spec.mjs`、`lifecycle.spec.mjs`、`composition.e2e.mjs` | [arcgis-mcp.md](arcgis-mcp.md) |
| `map-container/` | `@map-harness/map-container` | 权威 `mapContainer` session projection（P0a 提交协议 `src/protocol.ts`）、投影派生 `ctx.map` 只读面（node 半）、会话唯一 ArcGIS 右栏 tab 与对话导航（browser 半） | `map-container/tests/*.spec.mjs`（含 `plugin.spec.mjs`、`projection.spec.mjs`） | [map-container-binding.md](map-container-binding.md) |
| `layers/` | `@map-harness/map-layers` | 图层呈现契约纯库：版本化 SymbolStyle（single 几何块 + 独占 heatmap 呈现，块透明度与层级透明度相乘）、逐要素 FeatureOverride（`ovr-…@v1`）、零密钥 ImagerySpec 瓦片准入（规范化 `{level}/{row}/{col}`）、组名词表、确定性 12 色 `autoSymbolOf`、`preset:<name>` 预设库（显式 resolve）、`legendOfSymbol` 单符号图例派生（色板带块透明度）；与 spatial-viz 分类权威正交的呈现权威；纯库无 host 行 | `layers/tests/*.spec.mjs`；折叠/工具消费证据见 `map-container/tests/`、`tools/tests/` | [map-layers.md](map-layers.md) |
| `spatial-storage/` | `@map-harness/spatial-storage` | map 自有持久存储库：单调 `SPATIAL_STORE_SCHEMA_VERSION` 与 forward-only 迁移（dry-run/backup-before-write/checksum/崩溃安全 journal）、备份 bundle 与分层不覆盖恢复、引用图/pin/lease、dry-run 先行的暂存/孤儿清理；Session 日志与 projection cache 归上游，本包只复制/丢弃 | `spatial-storage/tests/*.spec.mjs` | [storage-lifecycle.md](storage-lifecycle.md) |
| `spatial-catalog/` | `@map-harness/spatial-catalog` | 事务化资源目录（P0b）：不可变资源版本复制/摘要/featureRef 分配、精确 ref 解析与冻结 RetrievalBundle、分析产物发布（权限继承）、敏感数据治理（`spatial-governance@2`：宿主主体、租户键控 ACL grant 单调版本、撤权/tombstone 与副本不召回文案、审计 trail、授权域隔离缓存、副本登记与召回）、发布配对 projection、`spatialCatalog` host 服务（进程级路由 + `forSession` 会话视图；store 根为受验证 Config，profile 以 `dshHomePath('spatial-store')` 提供，每会话独立库 `sessions/<sessionId>/`） | `spatial-catalog/tests/catalog.spec.mjs`、`spatial-catalog/tests/governance.spec.mjs`、`spatial-catalog/tests/governance-tenant-recall.spec.mjs`；链路/入口证据 `tools/tests/catalog-chain.spec.mjs`、`tools/tests/governance-entries.spec.mjs` | [spatial-catalog.md](spatial-catalog.md)、[spatial-governance.md](spatial-governance.md) |
| `spatial-context/` | `@map-harness/spatial-context` | P0c 空间上下文循环：DecisionFrame 领域（GoalContract/PlanState/EvidenceLedger 来源分权）、权威 `decisionFrame` session projection（含预算账本）、有界 pre-step 快照注入（`./agent` 预设行）、三类方法卡（定位/拓扑/证据检查）、`decision-change` meta codec；`decision_update` 工具 handler 由 tools 包承载并委托本包领域逻辑 | `spatial-context/tests/*.spec.mjs`（loop 真实 loop keyless 快照） | [spatial-context.md](spatial-context.md) |
| `spatial-accessibility/` | `@map-harness/spatial-accessibility` | P1 可达性层：版本化 `AccessibilitySpec` 方法契约（三层外延/时间窗/方式/阻抗/时间片/障碍/入口/容量/边界规则/直线探索标记）、受控路网 provider（分页、故障码、检查点取消）、持久 `run_submit`/`run_get`/`run_cancel` 存储（服务终态裁决、worker 静止、孤儿裁决 `outcomeUnknown`）、天地图浏览器SDK通道（`tianditu-sdk-road-network`：浏览器端 Key 经真实 JS SDK 页面驾车，可选 peer `playwright`）、人口加权覆盖（守恒/容量/入口）、给定候选比较（可行性/敏感性/固定 revision 导出）、`spatialAccessibility` 投影与 host 服务（store 根为受验证 Config，profile 以 `dshHomePath('accessibility-store')` 提供） | `spatial-accessibility/tests/*.spec.mjs`；链路证据 `tools/tests/run-tools.spec.mjs` | [spatial-accessibility.md](spatial-accessibility.md) |
| `spatial-statistics/` | `@map-harness/spatial-statistics` | P2 空间统计与时空模式库：版本化 `StatisticSpec`/`PatternSpec` 方法契约（精确资源 ref、字段/分母、距离带权重、标准化、孤立单元排除、置换次数/种子、多重检验、观察窗口/粒度/覆盖率下限、缺测规则 `never-interpolate`、时间前推留出、空间分块网格）、zonal 汇总、全局/局部 Moran's I 与 Getis-Ord Gi*（种子置换 + Cliff–Ord 闭式离散度 + 独立稠密实现交叉核对）、change/cluster/flow 模式（时间前推、断链不插补、诚实 `not_applicable`/`partial`/`unknown`）、证据谱系分组/多尺度阶梯/图例域投影（同版本同分类）；纯库，无 host 行，`stats_*`/`pattern_*` 六工具由 tools 包承载 | `spatial-statistics/tests/*.spec.mjs`；链路证据 `tools/tests/stat-tools.spec.mjs` | [spatial-statistics.md](spatial-statistics.md) |
| `spatial-collab/` | `@map-harness/spatial-collab` | 协同提交契约与引擎：写者/patch/冲突词汇（`spatial-collab@1`）、串行提交引擎（CAS+接受单段、逐 op 期望、幂等 operation id）、补偿撤销目标判定、写者 lease 生命周期（in-flight 静止释放、权限撤销）；工具面 `map_apply_patch`/`map_undo`，宿主面 `ctx.spatialCollab` 写者服务 | `spatial-collab/tests/*.spec.mjs`；链路证据 `tools/tests/collab-tools.spec.mjs` | [spatial-collab.md](spatial-collab.md) |
| `spatial-viz/` | `@map-harness/spatial-viz` | 可视化工作台库与客户端面板：版本化 StyleSpec/LegendSpec 契约（`spatial-viz@1`、manual 断点需统计来源、`sty-…@v1` 版本再生校验）、诚实分类（秩中点 quantile、半开类、具名缺测/越界、比率分类比值）、确定性时区时间轴状态机（缺测帧、播放不逐帧触发模型）、共享筛选身份（`sel-…`）与固定 revision 导出清单；map-container 浏览器半的 Workbench 面板同库渲染 | `spatial-viz/tests/*.spec.mjs`；链路证据 `tools/tests/viz-tools.spec.mjs`；Web ARIA 见 composition lane | [spatial-viz.md](spatial-viz.md) |
| `spatial-decision/` | `@map-harness/spatial-decision` | P3 空间决策模型库：版本化归因/预测/方案方法契约（`p3-spatial-decision@2`）、association/explain（claim level 恒不升级）、受控效应估计（协变量调整、两期 DiD + SMD/重叠/干扰诊断 + t/Welch 区间 + 诚实降级标签）、线性/阈值/二次岭预测验证/拟合/预测（训练截止、简单基线、时间前推留出、空间分块、区间、漂移/域外）、方案比较与贪心/声明域全局选址分配（显式权重、不可行候选具名、标记默认情景、敏感性）；纯库，无 host 行，八个 `attribution_*`/`forecast_*`/`scenario_compare`/`location_allocate` 工具由 tools 包承载 | `spatial-decision/tests/*.spec.mjs`；链路证据 `tools/tests/decision-model-tools.spec.mjs` | [spatial-decision-models.md](spatial-decision-models.md) |
| `spatial-terrain/` | `@map-harness/spatial-terrain` | 地形与视线库：版本化 `spatial-terrain@1` TerrainSpec（垂直 datum/units/epoch、水平 CRS、精确资源 revision、精度预算、采样策略、可选控制点）、格网高程面（双线性、洞/重复点拒绝）与建筑/体素障碍、采样视线（曲率/折射修正、firstObstruction 诊断、切平面距离定义、不确定度内掠射线诚实 indeterminate）、有界地形预览显示身份（revision 进渲染 token，`TERRAIN_VERSION_CONFLICT` 钉显示-分析同版本）；纯库，无 host 行，`terrain_add_layer`/`geo_line_of_sight` 由 tools 包承载 | `spatial-terrain/tests/*.spec.mjs`；链路证据 `tools/tests/terrain-tools.spec.mjs`、`map-container/tests/terrain-display.spec.mjs` | [spatial-terrain.md](spatial-terrain.md) |
| `spatial-realtime/` | `@map-harness/spatial-realtime` | 实时流库：版本化 `spatial-realtime@1`（事件/到达/处理三钟分离、eventId 去重、watermark 滚动窗口、有界迟到修订、缺口 `empty` 物化）、确定性 pull 驱动运行时（有界 intake 背压、单步配额、断线/重连、开放窗口上界、有界保留驱逐）、checkpoint/物化平面（有界编码续跑、篡改摘要拒绝、摘要钉定导出经配对发布为不可变产物、重复物化幂等、已发布报告不被改写）；工作台状态搭载图层 `stream` 块，会话日志单独重放流；纯库，无 host 行，`stream_*` 五工具由 tools 包承载 | `spatial-realtime/tests/*.spec.mjs`；链路证据 `tools/tests/stream-tools.spec.mjs`、`map-container/tests/stream-display.spec.mjs` | [spatial-realtime.md](spatial-realtime.md) |
| `stream-providers/` | `@map-harness/stream-providers` | 真实流供应商接入库：版本化 `stream-providers@1`（SSE/completions 双族源、九闭合读取结局、停靠读取有界轮、按名 cc-switch 凭据执行轮解析——值只驻内存）、确定性多源融合（2..8 源、逐源有界 pending、融合事件时间水位：滞后源压结论/干净终结源不阻塞、`源id::事件id` 命名空间入首见去重、批界分块喂 `advanceLive`）；host 插件加载校验并提供脱敏服务面与融合调度面 | `stream-providers/tests/*.spec.mjs`；真喂链路 `stream-providers/tests/fusion.spec.mjs`（真实 loopback 双源 → StreamRuntime） | [stream-providers.md](stream-providers.md) |
| `spatial-scale/` | `@map-harness/spatial-scale` | 大规模分布式数据通道库：版本化 `spatial-scale@1`（不可变内容寻址分块版本、逐块 sha256+bbox、schema/CRS/时间/授权元数据、manifest 唯一提交点）、有界 range/tile/query 读取（digest 验证、游标断点续读、整块剪枝、预算超限具名拒绝）、worker 子进程平面（槽位背压+满队拒绝、取消静止后结算、超时 kill 即 failed、崩溃不认领、暂存全路径清理）、发布与溯源（accepted-call 配对发布、retry 只回已发布产物、记录 sha256 钉定与漂移拒绝）、固定 workload 基准（五门实测记录阈值）；纯库，无 host 行，`scale_*` 三工具由 tools 包承载 | `spatial-scale/tests/*.spec.mjs`；链路证据 `tools/tests/scale-tools.spec.mjs` | [spatial-scale.md](spatial-scale.md) |
| `spatial-perf/` | `@map-harness/spatial-perf` | 空间性能容量库：版本化 `spatial-perf@2`（冻结 workload 与钉定 fixture 摘要、五 workload、compute-mix 校准探针）、闭表分段测量（context/mcp/compute/commit/flush/render/scan/cancel、有界无载荷标签、溢出显式 degraded、失败/取消样本保留）、hard 累计预算（session/meta/projection/display 字节、单次操作扫描/墙钟、并发槽位、步数，最终操作提交前准入，具名拒绝保留旧状态；估计成本只记录不强制）、固定 workload 基准（三条同运行校准比值门、七条绝对门、历史绝对吞吐 advisory、聚合摘要跨次逐位一致、离散度/趋势/基线比较）；纯库，无 host 行；CI 门禁为其基准套件 lane，诊断命令 `pnpm --filter @map-harness/spatial-perf run bench` | `spatial-perf/tests/*.spec.mjs`（基准 gate 双次完整运行） | [spatial-perf.md](spatial-perf.md) |
| `spatial-observability/` | `@map-harness/spatial-observability` | 空间观测运维库：版本化 `spatial-observability@1`（规范关联身份 ambient 传播、六值结果词表、版本化错误码、低基数闭表指标、可见脱敏、审计日志永不采样丢弃、六平面分离健康与派生 readiness、确定性故障注入矩阵与重放恢复、字节有界审计优先的诊断导出）；纯库，无 host 行 | `spatial-observability/tests/*.spec.mjs`（correlation.spec 走真实 Session/JSONL flush/SQLite 目录） | [spatial-observability.md](spatial-observability.md) |
| `mcp-transport/` | `@map-harness/mcp-transport` | 远程 MCP transport 库（接入能力）：版本化 `mcp-transport@1`（两族连接 spec：stdio 跨进程子进程/streamable-HTTP、闭表十一结局词表、id 单命名空间、≤16 连接）、受验证配置面（凭据字段是环境变量引用，值只在加载时一次性解析进内存，缺失即 `MCP_TRANSPORT_CREDENTIAL_MISSING` 点名变量）、协议级交换（initialize 握手、分页 tools/list、tools/call；isError 内容是结果非失败；JSON-RPC error 按阶段映射）、每次交换受 deadline 包裹、abort 作为协议 cancelled 到达对端、静止拆除（在途 settle + 子进程退出确认 + SIGKILL 兜底）；keyless 环回 fixture 契约 lane + key-activated 复验 lane（自跳过）；不部署远程主机 | `mcp-transport/tests/*.spec.mjs`（stdio/http 走真实子进程与 node:http 监听） | [mcp-transport.md](mcp-transport.md) |
| `spatial-connect/` | `@map-harness/spatial-connect` | 外部数据连接库（连接能力）：版本化 `spatial-connect@1`（三族连接 spec：PostGIS/对象存储/COG、闭表十结局词表、id 单命名空间、≤16 连接）、受验证配置面（凭据字段是环境变量引用，值只在加载时一次性解析进内存，缺失即 `CONNECT_CREDENTIAL_MISSING` 点名变量；detail 整条脱敏）、协议级连通/认证验证（PostgreSQL v3 wire：SSL 协商 + SCRAM-SHA-256 含 ServerSignature 校验/MD5/cleartext；SigV4 签名 ListObjectsV2 max-keys=0；≤3 次 Range 读 TIFF/BigTIFF 头）、deadline 包裹全部读取、abort 贯穿、帧违规判 protocol-violated、Terminate 收尾；keyless 脚本服务器契约 lane + key-activated 复验 lane（自跳过）；空连接声明仍为空注册表；同一 host 另提供可选 spatialSearch 天地图检索服务，经环境引用启用，由 catalog_register.online 登记结果 | `spatial-connect/tests/*.spec.mjs`（postgres/objectstore/cog 走真实 socket/fetch 语义的脚本服务器） | [spatial-connect.md](spatial-connect.md) |
| `client-ui-brand/` | `@map-harness/client-ui-brand` | 侧栏品牌行（browser 半） | 覆盖于 composition e2e（品牌行渲染） | 上游 README 槽位表 |
| `profiles/` | `@map-harness/map-web` | map-web bundle：`cordis.patch.yml` 组合面（品牌、右栏聚焦、native 工具呈现、三个 insert 行） | `map/tests/loader-smoke.spec.mjs`（真实 Loader） | 本文「Loader 组合」 |
| `presets/` | —（用户根组合） | `map-analyst` agent preset：persona + 工具行 | composition e2e 断言安装与工具集 | [arcgis-mcp.md](arcgis-mcp.md) |
| `bin/` | —（启动/构建包装器） | `map-harness.mjs`（调用上游 launcher）、`build.mjs`（map 聚合构建）、`build-web.mjs`、`test.mjs`（测试聚合） | `map/tests/loader-smoke.spec.mjs`、`built-smoke.spec.mjs` | 本文；[../UPSTREAM.md](../UPSTREAM.md) |
| `release/` | —（发布包启动脚本） | `install.cmd`/`install.sh`（调 `bin/setup.mjs`：Node 校验、镜像探测、依赖安装）、`start.cmd`/`start.sh`（调 `map-harness.mjs web`）；`bin/pack-runtime.mjs` 打包预编译运行包 | `map/tests/runtime-release.spec.mjs` | [github-release.md](github-release.md) |
| `tests/` | —（map 级工程门禁） | 拓扑/依赖图/清单一致性（`topology.spec.mjs`）、exports/source 平面（`build-exports.spec.mjs`）、built 冒烟与 JSDoc（`built-smoke.spec.mjs`）、真实 Loader 冒烟（`loader-smoke.spec.mjs`） | 自身即检查 | 本文 |
| `docs/` | — | map 层设计与决策记录 | —（拓扑门禁校验目录覆盖） | 自身 |

## 依赖方向

静态依赖只允许自上而下；反向即拓扑门禁失败（`map/tests/topology.spec.mjs`）：

```text
profiles/map-web（bundle 行） ─┐
map-web host 行 ────────────────┼→ tools ─→ map-container ─→ 仅上游（@deepseek-ai/*、外部库）
presets/map-analyst（agent 行） ─┘
                               │        ├→ spatial-catalog ─→ spatial-storage（仅 Node 内建模块 + @deepseek-ai/*）
                               │        ├→ spatial-context ─→ map-container（类型面；仅 Node 内建 + @deepseek-ai/*）
                               │        ├→ spatial-accessibility（仅 Node 内建 + @deepseek-ai/*）
                               │        ├→ spatial-statistics（仅 Node 内建）
                               │        ├→ spatial-decision ─→ spatial-statistics（权重/置换内核复用）
                               │        └→ spatial-viz（无 map 依赖；tools 与 map-container 单向消费）
                               └→ arcgis-mcp ─→ tools
spatial-perf（独立，仅 Node 内建 + @turf/turf；经端口注入真实投影/目录/worker 面）
spatial-observability（独立，仅 Node 内建；ambient scope 经 AsyncLocalStorage 传播关联身份）
spatial-connect（独立，Node 内建 + schemastery/zod；提供连接验证和可选空间检索，tools 单向消费；凭据只经环境引用进入）
mcp-transport（独立，仅 Node 内建 + @modelcontextprotocol/client + vendored schemastery 配置面；凭据只经环境引用进入）
client-ui-brand（独立，仅上游）
```

- 包内每条 bare import 必须在该包 `package.json` 声明（dependency hygiene，与上游 `verify-package-dependencies` 同规则）。
- 上游目录（`packages/`、`apps/`、`scripts/`、`vendor/`、`website/`、`native/`、`python/`、`benchmarks/`、`docs/`）禁止 import `@map-harness/*` 或以相对路径进入 `map/`；唯一允许的上游差异是 `pnpm-workspace.yaml` 的 `map/*` glob（见 [../UPSTREAM.md](../UPSTREAM.md) 零冲突检查）。
- wrapper 链接集 = 构建集聚合 ∪ `map-web`；patch insert 行 ⊆ wrapper 链接集；preset 行解析到 workspace 包及其 exports 子路径。三者由拓扑门禁交叉校验，防止漂移。

## 平面与入口

| 平面 | 消费者 | 入口 | 证据 |
|---|---|---|---|
| source | 测试（`node --test --experimental-strip-types`，相对 `.ts` 导入） | `*/src/*` exports 子路径 | `build-exports.spec.mjs`：map 测试禁止 bare `@map-harness/*` 与 map 包 `lib/` 导入，杜绝双 singleton |
| artifact（node） | Loader/profile 链接 | `lib/index.js`、`tools/lib/mcp.js` | `built-smoke.spec.mjs`：plain Node 导入，具名 plugin 契约（`name`/`inject`/`apply`），无 `default` 导出 |
| artifact（web） | 浏览器 module loader | `lib/client.js`（closure-factory，`window.__ModuleLoader__.load` banner） | `built-smoke.spec.mjs`：banner/factory 结构 |
| preset | 用户根 `~/.agent-presets/map-analyst` | wrapper 首次启动复制 | `loader-smoke.spec.mjs`、composition e2e |

类型契约：`tsc -b` 产出 `lib/types`（各包 tsconfig references 指向上游项目）；map 层 JSDoc 由 `built-smoke.spec.mjs` 对生成 `.d.ts` 的导出逐一校验（上游 `verify-export-jsdoc` 只扫 `packages/*/*/src`）。

## Loader 组合与工具呈现

- profile 栈：`dsh-base → dsh-web-app → @map-harness/map-web`（bundle patch）→ 用户 `cordis.patch.yml` → `--patch` overlay。
- map-web patch 钉死 `tools.config.mode: native`：`ptc`/`both` 会把模型工具面折叠到 `run_code`，地图工具与 MCP dispatch 仅对 native schema 路径验证（嵌套 PTC dispatch 会丢 `presentationMeta`）。该 patch 整体替换 web-app 行的 `DSH_TOOLS_MODE` env 引用，继承的 `DSH_TOOLS_MODE=ptc|both` 无法改变组合结果（`loader-smoke.spec.mjs` 负向断言；composition e2e 断言模型工具集无 `run_code`）。
- 固定工具集：四十七个空间工具（`map_*` 八个 + `geo_*` 五个 + 数据链 `catalog_register`/`catalog_resolve`/`map_save` + P0c `decision_update` + P1 `run_submit`/`run_get`/`run_cancel` + `stats_*`/`pattern_*` 各三 + `attribution_*`/`forecast_*` 各三 + `viz_*` 四 + `scale_*`/`stream_*`（五个）+ `terrain_add_layer`/`geo_line_of_sight`/`terrain_viewshed`/`scenario_compare`/`location_allocate`）全部经内部 MCP provider（tools/list 冻结 + tools/call dispatch），preset 另有上游原生 shell/fs/todo 行；身份表 `SPATIAL_TOOL_CATALOG` 固定 public=raw 名、family、owner 与 meta 版本（canonical 计数以该表为准），工具重名由上游 ToolRuntime 拒绝（`lifecycle.spec.mjs` 正向证明）。design 文档 §15.4 的 13 工具集、P1 run 作业工具与 P2 统计/模式工具现已齐全。
- 组合健康检查（keyless）：`map/tests/loader-smoke.spec.mjs` 检查真实 wrapper 的 `--dump-config`、全部 host/preset 行、disabled 行、`mode: native` 与 wrapper 声明的完整链接集；具体清单随 `map/bin/map-harness.mjs` 与 profile 更新，不另维护数量。
- 注意：Loader 对「行名无法 import」只降级为 warning 继续启动（上游行为）；map 层因此把行名可解析性放进拓扑门禁（CI 阶段拦截）。host `map-tools` 与 `arcgis-mcp` 的 effect 按 profile 顺序激活，provider 缺失时 MCP adapter activation 快速失败（见下）。

## Config、凭据、健康与关闭

- **Config**：部署差异由各 Cordis 行的受验证 Config 承载，缺失或非法配置在加载期响亮失败，不静默回退。LBS 缺省为受控格网；高德、天地图、天地图浏览器SDK（`TIANDITU_SDK_KEY`，浏览器端 Key 走真实 JS SDK 页面而非 REST）、Mapbox、百度、腾讯的选择、凭据引用与可选 `baseUrl` 见 [spatial-accessibility.md](spatial-accessibility.md)。天地图 JS API 加载器在 onload 后第二阶段才注入服务类（立即检查会误判为无服务类的残缺构建）；SDK 页面等待至多 10 秒再判定，真 stub 归可重试的 `TEMPORARILY_UNAVAILABLE`，不作代码缺陷归因。工具名、CRS 格式等协议常量与工作区逃逸拒绝等安全不变量不配置化。
- **环境引用**：`MAPHARNESS_HOME` 由 wrapper 转发为 `DSH_HOME`；供应商环境变量名由对应 Config 的凭据引用指定，其余环境原样透传。
- **凭据**：LBS、[外部数据连接](spatial-connect.md)与[远程 MCP](mcp-transport.md)的配置只保存环境变量引用；[流供应商](stream-providers.md)按名解析 cc-switch 凭据。值只在运行时内存持有，不入配置默认值、日志或诊断。模型凭据仍由上游提供者管理；ArcGIS 底图当前使用 keyless 瓦片。
- **启动失败**：built 产物缺失 → wrapper 退出码 1 并给出构建命令（`loader-smoke.spec.mjs`）；MCP adapter 在 host 无 `arcgisMcp` provider 时 activation 报错（`lifecycle.spec.mjs`）；MCP catalog 出现未知/重复/缺失工具名时 provider 初始化即抛错（`arcgis-mcp.spec.mjs`）。
- **abort**：ToolRuntime AbortSignal 贯穿 MCP client 调用；map mutation 入口与文件 IO 后各检查一次，geo 工具在入口检查一次（后续计算同步），已中止的执行不返回可折叠候选、不返回 analysis meta。取消后的结果由 loop 记为无 meta 的错误结果，投影按失败准入不动权威地图（`lifecycle.spec.mjs` 确定性 barrier，含 geo 在途取消与 dispose）。
- **dispose/quiescence**：fiber dispose → unprovide service → abort 在途调用并等待本地 handler 结算（`Promise.allSettled`）→ 关闭双向 transport；dispose 幂等，之后调用报 `disposed`，且在途调用结算前 dispose 不返回（`lifecycle.spec.mjs` 确定性 barrier）。`ctx.map` 只读面随插件 fiber 卸载，重挂载得到全新折叠（HMR 语义，`map-container/tests/plugin.spec.mjs`）。
- **就绪**：keyless 组合健康 = `--dump-config`；完整启动就绪 = web URL 行 + HTTP 200（composition e2e 实测）。

## 测试矩阵与快照归属

能力→证据层（unit/integration/Loader/snapshot/numeric/perf/ops）全矩阵、回放 fixture 清单、资源可靠性约定与 out-of-scope 记录的权威清单见 [verification-matrix.md](verification-matrix.md)，由 `map verification matrix gate` 套件机器校验；本表只保留逐套件命令。

| 面 | 套件 | 命令 | 前置 |
|---|---|---|---|
| 容器/协议/projection/occurrence | `map-container/tests/*.spec.mjs`（`map-rig.mjs` 共享真实 Session 投影 rig） | `pnpm --filter @map-harness/map-container run test` | 上游 `pnpm run build` |
| 工具/GIS 数值/提交协议/run 链路 | `tools/tests/*.spec.mjs`（`numeric-answers.spec.mjs` 为解析答案数值门禁） | `pnpm --filter @map-harness/map-tools run test` | 同上 + `@map-harness/map-container` 构建（handler 运行时依赖其 lib） |
| 可达性契约/provider/run 存储/覆盖/比较 | `spatial-accessibility/tests/*.spec.mjs`（source 平面） | `pnpm --filter @map-harness/spatial-accessibility run test` | 上游 `pnpm run build`（deps） |
| 统计/模式契约/数值/证据谱系 | `spatial-statistics/tests/*.spec.mjs`（source 平面，含 9! 全枚举与稠密实现交叉核对） | `pnpm --filter @map-harness/spatial-statistics run test` | 上游 `pnpm run build`（deps）+ 本包 `tsdown`（tools 链路经 built 入口解析 bare import） |
| 统计/模式工具链路（配对/发布/meta/拒绝路径） | `tools/tests/stat-tools.spec.mjs`（并入 tools lane） | `pnpm --filter @map-harness/map-tools run test` | 同上 + `@map-harness/spatial-statistics` 构建 |
| 决策模型契约/数值/归因/预测/优化 | `spatial-decision/tests/*.spec.mjs`（source 平面，t/正态分位数对照公开值） | `pnpm --filter @map-harness/spatial-decision run test` | 上游 `pnpm run build`（deps）+ 本包 `tsdown`（tools 链路经 built 入口解析 bare import） |
| 决策模型工具链路（配对/发布/meta/claim level/拒绝路径） | `tools/tests/decision-model-tools.spec.mjs`（并入 tools lane） | `pnpm --filter @map-harness/map-tools run test` | 同上 + `@map-harness/spatial-decision` 构建 |
| 可视化契约/分类/时间轴/联动导出 | `spatial-viz/tests/*.spec.mjs`（source 平面；环境无关纯库，浏览器同源复用） | `pnpm --filter @map-harness/spatial-viz run test` | 上游 `pnpm run build`（deps）+ 本包 `tsdown` |
| 可视化工具链路（发布配对/set-style 折叠/统一分类域/拒绝路径） | `tools/tests/viz-tools.spec.mjs`（并入 tools lane） | `pnpm --filter @map-harness/map-tools run test` | 同上 + `@map-harness/spatial-viz` 构建 |
| MCP 协议/会话绑定/取消/dispose | `arcgis-mcp/tests/arcgis-mcp.spec.mjs` + `lifecycle.spec.mjs` | `pnpm --filter @map-harness/arcgis-mcp run test` | 同上 |
| 存储迁移/备份/引用保护/清理 | `spatial-storage/tests/*.spec.mjs`（source 平面，仅 Node 内建模块，无构建前置） | `pnpm --filter @map-harness/spatial-storage run test` | 无 |
| 性能容量（契约/采样/预算/workload/基准 gate） | `spatial-perf/tests/*.spec.mjs`（source 平面，rig 注入真实投影/目录/worker 面） | `pnpm --filter @map-harness/spatial-perf run test` | 上游 `pnpm run build` + map 包构建（rig 经 src 解析 sibling 包） |
| 观测运维（契约/脱敏/指标/健康/故障注入/correlation） | `spatial-observability/tests/*.spec.mjs`（source 平面，correlation rig 挂真实投影/持久后端/目录） | `pnpm --filter @map-harness/spatial-observability run test` | 上游 `pnpm run build` + map 包构建（rig 经 src 解析 sibling 包） |
| 外部连接（配置面/凭据引用/协议验证/keyless 契约 lane + live 复验） | `spatial-connect/tests/*.spec.mjs`（source 平面，脚本服务器承载真实 socket/fetch 语义） | `pnpm --filter @map-harness/spatial-connect run test` | 无（仅 Node 内建；live lane 未设 `SPATIAL_CONNECT_*` 自跳过） |
| 远程 MCP 接入（配置面/凭据引用/协议交换与派发/keyless 契约 lane + live 复验） | `mcp-transport/tests/*.spec.mjs`（source 平面，真实 stdio 子进程与 node:http 环回监听承载协议路径） | `pnpm --filter @map-harness/mcp-transport run test` | 无（live lane 未设 `MCP_TRANSPORT_LIVE_URL` 自跳过） |
| 工程门禁（拓扑/清单/平面/built/JSDoc/Loader/可靠性/built 重放/矩阵一致性/发布与品牌隐私） | `map/tests/*.spec.mjs` | `node map/bin/test.mjs --build` | 同上 |
| 真实 Loader + 浏览器 + 模型供应商替身 | `arcgis-mcp/tests/composition.e2e.mjs` | `pnpm --filter @map-harness/arcgis-mcp run test:composition` | `node map/bin/build-web.mjs` + Playwright |

聚合入口：`node map/bin/test.mjs [--build]` 按依赖序跑表内各聚合 lane；composition e2e 单独成 lane（需要 web 构建与浏览器）。

**快照归属**：`snapshots/session/map-analyst-turn` 保存真实模型经 map-analyst 组合执行的资源注册、解析、缓冲与上图链路，以及 spatial-context 注入文本；keyless 回放检查已录制行为。各分析模块的 schema 与 content 覆盖、真实供应商证据和未录制行为以 [verification-matrix.md](verification-matrix.md)「门禁归属、刷新规则与审查流程」为准。`map/tests/glm-deepseek-parity.spec.mjs` 只检查已提交语料的共同结构，不代表新的真实供应商请求通过。

## 已知陷阱

- ArcGIS 4.x 2D `TextSymbol` 从 `static.arcgis.com/fonts/` 加载字形 PBF，只有托管字体存在（如 `noto-sans-regular`）；`microsoft-yahei` 这类缺失字体返回 404，整层停止绘制。需要系统字体（微软雅黑）的地图标注走 `map/map-container/src/client/label-overlay.ts` 的 HTML 覆盖层。
- 标签覆盖层在相机移动期间隐藏（`view.stationary` 为假），静止后重排再显示；ArcGIS 属性监听合批，逐帧重投影仍会滞后一到两帧，不要再往 `watch(readCamera)` 上加跟随逻辑。描边用不透明 `-webkit-text-stroke` 加 `paint-order`，不用 `text-shadow` 模糊外发光。
- 要素没有符号时 ArcGIS 渲染为黑色默认符号，`symbolFor` 必须始终返回符号。无声明符号的图层由 `@map-harness/map-layers` 的 `inferredSymbolOf`（图层名与 id 关键词）推断语义，地图、图层芯片、工作台图例三处共用它；`map-container` 读 `map/layers/lib`，改 `layers/src` 后必须重建（`tsc -b` 加 `tsdown`），否则 `map-container` 测试报缺少导出。
- 地图 composition e2e 收尾时先 `stopProcessTree(app)`，再 `provider.closeAllConnections()` 与 `provider.close()`；先关假 provider 会被应用的 keep-alive 连接挂住，直到 240 秒测试超时。
- 修改 spatial-context `预算:` 行格式时，同一改动必须更新 `packages/test-support/session-snapshot/src/identity.ts` 的 `SPATIAL_BUDGET`；否则 `elapsed` 时钟值漏进刷新后的 map 快照，下一次回放失败。

## 品牌与版本标识

- 产品标题固定为「探索未至之境 x Map Harness」，第二行为版本标识。版本标识只由私有构建环境变量 `DSH_CLIENT_MAP_ORG_NAME` 提供单位名称；未设置时显示「社区版」。真源是 `map/client-ui-brand/src/client/edition.ts`，`map/bin/build-web.mjs` 同步生成浏览器标题。
- 真实单位信息不得进入 GitHub 的源码、注释、测试、构建产物、提交信息、说明或截图；Unicode 转义等可逆编码不算脱敏。公开默认显示「社区版」，测试只用虚构名称。私有化构建变量必须覆盖整条构建链，例如 `DSH_CLIENT_MAP_ORG_NAME='示例部署单位' node map/bin/build-web.mjs`；该入口把同一变量传递给上游与 map 的整条构建链。
- 公开构建先校验公共环境，执行项目清理器并清除其余发布输出，再完整重建上游与 map 包，对源码和运行包输入生成摘要记录；打包器与发布器必须检查实际暂存目录的完整文件集合和字节。私有构建、缺记录、源码或产物变化均拒绝公开发布；清空环境变量不能洗白旧私有构建。发布步骤见 [github-release.md](github-release.md#品牌隐私)。
- `map-analyst` 预设的显示名称为「地图分析模式」，与上游「标准模式」等命名一致；`map/presets/map-analyst/preset.yml` 与 `map/profiles/map-web/presets/map-analyst.patch.yml` 的 `name`/`description` 保持一致。

## 发布、升级与平台

干净 checkout 全链：

```sh
pnpm install
node map/bin/build-web.mjs # 清理并构建上游、map 与 Web 前端
pnpm run build:check       # 聚合测试与脚本类型检查
node map/bin/test.mjs      # 全部 map 测试（或 --build 连带 map 构建）
node map/bin/map-harness.mjs --no-open
```

门禁归属：map 层自有门禁 = 上表命令 + 各包 `tsc -b`（随 build）；上游聚合门禁（lint 严格 override、doc-sync、hygiene/publint、coverage）扫描范围为 `packages/`/`apps/`/`docs/`，不含 `map/`——map 层以 `map/tests` 工程门禁 + per-package tsc 等价覆盖，不在上游聚合中重复报名。上游更新、零冲突检查、断裂面修复见 [../UPSTREAM.md](../UPSTREAM.md)；回滚 = 回退 map 层提交（上游区无 diff，见其检查命令），profile home 内的 `~/.agent-presets/map-analyst` 由 wrapper 「不覆盖已存在文件」语义保持稳定。

平台限制：Node `^22.19 || >=24`（测试用 `--experimental-strip-types`）；`lib/client.js` 仅浏览器消费；composition e2e 在 macOS/Linux 跑（Windows 分支已写 taskkill 路径但未纳入常规验证）；wrapper 在 win32 经 `shell: true` 调 pnpm。外部 Python/数据库 provider 属后续部署阶段，不新增绕过 profile 的应用入口。

composition lane 的两个运行前置（本地与 CI 同）：

- **构建产物必须与源码一致**：map 层 `lib/` 是本地构建产物，跳过 `node map/bin/build.mjs` 就跑 lane 时，应用会以旧代码启动。典型征兆是 spatial-context 快照仍写退役的 `kind:'plugin'` source，v4 会话在首个事件报 `format v4 message requires a producer-owned source kind`——这不是源码回归，重建即消。
- **headless Chromium 需要软件 WebGL 三参数**：ArcGIS 视图以 `failIfMajorPerformanceCaveat` 请求 WebGL2，默认软件渲染不满足该严格请求，视图直接拒绝挂载（界面显示「Unable to display map. WebGL2 support is required」且无像素）；用例内以 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` 显式选择满足严格请求的渲染器（`rendered pixels` 用例）。
- **项目根 `.env` 不得声明 `DEEPSEEK_BASE_URL`**：app-boot 只允许启动环境提供路由类变量，lane 在本机从仓库根启动应用；本地复跑前将该文件暂移开、跑完恢复（仓库不为此改任何文件）。

### 双 registry 依赖对账（npmmirror/npmjs）

本机默认 registry 指向 npmmirror 而 lockfile 的 tarball 钉定在 npmjs host 时，`pnpm install` 会被供应链策略拒绝；该问题跨 3 个包反复发生（决策模型包、统计模式包各一次对账恢复 resolved，性能容量包一次显式 tarball URL 复写复发 accepted_risk，实时流包 checklist 记录首次一行修复）。明细见 `.spec/specs/archive/2026-09-24_add-spatial-decision-models/`、`.spec/specs/archive/2026-09-24_add-spatial-statistics-patterns/`、`.spec/specs/archive/2026-09-24_add-spatial-performance-capacity/` 的 completion-summary issues JSON（id：`pnpm-registry-state-drift`、`issue-lockfile-tarball-url-recurrence`）。

- 触发条件：`pnpm install` 或合并门禁报 `ERR_PNPM_TARBALL_URL_MISMATCH` / tarball host 失配类拒绝；或任何功能提交在本机跑过 `pnpm install` 之后（`@deepseek-ai/libreoffice-kit-win32-arm64@0.0.1` 的显式 npmjs tarball URL 会被镜像解析重新写回 lockfile）。
- 标准恢复（定向对账，不改任何配置文件）：`pnpm install --frozen-lockfile --config.registry=https://registry.npmjs.org/`——`--frozen-lockfile` 禁止重解析，对账只重建 node_modules，lockfile 必须零变更（`git status` 复核）；完成后复跑受影响 lane。
- 禁止：不得以删除或重建 `pnpm-lock.yaml`、绕过 `--frozen-lockfile` 强制重解析等任何「清理 lockfile」手段消除对账失败——integrity 摘要与上游 pin 会被破坏；显式 tarball URL 复发时重复同一行修复（删除该显式 tarball 字段，integrity 保持不变）。

