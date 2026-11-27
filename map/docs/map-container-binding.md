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
- **状态真源是会话日志**：成功 mutation 的 `tool/result.meta` 携带版本化 `map-change` 记录（当前 v7；v1–v6 及专门的 legacy 记录仍可读）。只有配对调用、首次结算、当前 revision 和容量均通过时才折叠；失败或未知记录保持地图不变。`set-basemap` 自 v6 可读，精确相机 scale/rotation 需要 v7。`map_use` 使用独立 `map-use` v1 接受记录，先在同一投影内核对控制权，再应用相机候选或选择。`mapContainer` 持久状态为 v14，旧缓存从原始日志重建；浏览器通过 `useProjection('mapContainer')` 同时读取地图与 interaction 控制状态。
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
- **渲染完成判定**：当前 view 就绪、可见图层和相机操作结算后，视图及图层须在两帧绘制后仍不处于更新或挂起状态，才能写 `rendered`。自动框选 `goTo` 与 `map_set_view` 在同一具体 view 内排队；待执行的显式相机目标抑制后续自动框选；重建的 view 不等待旧队列，旧回执也不能发布。首次挂载、回放和用户标记层的创建或恢复不自动框选。
- **失败**：固定错误码 `VIEW_FAILED | LAYER_FAILED | AOI_FAILED` + 受影响图层 id；不携带 SDK 异常原文（可能含 URL）。
- **持久化**：经上游 `@deepseek-ai/dsh-client-store`（`createSnapshotStore` 的 `persist` 语义，键为 `map-render-receipt:<session,occurrence>`）；读取值经 Zod 校验，非法值丢弃；无 localStorage 或写入失败只关闭持久化，内存态照常工作。持久值仅证明「这台浏览器上次观察到该 revision 渲染完成」，重新挂载后由当前观察另行更新，不当作 live 证据。
- **边界**：回执不承担空间计算正确性（数值证据归工具与 fixture）；headless/不可渲染环境如实报 `unavailable`，不阻止独立数据分析成功；不新增必需 session 事件，回执不进入会话日志。
- **证据面**：`MapOccurrence.getRenderReceipt()` / `getPersistedRenderReceipt()`（`map/map-container/src/client/render-receipt.ts` 为契约与载体），测试句柄 `MapHarnessTestHandle.renderReceipt` 暴露当前观察，`camera` 直接读取 SDK 当前相机（WGS84 center、缩放及实际引擎 WKID），与投影目标 `center`/`zoom` 分离，不可读时返回 null；composition lane 的 `rendered pixels` 用例在真实 Web 断言 `rendered` 与 2D/3D 视图身份变化（`viewId` 不同）。

## 手势写通道（浏览器 → 会话队列）

用户在地图画布上的相机手势（拖拽/滚轮/键盘）经有界观察形成相机归因（设计 §11.1/§11.2；2026-10-07 交付）。自 2026-10-21 起视窗以隐式上下文进入模型：每次 2D 相机静止都 POST `/api/map/viewport`，spatial-context 快照渲染为 `用户视窗` 行；手势文本不再进入对话队列，地图页签不再提供显式「发送视图观察」操作。

- **观察形成**：`map/map-container/src/client/gesture.ts` 纯状态机——只有活跃用户交互窗口（`GESTURE_INTERACTION_WINDOW_MS`）内发生的相机变更归因给用户；occurrence 自身驱动的相机写入（syncCamera、focus `goTo`）触发程序化静音脉冲（`GESTURE_PROGRAMMATIC_PULSE_MS`），永不形成草稿。相机静止 `GESTURE_SETTLE_MS` 后草稿落定为稳定观察；运行中限频 `GESTURE_STEER_MIN_INTERVAL_MS`（latest-wins 持有）。一个手势序列至多形成一条草稿。
- **观察文本**：首行 `[map-gesture v1]` 版本标记 + 一行紧凑 JSON（短键：session/occurrence/generation/kind/center/zoom/extent/wkid/mode/at）；坐标六位小数（显示约定）；字节上限 `GESTURE_MAX_OBSERVATION_BYTES`，超限在客户端序列化器拒绝、不发不完整载荷。`user/message` 事件无 meta 字段，版本标记入文本自身；外来文本解析为静默 `not-gesture`，未知版本显式 `unknown-version`。
- **上下文路径**：`viewport.ts` 宿主注册表按会话保留最新相机（有界 256 会话，进程内，不持久化）；下一次模型请求的快照基线带 `用户视窗` 行，用户移动后再以增量补发。用户手势后的静止相机若与已接受 `mapContainer.view` 不同，还会以 `[map-user-change v8 view]` `set-view` 记录写入用户变更路由，因此刷新、重开与切换会话恢复最终相机和最终图层状态；相同相机不重复写入。快照本身作为 `user/message` 入日志，模型可见 ⟺ 已记录成立。上报失败只保留上一份相机。
- **边界**：手势观察文本永不进入对话队列；用户手势后与已接受视图不同的静止相机以 `set-view` 用户变更持久化最终地图状态。仅相机摘要、无要素拾取；无新会话事件类型、无新 MCP 工具、无宿主侧手势验证行；随 composer 消息附带需接管上游 composer，为后续项；模型可见 ⟺ 已记录由 prompt 命令天然成立。
- **证据面**：`MapOccurrence.getGestureMetrics()`；`map/map-container/tests/viewport.spec.mjs` 路由与注册表；测试句柄 `MapHarnessTestHandle.gesture`（发出手势时立即更新，不等待下一次投影）；`map/map-container/tests/gesture.spec.mjs` 协议/状态机/接线，composition lane `implicit viewport context` 用例在真实 Web 断言拖拽不产生模型请求、下一请求带 `用户视窗` 行。

## 连续地图操作（`map_use`）

模型连续操作地图时，每次 `map_use` 只接受一个动作（`pan`/`zoom`/`click`/`finish`），并绑定当前 `map_observe` 的 `observation_id`：

- **权威状态与预算**：`mapContainer.interaction` 保留可信 turn 起点、动作/观察计数、时间高水位、停止原因、在途请求和最近接受结果。`interaction` Config 可选配置动作、观察与耗时上限，默认不限；时钟低于已记录高水位时拒绝。只有显式新 turn/start 开启控制，重复或倒退 turn 不清零，迟到的旧 turn 停止通知不影响新 turn。
- **相机动作**：`pan` 的 `dx_px/dy_px` 与指针拖动同向；`zoom` 围绕图像像素锚点保持世界坐标。计算使用冻结的 affine-2d 显示平面和实际 scale，保留 rotation，不把 SDK LOD zoom 当作应用 zoom。结果明确为 `candidate`、`rendered: false`，分别命名旧的`source_revision`与拟提交的`candidate_revision`；同一投影核对调用、turn起点、控制epoch、观察、修订与截止时间后才接受。工具不等待尚未接受的新revision渲染；后续观察省略`expected_revision`，不能把来源版本当新版本。
- **点击**：`click` 只走当前 SDK `hitTest`，返回最多 5 个 topmost 命中（稳定 layer/feature id、白名单标量字段、重叠顺序）或 no-hit + WGS84 坐标；署名区/画面外像素在 SDK 前拒绝，不把底图像素伪装成要素。
- **客户端检查**：`/api/map/use` 的 claim/result/cancel 使用有界令牌配对；服务端截止时间与当前请求状态决定是否接受回包。occurrence 校验 viewId/generation/mapRevision/cameraEpoch/gestureEpoch/layout/camera、渲染健康和绘制 owner。每张 observation 只供一次像素动作；来源策略保留为元数据，不阻止会话操作。
- **接管与恢复**：指针、滚轮、键盘、绘制、停止或关闭 occurrence 同步阻止本地待执行动作，再通过可信 `map-interaction` 用户通知持久化。已停止 turn 的 observe/use 不恢复；普通失败后可重新观察，finish 终结控制且不计动作。已接受的逻辑相机修订保留，不承诺回滚；被接管抑制的待执行相机写记录 `CAMERA_SUPERSEDED`，不能声称已呈现。新 occurrence 初次按已接受状态定位属于恢复，不是重放工具动作。停止条与其余面板按独立区域布局，390px 下保留可达按钮。
- **宿主崩溃**：上游恢复逻辑以 `interruptedTurnClosers` 追加未决调用的错误结果和 `turn/end {interrupted}`；地图计数、已接受相机和选择保留，旧请求清空且不重新计费。未决地图调用结算为错误并清除请求；已有用户停止原因保持不变。
- **证据面**：`map/map-container/tests/interaction-*.spec.mjs`、`map-use-math.spec.mjs`、`map/tools/tests/map-use.spec.mjs`；composition `map use` 用例使用真实 Web/ArcGIS SDK 和受控模型，覆盖独立屏幕控制点、人工接管、浏览器刷新、宿主重启及三个独立预算。受控模型不证明真实视觉模型的决策效果。

## 面板写入通道（浏览器 → 用户变更路由）

地图标签页内的图层管理面板（`map/map-container/src/client/LayerPanel.tsx`）按 Mapbox 图层列表的习惯直接改图。2026-10-21 起推翻「浏览器零写通道」：用户操作即时生效，仍全部落入会话日志，模型下一轮可见：

- **三级操作**：视图本地操作（面板开合、搜索、组开合、`focusLayer`/`focusFeature` 定位、属性表翻页）立即生效且不出浏览器；用户写入（显隐、组显隐、透明度、拖拽排序、上移/下移、归组、预设样式、标记绘制/编辑/删除/撤销、删除）经 `POST /api/map/change` 即时生效；标记导出仍以 `[map-panel v1]` 文本经 `session.prompt`（引用源 `mapPanel`、模式 `queue`）排队，由模型执行 `data_export`，因为它要产生目录制品。
- **用户变更词汇**（`src/user-change.ts`）：`set-layer-state`（1..32 条，visible/opacity/group）、`reorder-layers`（普通图层按非标记层完整序提交）、`remove-layer`、`set-symbol-preset`（预设 id 经 `map-layers` 预设表展开为 `set-symbol-style`）、`set-imagery-display`（三层显隐、近期透明度与固定早期 release）、`set-view`（静止相机的最终 WGS84 视图记录），以及 `annotation-create`/`annotation-update`/`annotation-delete`/`annotation-undo`。`annotation-update` 携带编辑开始时的 `expectedUpdatedAt`，宿主比对目标 feature 的 `dshUpdatedAt`，后到的旧写者得到 `stale-revision` 而不是覆盖新写者。普通记录为 `{ operationId, targetRevision, change }`；标记记录另由宿主补齐稳定 feature id、时间戳、来源字段与逆快照。全部记录严格 schema、整条 ≤16 KiB。
- **落盘与折叠**：路由经 `sessionController.resolveAgent` 取 live agent，按浏览器看到的 revision 与模型变更同一套 `validateMapChangeCandidate` 接纳，再以 `agent.inject()` 把一条 `user/message`（source `{ kind: 'map-user-change', form: 'notice', summary }`）写入 next-step 收件箱，不唤醒模型。消息正文是一行可读摘要 + 当前标记 + 记录 JSON；标注记录用 `[map-user-change v3]`，影像显示记录用 `[map-user-change v7 imagery]`，静止相机视图记录用 `[map-user-change v8 view]`，v1/v2 只读重放，标记词只属对应版本。`mapContainer` 投影在 `agent/inbox/spliced` 插入提交时折叠该通知（`settleUserChange`），所以路由返回 `{ ok, revision }` 时 wire 已推送；之后被认领的同一 `user/message` 按 operationId 去重，不重复应用。其他 source 携带同样标记的消息不折叠。
- **拒绝码**：`invalid-change`（400）、`unknown-session`（404）、`stale-revision`（409）、`layer-unknown`、`preset-unknown`、`oversized`（400）；拒绝不写日志。插入提交时若修订已前进，折叠记 `stale-revision` 诊断并保持地图不变，路由同样回 409。
- **操作台账**：用户变更进入同一有界台账，`writerId: 'user'`，带逆变更；普通层经 `map_undo` 撤销，标记经 `annotation-undo` 用完整逆快照补偿，post-state 摘要不匹配时拒绝而不是覆盖并发写者。wire 另投影最新的 `undoableAnnotation` 摘要，避免 12 条普通历史摘要把仍在 32 条撤销视界内的标记操作挤出 UI。
- **标记层**：正式用户标记存于固定 `user-annotations` 层，role 为 `user-annotation`，始终排在普通层之下；`map_edit_annotation` 通过配对的 agent 调用更新、删除或撤销已有标记并保留原作者。普通图层 mutation 不能直接替换该层。浏览器草图只在 occurrence 临时 graphics layer，取消、卸载、切会话和迟到回调不落盘。
- **模型认知**：`map/presets/map-analyst/agent.cordis.yml` 与 `map/profiles/map-web/presets/map-analyst.patch.yml` 的 persona 说明 `[map-user-change ...]` 通知（不限版本）所述改动已生效，不要用工具重复；`[map-panel v1]` 导出请求逐条执行 `data_export`。
- **绘制顺序**：occurrence 在每次刷新时按状态图层顺序重排数据载体，只在它们已占的槽位内置换，底图与 AOI 轮廓不动。
- **反馈循环防线**：写入只源于 DOM 事件；wire 变化只触发重渲染；模型驱动变更不产生任何写入（composition `panel user writes` 用例断言）。
- **制品下载**：`GET /api/map/artifact?session=<id>&ref=<精确版本>`（`src/artifact-route.ts`，Connection 门控、`spatialCatalog` 服务门控，Connection 或目录服务重挂载时重注册）。参数白名单仅 `session`/`ref`，ref 必须通过 `parseCatalogRef`（`res-…@vN` / `art-…@vN`，拒收松散引用）；读取走 `SpatialCatalogService.forSession(session)` 的 `readResourceBytes`/`readArtifactBytes`（会话隔离、授权与 digest 校验内建），以 `application/octet-stream` + `Content-Disposition` 流出。拒绝码固定为 `unknown-session`（会话缺失/形态不合法）、`unknown-ref`（未知或非精确引用、含参数白名单之外的参数）、`unauthorized`（治理拒绝/吊销）、`digest-mismatch`（字节与记录摘要不符），不含存储细节。面板两个入口：携 `resourceRef`/`artifactRef` 的层一键下载，以及「按引用下载」输入框（闭合 P4「对话导出→浏览器获得文件」链）。Workbench 的 manifest JSON 下载是客户端显示副本清单，与本路由的精确字节语义不同，二者并存。
- **幂等键**：浏览器只为“同 revision + 同完整载荷”的歧义提交复用 operation id；revision 前进或新意图分配新 id，避免响应丢失后把后续不同标记永久卡在 requestDigest 冲突。
- **证据面**：`map/map-container/tests/user-change.spec.mjs` 与 `annotation-state.spec.mjs`（词汇、接纳、幂等、逆快照、feature 级 stale CAS、undo wire 候选、checkpoint tail/full 重放、通知往返、插入即折叠且认领不重复、路由拒绝与注入）、`annotation-drawing.spec.mjs`（四类几何、投影转换、取消/卸载/迟到回调零残留、提交失败可见）、`annotation-ui.spec.mjs`（面板状态机与稳定 id 选择）、`annotation-pending.spec.mjs`（歧义幂等键只在同载荷复用）、`panel.spec.mjs`（导出词汇、派生面、locale 键集）、`artifact-route.spec.mjs`、`occurrence.spec.mjs`（定位与绘制顺序）；composition lane `panel user writes` 与 `user annotations` 用例在真实 Web 断言点击即生效、零工具调用、390px/触屏/暗色标记编辑/撤销/导出/重启逐项恢复、模型读到通知且不重复执行。

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
| `map_edit_annotation` | 更新、删除或撤销已有用户标记，记录 agent 身份 | 版本化 `map-agent-annotation` v1 |
| `map_locate` | 在线地名解析（只读）；无 bbox 走地理编码单候选，带 bbox 走限定 POI 检索可多候选/零候选 | — |
| `map_set_mode` | 2D map / 3D local scene | 版本化 `map-change`：`set-mode` 候选 |
| `map_list_basemaps` | 只读列出部署目录中可用基础来源与兼容注记，明示不可用原因 | — |
| `map_set_basemap` | 从目录 id 选择基础来源与可选注记；先检查兼容性、当前投影/模式与修订，再提出候选 | 版本化 `map-change`：`set-basemap` 候选（meta v8） |
| `map_set_imagery` | 切换参考注记、近期影像、早期影像三层显隐，设置近期影像不透明度 `[0,1]`，并按官方目录选择或清除固定 Wayback release；开启早期影像且未指定近期设置时，自动将可见的 100% 近期影像调至 50% | 版本化 `map-change`：`set-imagery-display` 候选（meta v8） |
| `map_get_state` | 读已接受投影的容器状态（图层清单、视图、`basemap` 与 `imagery_display`）；重启/恢复后一致 | — |
| `map_use` | 连续平移/缩放/点击检查/结束；单动作 + observation 绑定，可选每 turn 预算 | `map-use` v1 接受记录；pan/zoom 降低为 `set-view`，click 保存检查选择，finish 终止本轮控制 |
| `map_observe` | 截取当前 revision 的地图作为图像证据；可选 `focus` 为视觉问题（≤512 字）。当前模型接受图像时直接交付像素；否则经部署配置且该 Session 已授权的视觉子会话读图，只把结构化分析文本交给模型，**不交付像素** | `map-observation` 记录 v1–v3 直读；v4 额外携带 `visualAnalysis`（provider/model/childSessionId），且**当且仅当**为 v4 |
| `map_refine_aoi` | 以候选 bbox（或显式 ≤0.05° 窗口）向足迹来源取建筑，按「含候选质心 → 叠合比」排序全部返回，不合并、不声称边界；原矩形保留并在结果列为 superseded | 版本化 `map-change`：`add-layer` 候选，要素带 source/licence/attribution/selection/refines；来源不可达/无数据/4xx 为 REFINE_SOURCE_UNAVAILABLE / REFINE_NO_FOOTPRINTS / REFINE_SOURCE_INVALID |
| `geo_buffer` / `geo_area` / `geo_intersect` / `geo_distance` | Turf 空间算子，结构化数值输出 | — |

**观察记录与读图模型配对。** 版本 4 的观察记录只能由读图的子会话产生；`map_markup`/`map_mark_changes` 的视觉候选必须与其 `modelProvider`/`modelName` 同一模型，否则以 `visual-proposal-pairing` 拒绝。来源许可是可读事实（含 `automatedMapUse`），不作为截图或地图操作的准入。

**精修候选。** `map_refine_aoi` 产出的是图层而非视觉提案：真实足迹作为一个 `add-layer` 候选进入状态，每个要素带 `selection`（含候选质心、与窗口叠合比、排名）与 `refines`（被替换的候选 id），来源、许可与署名随工具结果报告；原矩形候选不改、不删。若被精修的是视觉提案记录，提案可带可选属性 `supersededBy` 指向精修图层——这是属性不是状态，`VisualProposalStatus` 五态不变。候选仍须经用户确认才成为正式 AOI。

**设施 AOI 候选（P1，待确认）。** 目标设施边界只在「经核验来源观察 → 像素定位 → 用户确认」三步之后进入正式 AOI：`map_observe` v4 的分析与 `map_markup` 的 `target` 候选是待确认候选，**不是**已提交的边界；历史会话中的 150 米缓冲圈不称为设施边界。在用户于实际 GUI 上确认前，本仓库不写入也不声称任何真实站区边界。

## 引擎与许可要点

- 浏览器引擎 **ArcGIS Maps SDK for JavaScript（`@arcgis/core` 5.1）**：2D 任意数字 WKID 可在运行时切换
  （WKID 变化重建 occurrence view，图层由 SDK 投影引擎按 view WKID 重投影），SceneView global 原生支持 CGCS2000，local 场景支持任意投影坐标系（3D）。工具 schema 与 view 代码均不接受 WKT 输入。
- **零 key 默认与显式来源**：不传 Esri `basemap`/`ground` 枚举、不请求 geocoder。未选择来源时，Web Mercator 引擎（显示记录 `wkid=4326` 或 `3857`）用 ArcGIS Online 公开 `World_Imagery` XYZ 瓦片作底图（无 API token，瓦片 3857）；不强制把 geographic 记录的 view 设成 4326。显式选择经 session 绑定的 `/api/map/sources/render` 取公开 carrier recipe，浏览器只向 `/api/map/sources/resource` 发生身份绑定请求；ArcGIS 缓存服务用原生 `TileLayer`，普通 XYZ 用 `WebTileLayer`，WMTS/动态 export 各用原生 carrier。其他投影 WKID（如 4547）只在来源与视图兼容时通过原生缓存或受控动态 export，不静默换厂商或改相机。WKID 引擎变化或 2D/3D 切换会重建 occurrence 的 ArcGIS view（旧图层句柄一并销毁）。后续 `map_set_view` 只在 center/zoom/wkid 真变化时同步相机，图层增删不拉回视窗。
- **Wayback 固定 release**：浏览器[独立拉取官方发布目录](../map-container/README.zh.md#浏览器半)；点选时宿主核验单个 release，渲染仍以 `WMTSLayer` 经受控资源路由按视口请求该版本。恢复缺失版本时保留选择并报错，不改成最新版本。局部早期/近期只按当前关注点的不同瓦片选取；中心和四角元数据采样只描述五个点，日期或覆盖不一致为 `partial`，缺少可判定数据为 `unknown`，均不代表全范围同期。
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
