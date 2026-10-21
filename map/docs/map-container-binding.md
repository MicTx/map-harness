# 地图容器绑定模型与工具面

任务包（已归档，位于 `.spec/specs/archive/`）：绑定模型 `.spec/specs/archive/2026-09-20_bind-workspace-to-map-runtime`（2026-09-20）；对话区 view 消费面 `.spec/specs/archive/2026-09-21_register-map-conversation-view`（2026-09-21）；聚焦与 live 证据 `.spec/specs/archive/2026-09-21_harden-map-view-focus-and-live-evidence`（2026-09-21）；真实会话联动 `.spec/specs/archive/2026-09-21_fix-session-map-binding`（2026-09-21）；World Imagery 底图 `.spec/specs/archive/2026-09-21_add-world-imagery-basemap`（2026-09-21）；渲染回执 `.spec/specs/archive/2026-10-07_add-render-receipts`（2026-10-07）；手势写通道 `.spec/specs/archive/2026-10-07_add-browser-gesture-channel`（2026-10-07）

## 绑定模型

```
会话 (session id)
  ├─ 工作区：session cwd（ctx.workspaceRegistry 项目目录）
  ├─ 权威地图：mapContainer session projection → ctx.map 只读服务
  └─ 浏览器地图：该 session 的唯一右栏 map tab → 一个 ArcGIS MapView/SceneView
       ├─ 对话标题栏「地图」入口：按 sessionId 定位已有页签
       └─ 工作台与手势：作用于该页签的同一个实例
```

- **一个会话、一张地图**。工具经 `exec.agent.session` 读取和修改所属会话的投影；浏览器 `sessionId`、`useProjection('mapContainer')` 和手势提交目标来自同一个严格 Session 作用域。对话标题栏的「地图」按钮只定位该会话的右栏页签，不创建对话区画布，也不切走聊天记录。失效的旧会话回调不会改动当前会话。
- **唯一页签与恢复**：`client/default-open.ts` 使用 Sidebar 的已采用布局和 `openTabs` 通知收敛重复 map 记录，保留第一个地图页签及全部非地图页签。`BoundMapTab` 仅允许规范页签加载 SDK；`createMapOccurrence` 还按 Session 独占注册，直接重复创建也会拒绝，直到旧实例 dispose 释放身份。即使旧布局尚在收敛也不会创建第二实例。已有的重复地图页签在打开会话时自动合并，不删除会话日志、图层或分析产物。
- **生命周期**：空白会话不自动分配地图；非空会话的标题栏就绪后默认打开一次。`keepMounted` 保留隐藏、收起及会话切换中的画布和工作台状态；关闭地图页签会销毁实例，标题栏入口可重新打开并从投影恢复。刷新后重放该会话的地图；相机手势和工作台临时筛选不因此成为持久化地图变更。
- **布局提交时序**：首次打开和重复收敛在微任务中执行，等待 Sidebar inventory 通知后的 TabDomain 提交结束，不在通知回调内重入布局写入，也不使用固定延迟或限次重试。卸载后的 SDK import 完成不会创建实例；部分挂载失败会释放已创建的实例。
- **map-web 保留文件预览**：profile 禁用上游 terminal/browser 右栏类型，保留 workspace 文件树、文档预览和可见 tab strip；用户手动收起或关闭地图后不自动强开。
- **工具读 host 服务走 `ctx.get('map')`**。`map` 由 boot 树 provide，agent-plane 未 inject 该服务；直接读 `ctx.map` 会抛 `cannot get property "map" without inject`。地图工具由内部 ArcGIS MCP server 调用既有 ToolDefinition handler；MCP adapter 从 trusted `ToolExecution` 绑定 session，模型参数不接受 `sessionId`。
- **状态真源是会话日志**：P0a 起成功 mutation 的 `tool/result.meta` 携带版本化 `map-change` 记录（`schemaVersion: 1`、`kind: "map-change"`、`sourceCallSeq`、`targetRevision`、纯候选 `change`，见 `map/map-container/src/protocol.ts`）。`mapContainer` 投影按「解码 → 校验 → 折叠」三步处理：只有成功、配对（pending call 的 callSeq 与 meta 的 `sourceCallSeq`、事件 `sourceEventSeqs` 一致）、首次结算、revision 匹配、容量合规的记录才折叠；失败/取消、未配对、surface replacement 重复、未知 schemaVersion/kind、过期 revision 与超限记录只写入有界只读诊断，不改权威地图。旧扁平 meta（无 `schemaVersion`）走专门的 legacy 解码路径，旧日志仍可重放。持久化状态是普通 JSON（有序数组，无 `Map`/`Set`），`stateVersion: 3` 使 pre-P0a 缓存行失效并从原始日志重放。浏览器唯一地图 tab 通过标准 `useProjection('mapContainer')` 读取——重放、重启、多端一致，无第二条传输通道。
- Node 侧 `ctx.map` 服务是投影派生只读面（`stateOf`/`pendingCallOf`，见
  `map/map-container/src/service.ts`）：mutation handler 读取已接受投影、校验候选变更
  （容量/引用/revision，`validateMapChangeCandidate`）后返回候选 meta，不写任何状态；
  `pendingCallOf` 从已接受 `tool/call` 解析 `sourceCallSeq`。没有已接受 `tool/call` 的直接
  执行（绕过 agent loop）会拒绝而不是变更地图；嵌套（PTC）dispatch 同样拒绝。

## 实时订阅与重连

地图工具结果先进入会话日志，再由 Host 投影通过 Session control stream 推送到浏览器。日志与 `session.projections` 已更新而画布仍旧时，应分别检查 control 订阅是否存活和当前 render receipt，不把工具成功当作已显示。Session Controller 在每个就绪的 Host generation 创建新 consumer；旧 consumer 即使因协议或业务错误终止也不会被复用。旧流先释放，过期代次与已卸载插件不能发布迟到 baseline。该共享客户端修复及其上游同步规则登记于 [UPSTREAM.md](../UPSTREAM.md)。

本机 `127.0.0.1`、`localhost`、IPv6 回环及页面自有 Worker 的连接不受 `navigator.onLine` 提示控制。浏览器报告互联网离线时，本机 HTTP/WebSocket 仍可能可达；Connection 继续握手和实际传输故障后的重试，只有收到就绪项才报告连接成功。远程 Host 的 offline/online 暂停策略保持不变，详见 [Connection generation](../../packages/client/connection/README.zh.md#connection-generation)。

## 渲染回执（occurrence 级）

会话的唯一地图 occurrence 在应用投影后记录一条渲染回执，回答「这个 revision 是否真的画出来了」，而不是把工具成功当成已显示：

- **状态**：`unavailable | applied | rendered | failed`。`unavailable` 带 `not-mounted | no-projection | disposed` 原因；`rendered` 必须满足 `renderedRevision === revision`、`viewId` 非空且无失败图层（schema 级约束）。
- **身份**：`sessionId`、`occurrenceKey`、`generation`（引擎代次，每次重建 view +1）、`viewId`（具体 view 的随机身份）、`attempt`（本 occurrence 的观察序号）、`layerVersions`（各可见图层的数据/样式 token）。
- **渲染完成判定**：仅当目标 occurrence 的当前 view 完成 `view.when` → 每个可见 GraphicsLayer 的 `whenLayerView` → 视图不再 updating/suspended → 两层 `requestAnimationFrame` 后才写 `rendered`；旧 view 的迟到完成被 generation/viewId/attempt 拒绝（销毁、卸载与观察被取代都不得写成新事实）。
- **失败**：固定错误码 `VIEW_FAILED | LAYER_FAILED | AOI_FAILED` + 受影响图层 id；不携带 SDK 异常原文（可能含 URL）。
- **持久化**：经上游 `@deepseek-ai/dsh-client-store`（`createSnapshotStore` 的 `persist` 语义，键为 `map-render-receipt:<session,occurrence>`）；读取值经 Zod 校验，非法值丢弃；无 localStorage 或写入失败只关闭持久化，内存态照常工作。持久值仅证明「这台浏览器上次观察到该 revision 渲染完成」，重新挂载后由当前观察另行更新，不当作 live 证据。
- **边界**：回执不承担空间计算正确性（数值证据归工具与 fixture）；headless/不可渲染环境如实报 `unavailable`，不阻止独立数据分析成功；不新增必需 session 事件，回执不进入会话日志。
- **证据面**：`MapOccurrence.getRenderReceipt()` / `getPersistedRenderReceipt()`（`map/map-container/src/client/render-receipt.ts` 为契约与载体），测试句柄 `MapHarnessTestHandle.renderReceipt` 暴露当前观察，`camera` 直接读取 SDK 当前相机（WGS84 center、缩放及实际引擎 WKID），与投影目标 `center`/`zoom` 分离，不可读时返回 null；composition lane 的 `rendered pixels` 用例在真实 Web 断言 `rendered` 与 2D/3D 视图身份变化（`viewId` 不同）。

## 手势写通道（浏览器 → 会话队列）

用户在地图画布上的相机手势（拖拽/滚轮/键盘）经有界观察作为用户输入进入会话队列（设计 §11.1/§11.2；2026-10-07 交付，任务包 `.spec/specs/archive/2026-10-07_add-browser-gesture-channel`）：

- **观察形成**：`map/map-container/src/client/gesture.ts` 纯状态机——只有活跃用户交互窗口（`GESTURE_INTERACTION_WINDOW_MS`）内发生的相机变更归因给用户；occurrence 自身驱动的相机写入（syncCamera、focus `goTo`）触发程序化静音脉冲（`GESTURE_PROGRAMMATIC_PULSE_MS`），永不形成草稿。相机静止 `GESTURE_SETTLE_MS` 后草稿落定为稳定观察；运行中限频 `GESTURE_STEER_MIN_INTERVAL_MS`（latest-wins 持有）。一个手势序列至多形成一条草稿。
- **观察文本**：首行 `[map-gesture v1]` 版本标记 + 一行紧凑 JSON（短键：session/occurrence/generation/kind/center/zoom/extent/wkid/mode/at）；坐标六位小数（显示约定）；字节上限 `GESTURE_MAX_OBSERVATION_BYTES`，超限在客户端序列化器拒绝、不发不完整载荷。`user/message` 事件无 meta 字段，版本标记入文本自身；外来文本解析为静默 `not-gesture`，未知版本显式 `unknown-version`。
- **提交路径**：与 composer 同一 seam——客户端 `ctx.sessions` retain（独立源标签 `mapGesture`）→ `session.prompt(content, mode)`；运行中稳定观察 `mode: 'steer'`（仅运行中；空闲保持本地草稿，不入队不自启请求），地图页签显式「发送视图观察」操作恒 `mode: 'queue'`（用户发起，可自启轮次）。`session/steer-unavailable`（轮次恰好结束的竞争）按持有处理，不是通道故障；提交失败为咨询性输入，不作为地图错误呈现。
- **边界**：手势观察永不修改权威地图状态（地图写者仍是模型/服务的 map_* 工具）；仅相机摘要、无要素拾取；无新会话事件类型、无新 MCP 工具、无宿主侧手势验证行；随 composer 消息附带需接管上游 composer，为后续项；模型可见 ⟺ 已记录由 prompt 命令天然成立。
- **证据面**：`MapOccurrence.getGestureMetrics()` / `submitGestureObservation()`；测试句柄 `MapHarnessTestHandle.gesture`（发出手势时立即更新，不等待下一次投影）；`map/map-container/tests/gesture.spec.mjs` 协议/状态机/接线，composition lane `gesture write channel` 用例在真实 Web 断言 steer 入队文本到达模型会话、显式 queue 入队与程序化零观察。

## 面板写入通道（浏览器 → 用户变更路由）

地图标签页内的图层管理面板（`map/map-container/src/client/LayerPanel.tsx`）按 Mapbox 图层列表的习惯直接改图。2026-10-21 起推翻「浏览器零写通道」：用户操作即时生效，仍全部落入会话日志，模型下一轮可见：

- **三级操作**：视图本地操作（面板开合、搜索、组开合、`focusLayer`/`focusFeature` 定位、属性表翻页）立即生效且不出浏览器；用户写入（显隐、组显隐、透明度、拖拽排序、上移/下移、归组、预设样式、删除）经 `POST /api/map/change` 即时生效；导出仍以 `[map-panel v1]` 文本经 `session.prompt`（引用源 `mapPanel`、模式 `queue`）排队，由模型执行 `data_export`，因为它要产生目录制品。
- **用户变更词汇**（`src/user-change.ts`）：`set-layer-state`（1..32 条，visible/opacity/group）、`reorder-layers`（必须正好命名当前全部图层）、`remove-layer`、`set-symbol-preset`（预设 id 经 `map-layers` 预设表展开为 `set-symbol-style`）。记录为 `{ operationId, targetRevision, change }`，严格 schema、整条 ≤16 KiB。
- **落盘与折叠**：路由经 `sessionController.resolveAgent` 取 live agent，按浏览器看到的 revision 与模型变更同一套 `validateMapChangeCandidate` 接纳，再以 `agent.inject()` 把一条 `user/message`（source `{ kind: 'map-user-change', form: 'notice', summary }`）写入 next-step 收件箱，不唤醒模型。消息正文是一行可读摘要 + `[map-user-change v1]` 标记 + 记录 JSON。`mapContainer` 投影在 `agent/inbox/spliced` 插入提交时折叠该通知（`settleUserChange`），所以路由返回 `{ ok, revision }` 时 wire 已推送；之后被认领的同一 `user/message` 按 operationId 去重，不重复应用。其他 source 携带同样标记的消息不折叠。
- **拒绝码**：`invalid-change`（400）、`unknown-session`（404）、`stale-revision`（409）、`layer-unknown`、`preset-unknown`、`oversized`（400）；拒绝不写日志。插入提交时若修订已前进，折叠记 `stale-revision` 诊断并保持地图不变，路由同样回 409。
- **操作台账**：用户变更进入同一有界台账，`writerId: 'user'`，带逆变更，`map_undo` 可撤销。
- **模型认知**：`map/presets/map-analyst/agent.cordis.yml` 与 `map/profiles/map-web/presets/map-analyst.patch.yml` 的 persona 说明 `[map-user-change v1]` 通知所述改动已生效，不要用工具重复；`[map-panel v1]` 导出请求逐条执行 `data_export`。
- **绘制顺序**：occurrence 在每次刷新时按状态图层顺序重排数据载体，只在它们已占的槽位内置换，底图与 AOI 轮廓不动。
- **反馈循环防线**：写入只源于 DOM 事件；wire 变化只触发重渲染；模型驱动变更不产生任何写入（composition `panel user writes` 用例断言）。
- **制品下载**：`GET /api/map/artifact?session=<id>&ref=<精确版本>`（`src/artifact-route.ts`，Connection 门控、`spatialCatalog` 服务门控，Connection 或目录服务重挂载时重注册）。参数白名单仅 `session`/`ref`，ref 必须通过 `parseCatalogRef`（`res-…@vN` / `art-…@vN`，拒收松散引用）；读取走 `SpatialCatalogService.forSession(session)` 的 `readResourceBytes`/`readArtifactBytes`（会话隔离、授权与 digest 校验内建），以 `application/octet-stream` + `Content-Disposition` 流出。拒绝码固定为 `unknown-session`（会话缺失/形态不合法）、`unknown-ref`（未知或非精确引用、含参数白名单之外的参数）、`unauthorized`（治理拒绝/吊销）、`digest-mismatch`（字节与记录摘要不符），不含存储细节。面板两个入口：携 `resourceRef`/`artifactRef` 的层一键下载，以及「按引用下载」输入框（闭合 P4「对话导出→浏览器获得文件」链）。Workbench 的 manifest JSON 下载是客户端显示副本清单，与本路由的精确字节语义不同，二者并存。
- **证据面**：`map/map-container/tests/user-change.spec.mjs`（词汇、接纳、通知往返、插入即折叠且认领不重复、路由拒绝与注入）、`map/map-container/tests/panel.spec.mjs`（导出词汇、派生面、locale 键集）、`map/map-container/tests/artifact-route.spec.mjs`、`map/map-container/tests/occurrence.spec.mjs`（定位与绘制顺序）；composition lane `panel user writes` 用例在真实 Web 断言点击即生效、零工具调用、模型读到通知且不重复执行。

## 坐标交换契约

- 工具域 ↔ 浏览器容器之间：**WGS84 GeoJSON（RFC 7946）+ `sourceCrs` 元数据**，唯一交换格式。
- Node 半用 proj4 把投影坐标系数据（如 CGCS2000 3 度带 EPSG:4547）收敛到 WGS84 再进入
  分析（Turf 只吃 WGS84）与折叠；浏览器半用 ArcGIS 投影引擎按 view WKID 再投影显示
  （含 CGCS2000↔WGS84 基准变换）。proj4 无内置 EPSG 字典，CGCS2000 3 度带定义表内置于
  `map/tools/src/geo-source.ts`，其余 CRS 以 `+proj=` 串显式传入。

## 工具面（map-analyst preset 挂载）

| 工具 | 作用 | 持久化 meta |
|---|---|---|
| `map_add_layer` | 读工作区 GeoJSON（可带 `crs`），收敛 WGS84 后提出候选 | 版本化 `map-change`：`add-layer` 候选含完整 WGS84 图层记录与 `sourceCallSeq` |
| `map_remove_layer` | 按 id 移除图层 | 版本化 `map-change`：`remove-layer` 候选 |
| `map_set_view` | WGS84 center + zoom，可选显示投影 WKID | 版本化 `map-change`：`set-view` 候选 |
| `map_fit_view` | 按 bbox/图层范围/AOI 三选一适配视窗；zoom 为文档化 Web-Mercator 推导（1024×768 基准视窗 + padding） | 版本化 `map-change`：`set-view` 候选 |
| `map_draw` | 由显式 WGS84 坐标直接绘制点/线/面图层（多边形自动闭合；同 `layer_id` 重绘替换） | 版本化 `map-change`：`add-layer` 候选 |
| `map_locate` | 在线地名解析（只读）；无 bbox 走地理编码单候选，带 bbox 走限定 POI 检索可多候选/零候选 | — |
| `map_set_mode` | 2D map / 3D local scene | 版本化 `map-change`：`set-mode` 候选 |
| `map_get_state` | 读已接受投影的容器状态（图层清单+视图）；重启/恢复后一致 | — |
| `geo_buffer` / `geo_area` / `geo_intersect` / `geo_distance` | Turf 空间算子，结构化数值输出 | — |

## 引擎与许可要点

- 浏览器引擎 **ArcGIS Maps SDK for JavaScript（`@arcgis/core` 5.1）**：2D 任意数字 WKID 可在运行时切换
  （WKID 变化重建 occurrence view，图层由 SDK 投影引擎按 view WKID 重投影），SceneView global 原生支持 CGCS2000，local 场景支持任意投影坐标系（3D）。工具 schema 与 view 代码均不接受 WKT 输入。
- **零 key 模式**：不传 Esri `basemap`/`ground` 枚举、不请求 geocoder。Web Mercator 引擎（显示记录 `wkid=4326` 或 `3857`）用 ArcGIS Online 公开 `World_Imagery` XYZ 瓦片作底图（无 API token，瓦片 3857）；不强制把 geographic 记录的 view 设成 4326。其他投影 WKID（如 4547）与 3857 瓦片空间参考不兼容，走同一 `World_Imagery` 服务的动态 export（服务端按 outSR 重投影，live 实测 `bboxSR=4547` 约 7s 出图）；`MapView.zoom` 因无 LOD 恒为 -1，相机 zoom 走 Web-Mercator `scale` 换算（`scaleFromZoom`）。WKID 引擎变化或 2D/3D 切换会重建 occurrence 的 ArcGIS view（旧图层句柄一并销毁）。后续 `map_set_view` 只在 center/zoom/wkid 真变化时同步相机，图层增删不拉回视窗。
  Esri MLA 要求展示数据署名；occurrence view 以 `ui: { components: [] }` 构造，移除了 SDK 默认 UI（含 attribution 组件），「Powered by Esri」不渲染在地图容器内。本仓库部署于内网，署名省略为已确认决策（2026-09-22）；图层数据源以 `copyright` 字符串保留在 layer 对象上。
- 包体：`@arcgis/core` 惰性 chunk 约 64MB（按需加载），主入口 client.js gzip ≈300KB。

## 双面插件构建注意（已验证的约束）

- 浏览器 bundle 的 externals 必须是 **loader module-table 裸名**（`react`、`react/jsx-runtime`、
  注入服务包）；deps 钩子收到的是解析后 id，按绝对路径判 external 会输出 require(绝对路径)，
  loader 无法作答。内联第二份 React 会让所有 hooks 崩（dispatcher 为 null）。
- 动态 import 必须单文件（`inlineDynamicImports: true`），否则 `./client.xxx.js` 相对 require
  在浏览器无解。
- Node 半 lib 单文件：profile 只 symlink 本包，运行时 import 不能越界；上游 lib 内含标准装饰器
  （`@Remote`），需 `typertPlugin` 先降级再内联。
- 给 Cordis 写 `declare module '@deepseek-ai/cordis'` 增强的文件必须（哪怕 type-only）import
  cordis，否则增强落到孤立符号上，`ctx.effect` 等 fiber 合并成员会消失。
