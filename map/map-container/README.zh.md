# @map-harness/map-container

[English](README.md) | 中文

本会话的地图：宿主侧的权威 `mapContainer` 会话投影及其 `ctx.map` 只读面，以及浏览器侧的地图标签页——画布、图层管理面板与工作台。一份地图状态、一个写者；浏览器除会话队列之外不修改任何东西。

## 宿主半

- `mapContainer` 投影把已接受的 `map_*` 工具结果（`tool/result.meta` 中带版本的 `map-change` 元数据）折叠为持久图层清单、视图、研究区、操作账本与在途调用表。折叠是会话日志的纯同步函数，重放可重建同一张地图。
- `ctx.map`（`MapContainerService`）供工具读取该状态，没有写路径。
- 视觉观察服务把一次 `map_observe` 等待与一次客户端截图配对；宿主挂载 Connection 时经 `/api/map/observation` 注册（纯 Node 宿主直接调用服务）。
- `GET /api/map/artifact` 把一个精确版本目录对象的字节流式发给该会话的浏览器：参数集恰为 `session` + `ref`（`res-…@vN` / `art-…@vN`），读取经 `SpatialCatalogService.forSession(session)`（会话隔离、授权与全内容摘要校验），任何失败都以固定码回答——`unknown-session`、`unknown-ref`、`unauthorized`、`digest-mismatch`——且不含存储细节。

## 浏览器半

- `MapTabBody` 为一个标签页挂载 ArcGIS 视图、按投影 wire 驱动它，并承载图层面板与工作台。
- `LayerPanel` 管理全部 wire 图层：搜索（任一关键词命中名称、ID、类型族、分组）、分组分区与未分组尾区、批量显隐、透明度、归组、两步移除、预设快用、与渲染同源的图例 chip（`legendOf`/`legendOfSymbol`），以及有界属性表（`featureIdOf` 行 id、每页 8 行、≤12 列）。
- 面板有两级操作。视图本地操作（搜索、开合、经 `focusLayer`/`focusFeature` 的定位、属性翻页）立即生效且不出浏览器。状态变更（显隐、透明度、归组、移除、预设、导出）序列化为有界 `[map-panel v1]` 文本，经 composer 同一条 `session.prompt` 缝并入会话，引用源标签为 `mapPanel`。面板永不写投影、永不预演状态：勾选框跟随 wire，而非点击。
- `gesture.ts` 从用户交互窗口形成有界 `[map-gesture v1]` 相机观察；occurrence 自身驱动的相机写入（`syncCamera`、focus 的 `goTo`）静音归因，程序化渲染永不成为用户输入。

## 会话工具卡片

- `src/tool-cards/` 是全部空间工具唯一的展示字典：每个工具一条中文动作短语、一个图标类别，以及卡片列出的参数与结果字段，配带单位的格式化器（米/公里、平方米/平方公里、WGS84 度、计数）。几何数组与大段 JSON 不进卡片；残缺或流式中的参数退化为只显示动作名。
- 浏览器按字典条目各注册一个 keyed `tool.call.toolview` 行（`MapToolCard`）。行只从持久化的调用切片派生标题（`动作 · 对象`）、参数与结果行和失败错误码，因此实时流与回放渲染一致；字典之外的工具保持通用行。
- `@map-harness/map-tools` 用 `withPresentation` 包装每个注册的空间工具，复用同一字典生成 Host 的 `presentCall`/`presentResult` 卡片（ACP 与 CLI 面）。模型可见的 `output.render` 文本不变。
- 新增或改名空间工具必须在同一改动里补字典条目。`map-tools` 把字典重新声明为 `Record<SpatialToolName, …>`，缺条目即 `tsc` 失败；`withPresentation` 在注册时拒绝未收录的工具；`tools/tests/presentation.spec.mjs` 断言字典键与目录完全一致。
- 地图标签页浮层与工具行共用 `map-theme.ts`，样式读宿主 `--dsw-*` 设计 token，随宿主亮/暗主题切换。

## 版本与证据

`SymbolStyle` 与 `FeatureOverrides` 的版本令牌（`sym-…@v1`、`ovr-…@v1`）由全字段摘要推导，记录不经新版本无法被编辑；分类权威仍在 `spatial-viz` 的 `StyleSpec`/`LegendSpec`。面板背后的 pending 簿只是咨询性表面：本地、有界（32 条）、不持久化，且永不宣称未观察到的成功。

证据：`tests/`（投影、协议、occurrence 渲染身份、手势与面板通道、派生面、制品路由）与 `map/arcgis-mcp/tests/composition.e2e.mjs` 的组合 lane。能力矩阵见 `map/docs/verification-matrix.md`，绑定契约见 `map/docs/map-container-binding.md`。

依赖方向：图层呈现沿 `map-container → map-layers → spatial-viz`，资源与制品读取沿 `map-container → spatial-catalog`。上游 `packages/` 从不导入本包；插件与其他插件一样经 loader 进入。
