# ArcGIS MCP 协议与地图联动

本文定义 map harness 内部 MCP provider（`@map-harness/arcgis-mcp`，服务名 `arcgisMcp`）的运行约束。该 provider 承载 map 层全部十六个模型可见空间工具：五个 ArcGIS 支撑的 `map_*` 容器工具、四个 Turf 支撑的 `geo_*` 分析工具、P0b 数据链的 `catalog_register`/`catalog_resolve`/`map_save`、P0c 的 `decision_update`（PlanState 唯一写入口，领域校验归 `@map-harness/spatial-context`），以及 P1 的 `run_submit`/`run_get`/`run_cancel`（可达性 run 作业，领域校验归 `@map-harness/spatial-accessibility`）；`arcgis-mcp` 这个包名与服务名是历史标识，目录本身已由 `@map-harness/map-tools` 的统一身份表（`src/spatial-catalog.ts`）固定。MCP 负责标准协议和执行绑定，`mapContainer` session projection 是唯一权威地图状态（P0a 起 handler 不再写注册表），ArcGIS Maps SDK for JavaScript occurrence 只负责渲染；任何一层都不得建立第二份地图真源。

## 调用链

```text
model tool call
  -> ToolRuntime (public name = raw MCP name)
  -> MCP adapter (trusted ToolExecution + AbortSignal)
  -> MCP Client -- initialize / tools/list / tools/call --> in-process MCP Server
  -> exported map/geo ToolDefinition handler
     (map_*：reads the accepted projection via ctx.map; validates the candidate;
      returns model content + versioned map-change meta.
      geo_*：reads workspace GeoJSON; returns model content
      + versioned analysis-result meta)
  -> tool/result.meta (accepted successful result)
  -> mapContainer session projection folds the map-change (authoritative);
     analysis-result meta 由 mapContainer 按名字空间忽略（只读），供后续证据投影消费
  -> right-sidebar ArcGIS occurrence + conversation Map occurrence
```

内部 client/server 通过 MCP SDK 的 linked in-memory transport 交换 JSON-RPC 消息；所有交互必须真实经过 `initialize`、`tools/list` 和 `tools/call` 协议方法。直接调用 handler、正则意图路由或把 schema 写入 prompt 后解析 JSON 文本均不算 MCP。

## 会话绑定

MCP input schema 不含 `sessionId`。adapter 从 ToolRuntime 传入的 `ToolExecution.agent.session` 取得当前会话，并为每次请求生成不可由模型控制的 execution token；token 只放入 MCP request `_meta`，server handler 用它取回原始 `ToolExecution`。缺失、未知或已释放的 token 必须失败，模型参数不得选择其他会话。

adapter 把 `ToolExecution.signal` 传给 MCP client request。MCP handler 同时观察协议 request 的 cancellation signal；取消、插件 dispose 和连接关闭都必须释放 execution token，且不能生成成功的 presentation metadata。插件 dispose 在返回前关闭 transport 并等待在途调用静止。

## 工具目录

MCP server 暴露固定四十七个名称（五个 `map_*` + 四个 `geo_*` + 三个数据链工具 + `decision_update` + run 作业三个 + 统计/模式六个 + 决策模型八个 + viz 四个 + 协同两个 + 地形三个 + 流工作台五个 + 规模通道三个，完整名单以 `SPATIAL_MCP_TOOL_NAMES` 为准），保持 map-analyst 的模型词汇稳定；public ToolRuntime 名与 raw MCP 名一致（内部 provider 是这些名字的唯一权威，无需 server 限定前缀）。统一身份表 `SPATIAL_TOOL_CATALOG`（`map/tools/src/spatial-catalog.ts`）逐工具记录 name、family（`map-mutation`/`map-read`/`geo-analysis`/`catalog-write`/`catalog-read`/`map-save`/`decision-write`/`run-submit`/`run-read`/`run-cancel`/`stat-analysis`/`decision-model`/`viz-style`/`collab-write`/`terrain-display`/`terrain-analysis`/`stream-workbench`/`stream-materialize`/`scale-ingest`/`scale-read`/`scale-scan`）、owner、provider、durable meta kind 与 schema 版本；provider 的 tools/list 冻结、agent 侧 adapter 与最终模型 assemble 都对照同一张表，未知/重复/缺失名在定义期抛错。server dispatch 到 `map/tools` 已导出的 ToolDefinition handler，不复制文件读取、坐标校验、reducer 或结果语义；tools/list schema 与 direct definitions 由 parity 测试锁定（全部四十七个工具全覆盖）。

| 工具 | MCP 结果 | 持久化作用 |
|---|---|---|
| `map_get_state` | 图层摘要、view、mode | 无，只读已接受投影（重启/恢复后一致） |
| `map_add_layer` | 图层摘要、bbox、图层总数 | 版本化 `map-change`（`add-layer` 候选，含 WGS84 图层记录与 `sourceCallSeq`）进入 `tool/result.meta` |
| `map_remove_layer` | 是否移除、图层总数 | 版本化 `map-change`（`remove-layer` 候选） |
| `map_set_view` | center、zoom、wkid | 版本化 `map-change`（`set-view` 候选） |
| `map_set_mode` | `map` 或 `scene` | 版本化 `map-change`（`set-mode` 候选） |
| `geo_buffer` | 距离、面积、bbox、消费要素索引、status、limitations | 版本化 `analysis-result`（`schemaVersion: 1`）：工具、实际 selector（path/crs/featureIndex）、方法参数、带单位 metrics 与 limitations；序列化上限 64 KiB |
| `geo_area` | 面积、bbox、feature_index、status、limitations | 同上（`turf-area`） |
| `geo_intersect` | 是否相交、重叠面积、bbox、双侧要素索引、status、limitations | 同上（`turf-intersect`，双输入 selector） |
| `geo_distance` | km/m 距离、双侧要素索引、status、limitations | 同上（`turf-distance`，双输入 selector） |

`map-analyst` 只注册 MCP-backed 的十六个同名空间工具；direct definitions 保留为测试和兼容入口，但不能在同一 agent scope 重复注册。`@map-harness/map-tools/mcp` 入口在注册这些工具之外还登记一条单调 ToolRuntime guard：`exec.parent` 存在的嵌套 dispatch 调用 `map-mutation`/`catalog-write`/`map-save`/`run-submit`/`run-cancel` 家族工具时在 pipeline 层拒绝（handler 内的同一拒绝保持不变，geo 只读分析不受影响——嵌套 geo 调用不产生 presentationMeta）。该入口在 host provider 缺失时直接报错。旧用户目录可能仍保存 root `@map-harness/map-tools` 行，因此 root 入口在发现 host `arcgisMcp` 服务时把十六个工具全部解析为同一 MCP definitions；未挂 provider 的其他 composition 继续使用 direct definitions（geo direct 定义与 MCP 路径产出同一 canonical value）。

## 结果与重放

MCP result 的 `content` 是模型可见文本，`structuredContent` 保留结构化结果，两者由同一个 canonical value 生成（`executeMapTool` 单一 `value`）。MCP adapter 从结构化结果中的 `meta` 生成 ToolRuntime `presentationMeta`，而 render 输出必须剥离该字段；因此模型不会看到完整 GeoJSON metadata，session log 仍可由 `tool/result.meta` 重建地图。Native 一致性由测试锁定：content 文本与 spatial meta 的关键字段（图层 id、要素数、view 值；geo 侧为 metrics 数值、status、limitations 与 selector）必须同现、同源。

`geo_*` 的 canonical value 在旧数值字段之外新增 `status`（`succeeded`）、`limitations`（有界关键限制表，逐工具固定）与实际消费身份（`feature_index`/`feature_index_a|b`：首几何要素或显式 `feature_index` 的真实下标）；`meta` 为版本化 `analysis-result` 记录（selector、method、带单位 metrics、limitations，序列化上限 64 KiB，由 `buildGeoAnalysisMeta` 强制）。失败结果是 error result，不携带任何应用 meta（ToolRuntime 只在成功且非嵌套的执行上调用 presentationMeta）。解码端 `decodeGeoAnalysisMeta` 拒绝未知 schemaVersion/kind；`mapContainer` 投影对 analysis-result meta 按名字空间忽略（不入 pending、不折叠、不产生诊断），未知版本的 analysis meta 同样只读。

状态改变的提交点是 Session 接受了携带 `map-change` meta 的成功 `tool/result` 并由投影折叠；handler 返回本身只是待接受候选，`ctx.map` 无写路径。工具不得把这个结果表述为浏览器像素已经渲染；已挂载 occurrence 通过 projection 订阅在同一页面内更新，未挂载 occurrence 在稍后打开时读取相同 projection。

`mapContainer` 按 pending `tool/call`（callId + callSeq）配对每个 map mutation 的 call/result，允许同一步存在多个在途地图调用。折叠准入：成功、配对（meta 的 `sourceCallSeq` 等于 pending callSeq，事件 `sourceEventSeqs` 引用一致）、首次结算（surface replacement 不会再应用）、`targetRevision` 匹配当前 revision、容量合规；error、取消、未配对、未知 schemaVersion/kind、过期 revision 与超限只产生有界只读诊断。task-required 工具在 map 层定义生成期即拒绝；嵌套（`exec.parent` 存在的 PTC 子 dispatch）在 handler 拒绝；`ptc`/`both` 呈现由 map-web profile 钉死 `mode: native` 拒绝。右栏和 conversation Map 使用同一 projection，但拥有不同 occurrence key 和 ArcGIS 实例。

## 对标取舍

| 来源 | 采用 | 拒绝 |
|---|---|---|
| `AI-Map`（Vue + Cesium） | 解析动作后经能力层执行并返回结构化结果 | 名为 `MCPServer` 的 regex 意图路由不是 MCP；不复制 Cesium 对象或多条重叠执行路径 |
| `AIxMap`（React + MapLibre） | tool registry、引擎无关 capability facade、工具结果回灌、状态改变后刷新、start/success/error 生命周期 | prompt-JSON 伪 function calling、provider 请求漏 `tools`、浏览器内存真源、post-process 失败仍报成功、UI-only abort |
| map harness | session event、projection、ToolRuntime lifecycle、ArcGIS occurrence | 不新增浏览器 command queue、第二个 layer store 或模型可控 session identity |

AIxMap 的 `changesMapState` 静态工具名集合不作为判断依据。map harness 只在 Session 接受成功结果并折叠版本化 metadata 后认定状态改变；未知工具、schema error、文件/坐标校验失败、缺 map service、缺已接受 `tool/call` 配对和取消都返回 error 且不改权威地图。

## 错误码与结果语义

map 层每个失败结果（MCP `isError` 或 direct 抛错）的文本以稳定错误码开头：`CRS_UNKNOWN`（未收录/不可解析 CRS）、`WORKSPACE_ESCAPE`（路径越界、符号链接、非常规文件）、`RESOURCE_TOO_LARGE`（字节/要素/坐标/深度/meta 上限）、`INVALID_GEOJSON`（UTF-8/JSON/集合/几何/坐标校验）、`GEOMETRY_UNSUPPORTED`（无几何要素、算子不适用的几何）、`INVALID_ARGUMENT`（数值边界、feature_index 范围）、`CALL_CANCELED`（取消）、`SPATIAL_SERVICE_UNAVAILABLE`（fs/会话上下文缺失、读取失败）。码是契约，后接诊断文本。`OUTCOME_UNKNOWN` 在本 provider 不出现：内部目录只执行同步本地 handler，取消/卸载在本地 handler 结算前不向调度器完成（dispose barrier），不存在"可能已提交"的悬挂副作用；该码预留给外部 provider 阶段。取消与失败共享同一条准入规则：错误结果无 meta、不折叠、地图不变。

## 输入与非目标

MCP 是新的不可信 JSON 边界，但不绕过现有 map tool 校验。工作区路径、GeoJSON 文件大小、要素和坐标规模、有限数、WGS84 范围、zoom、mode 和 layer id 继续由已有 handler 与 service 收敛；显示 WKID 不做值域校验，作为 number 原样进入容器状态。

本实现不开放 HTTP/SSE/stdio endpoint，不接受任意 ArcGIS class/method/eval，不接 ArcGIS Online 地理编码、路由、Portal 或需 token 的服务，不新增空间分析工具，不自动切换 conversation view，也不修改 agent loop 或 released session format。
