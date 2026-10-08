# 地图容器绑定模型与工具面

任务包（已归档，位于 `.spec/specs/archive/`）：绑定模型 `.spec/specs/archive/2026-09-20_bind-workspace-to-map-runtime`（2026-09-20）；对话区 view 消费面 `.spec/specs/archive/2026-09-21_register-map-conversation-view`（2026-09-21）；聚焦与 live 证据 `.spec/specs/archive/2026-09-21_harden-map-view-focus-and-live-evidence`（2026-09-21）；真实会话联动 `.spec/specs/archive/2026-09-21_fix-session-map-binding`（2026-09-21）；World Imagery 底图 `.spec/specs/archive/2026-09-21_add-world-imagery-basemap`（2026-09-21）；渲染回执 `.spec/specs/archive/2026-10-07_add-render-receipts`（2026-10-07）；手势写通道 `.spec/specs/archive/2026-10-07_add-browser-gesture-channel`（2026-10-07）

## 绑定模型

```
会话 (session id)
  ├─ 工作区：session cwd（上游既有语义，ctx.workspaceRegistry 项目目录）
  ├─ 地图容器：ctx.map 注册表中以 session id 为键的一个容器状态
  └─ 状态投影：mapContainer session projection（dsh-session-projection 单元）
       ├─ 浏览器右栏「地图」tab：读取投影，渲染 ArcGIS MapView/SceneView
       └─ 对话区 conversation.view 第三个 tab（id `map`）：同一投影，独立 occurrence
```

- **一个会话绑一个容器**。工具经 `exec.agent.session` 定位容器，天然多会话隔离。
- **map-web 右侧栏聚焦地图但保留预览**：profile patch 禁用上游 terminal/browser 两个右栏 tab 类型
  （`disabled: true`），workspace 文件树与文档预览 tab 保留注册，tab strip 可见可切换；每会话首次成为
  主视图时 `map-container` client 经 `sidebarRight.openTabIn(sessionId, 'map')` 默认展开一次
  （`client/default-open.ts`，用户手动收起后不再强开）。
- **工具读 host 服务走 `ctx.get('map')`**。`map` 由 boot 树 provide，agent-plane 未 inject 该服务；直接读 `ctx.map` 会抛 `cannot get property "map" without inject`。地图工具由内部 ArcGIS MCP server 调用既有 ToolDefinition handler；MCP adapter 从 trusted `ToolExecution` 绑定 session，模型参数不接受 `sessionId`。
- **状态真源是会话日志**：P0a 起成功 mutation 的 `tool/result.meta` 携带版本化 `map-change` 记录（`schemaVersion: 1`、`kind: "map-change"`、`sourceCallSeq`、`targetRevision`、纯候选 `change`，见 `map/map-container/src/protocol.ts`）。`mapContainer` 投影按「解码 → 校验 → 折叠」三步处理：只有成功、配对（pending call 的 callSeq 与 meta 的 `sourceCallSeq`、事件 `sourceEventSeqs` 一致）、首次结算、revision 匹配、容量合规的记录才折叠；失败/取消、未配对、surface replacement 重复、未知 schemaVersion/kind、过期 revision 与超限记录只写入有界只读诊断，不改权威地图。旧扁平 meta（无 `schemaVersion`）走专门的 legacy 解码路径，旧日志仍可重放。持久化状态是普通 JSON（有序数组，无 `Map`/`Set`），`stateVersion: 3` 使 pre-P0a 缓存行失效并从原始日志重放。浏览器 tab 与对话区 view 都通过标准 `useProjection('mapContainer')` 读取——重放、重启、多端一致，无第二条传输通道。
- 对话区 view 注册为 `conversation.view` entry `id: map`（order 20，label 中文「地图」/ 英文 `Map`）。
  与 chat / trajectory 并列；一次只渲染活动 view。occurrenceKey 为 `view:map`，与右栏 tab
  occurrence（`tab.id`）隔离，`__mapHarness` 句柄互不串扰。
- `viewRequest` 聚焦：`openView('map', layerId)` 到达地图 view 后，已知图层先 `focusLayer`
  （保可见 + 按图层 GeoJSON bbox `goTo` 覆盖视窗），occurrence 懒加载未就绪时 defer，
  就绪后再 focus + `completeViewRequest()`；未知图层或投影未落地立即 complete（no-op 聚焦），
  避免 stale request 粘在 store 上。`openView` 只在活动 view body 上可达，本轮不提供
  「工具结果落盘瞬间从 chat 强制跳转」的外部通道。
- Node 侧 `ctx.map` 服务是投影派生只读面（`stateOf`/`pendingCallOf`，见
  `map/map-container/src/service.ts`）：mutation handler 读取已接受投影、校验候选变更
  （容量/引用/revision，`validateMapChangeCandidate`）后返回候选 meta，不写任何状态；
  `pendingCallOf` 从已接受 `tool/call` 解析 `sourceCallSeq`。没有已接受 `tool/call` 的直接
  执行（绕过 agent loop）会拒绝而不是变更地图；嵌套（PTC）dispatch 同样拒绝。

## 渲染回执（occurrence 级）

每个 occurrence（右栏 tab 与对话区 view 各自独立）在应用投影后记录一条渲染回执，回答「这个 revision 是否真的画出来了」，而不是把工具成功当成已显示：

- **状态**：`unavailable | applied | rendered | failed`。`unavailable` 带 `not-mounted | no-projection | disposed` 原因；`rendered` 必须满足 `renderedRevision === revision`、`viewId` 非空且无失败图层（schema 级约束）。
- **身份**：`sessionId`、`occurrenceKey`、`generation`（引擎代次，每次重建 view +1）、`viewId`（具体 view 的随机身份）、`attempt`（本 occurrence 的观察序号）、`layerVersions`（各可见图层的数据/样式 token）。
- **渲染完成判定**：仅当目标 occurrence 的当前 view 完成 `view.when` → 每个可见 GraphicsLayer 的 `whenLayerView` → 视图不再 updating/suspended → 两层 `requestAnimationFrame` 后才写 `rendered`；旧 view 的迟到完成被 generation/viewId/attempt 拒绝（销毁、卸载与观察被取代都不得写成新事实）。
- **失败**：固定错误码 `VIEW_FAILED | LAYER_FAILED | AOI_FAILED` + 受影响图层 id；不携带 SDK 异常原文（可能含 URL）。
- **持久化**：经上游 `@deepseek-ai/dsh-client-store`（`createSnapshotStore` 的 `persist` 语义，键为 `map-render-receipt:<session,occurrence>`）；读取值经 Zod 校验，非法值丢弃；无 localStorage 或写入失败只关闭持久化，内存态照常工作。持久值仅证明「这台浏览器上次观察到该 revision 渲染完成」，重新挂载后由当前观察另行更新，不当作 live 证据。
- **边界**：回执不承担空间计算正确性（数值证据归工具与 fixture）；headless/不可渲染环境如实报 `unavailable`，不阻止独立数据分析成功；不新增必需 session 事件，回执不进入会话日志。
- **证据面**：`MapOccurrence.getRenderReceipt()` / `getPersistedRenderReceipt()`（`map/map-container/src/client/render-receipt.ts` 为契约与载体），测试句柄 `MapHarnessTestHandle.renderReceipt` 暴露当前观察；composition lane 的 `rendered pixels` 用例在真实 Web 断言 `rendered` 与 2D/3D 视图身份变化（`viewId` 不同）。

## 手势写通道（浏览器 → 会话队列）

用户在地图画布上的相机手势（拖拽/滚轮/键盘）经有界观察作为用户输入进入会话队列（设计 §11.1/§11.2；2026-10-07 交付，任务包 `.spec/specs/archive/2026-10-07_add-browser-gesture-channel`）：

- **观察形成**：`map/map-container/src/client/gesture.ts` 纯状态机——只有活跃用户交互窗口（`GESTURE_INTERACTION_WINDOW_MS`）内发生的相机变更归因给用户；occurrence 自身驱动的相机写入（syncCamera、focus `goTo`）触发程序化静音脉冲（`GESTURE_PROGRAMMATIC_PULSE_MS`），永不形成草稿。相机静止 `GESTURE_SETTLE_MS` 后草稿落定为稳定观察；运行中限频 `GESTURE_STEER_MIN_INTERVAL_MS`（latest-wins 持有）。一个手势序列至多形成一条草稿。
- **观察文本**：首行 `[map-gesture v1]` 版本标记 + 一行紧凑 JSON（短键：session/occurrence/generation/kind/center/zoom/extent/wkid/mode/at）；坐标六位小数（显示约定）；字节上限 `GESTURE_MAX_OBSERVATION_BYTES`，超限在客户端序列化器拒绝、不发不完整载荷。`user/message` 事件无 meta 字段，版本标记入文本自身；外来文本解析为静默 `not-gesture`，未知版本显式 `unknown-version`。
- **提交路径**：与 composer 同一 seam——客户端 `ctx.sessions` retain（独立源标签 `mapGesture`）→ `session.prompt(content, mode)`；运行中稳定观察 `mode: 'steer'`（仅运行中；空闲保持本地草稿，不入队不自启请求），地图页签显式「发送视图观察」操作恒 `mode: 'queue'`（用户发起，可自启轮次）。`session/steer-unavailable`（轮次恰好结束的竞争）按持有处理，不是通道故障；提交失败为咨询性输入，不作为地图错误呈现。
- **边界**：手势观察永不修改权威地图状态（地图写者仍是模型/服务的 map_* 工具）；仅相机摘要、无要素拾取；无新会话事件类型、无新 MCP 工具、无宿主侧手势验证行；随 composer 消息附带需接管上游 composer，为后续项；模型可见 ⟺ 已记录由 prompt 命令天然成立。
- **证据面**：`MapOccurrence.getGestureMetrics()` / `submitGestureObservation()`；测试句柄 `MapHarnessTestHandle.gesture`（发布时快照）；`map/map-container/tests/gesture.spec.mjs` 协议/状态机/接线，composition lane `gesture write channel` 用例在真实 Web 断言 steer 入队文本到达模型会话、显式 queue 入队与程序化零观察。

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
