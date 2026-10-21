# @map-harness/map-container

[English](README.md) | 中文

本会话的地图：宿主侧的权威 `mapContainer` 会话投影及其 `ctx.map` 只读面，以及浏览器侧的地图标签页——画布、图层管理面板与工作台。一份由会话日志折叠出的地图状态；模型经 `map_*` 工具写入，用户经图层面板的变更路由写入。

## 宿主半

- `mapContainer` 投影把已接受的 `map_*` 工具结果（`tool/result.meta` 中带版本的 `map-change` 元数据）折叠为持久图层清单、视图、研究区、操作账本与在途调用表。折叠是会话日志的纯同步函数，重放可重建同一张地图。
- `ctx.map`（`MapContainerService`）供工具读取该状态，没有写路径。
- `POST /api/map/change` 是用户写入路径。它按浏览器看到的修订号、并以模型变更同样的候选校验接纳一个有界变更（`set-layer-state`、`reorder-layers`、`remove-layer`、`set-symbol-preset`），然后把一条 `map-user-change` 通知注入 live agent 的 next-step 收件箱，不唤醒模型。折叠在收件箱插入提交时应用该通知，因此响应返回时地图已改变；之后的认领按同一 operation id 重放。拒绝使用固定码：`invalid-change`、`unknown-session`、`stale-revision`、`layer-unknown`、`preset-unknown`、`oversized`。
- 视觉观察服务把一次 `map_observe` 等待与一次客户端截图配对；宿主挂载 Connection 时经 `/api/map/observation` 注册（纯 Node 宿主直接调用服务）。
- `GET /api/map/artifact` 把一个精确版本目录对象的字节流式发给该会话的浏览器：参数集恰为 `session` + `ref`（`res-…@vN` / `art-…@vN`），读取经 `SpatialCatalogService.forSession(session)`（会话隔离、授权与全内容摘要校验），任何失败都以固定码回答——`unknown-session`、`unknown-ref`、`unauthorized`、`digest-mismatch`——且不含存储细节。

## 浏览器半

- `MapTabBody` 为一个标签页挂载 ArcGIS 视图、按投影 wire 驱动它，并承载图层面板与工作台。
- `LayerPanel` 参照 Mapbox 图层列表：地图右上角的「图层」按钮打开浮动面板，先列最上层的图层。每行有拖动把手、类型色块、名称（点击缩放到图层）和显隐眼睛；缩放与「更多」菜单在悬停或聚焦时出现。菜单含透明度、预设样式、归组、上移/下移、属性表（`featureIdOf` 行 id，每页 8 行，≤12 列）、精确版本下载、导出和两步删除。分组可折叠，并带一个控制全部成员的眼睛。分级与热力图层在行下显示图例。
- 显隐、透明度、顺序、归组、预设和删除提交到变更路由并立即生效；模型在下一轮读到通知。导出仍经 `session.prompt`（引用源标签 `mapPanel`）排队一条 `[map-panel v1]` 文本，因为它会产生目录制品。面板永不预演状态：每个控件都渲染 wire。
- 要素绘制采用 Mapbox 默认风格：点带白色光晕；线为圆头圆角并叠在半透明白色衬线上；仅图例色的面为半透明、描边取同色相深色；选中态为青色描边加粗。语义符号（`map-layers`）在显式块之下解析。
- `labeling.ts` 在 2D 视图静止时于屏幕空间放置自动标注：取符号 `label.field`，否则取首个名称类属性（`name`、`名称`、`title` 等）。上层图层先占位；点依次尝试上、右、下、左；标注互不压盖、不压任何点符号、不出视口，拥挤处丢弃。标注以带光晕文字绘于置顶覆盖层，仅在有标注时存在。
- 点击要素在地图左上角打开 `FeatureCard`：命中的最上层数据要素（跳过标注与衬线）获得高亮，卡片以纯文本列出至多 24 个字段（隐藏内部 id，超出计数），标题取标注字段。字符串属性在进入 graphic 前截断至 256 字符。点空白处、关闭按钮或 Escape 关闭卡片。不使用 ArcGIS 弹窗：它在窄侧栏标签页中锚定到视口之外。
- `gesture.ts` 从用户交互窗口形成有界 `[map-gesture v1]` 相机观察；occurrence 自身驱动的相机写入（`syncCamera`、focus 的 `goTo`）静音归因，程序化渲染永不成为用户输入。

## 会话工具卡片

- `src/tool-cards/` 是全部空间工具唯一的展示字典：每个工具一条中文动作短语、一个图标类别，以及卡片列出的参数与结果字段，配带单位的格式化器（米/公里、平方米/平方公里、WGS84 度、计数）。几何数组与大段 JSON 不进卡片；残缺或流式中的参数退化为只显示动作名。
- 浏览器按字典条目各注册一个 keyed `tool.call.toolview` 行（`MapToolCard`）。行只从持久化的调用切片派生标题（`动作 · 对象`）、参数与结果行和失败错误码，因此实时流与回放渲染一致；字典之外的工具保持通用行。
- `@map-harness/map-tools` 用 `withPresentation` 包装每个注册的空间工具，复用同一字典生成 Host 的 `presentCall`/`presentResult` 卡片（ACP 与 CLI 面）。模型可见的 `output.render` 文本不变。
- 新增或改名空间工具必须在同一改动里补字典条目。`map-tools` 把字典重新声明为 `Record<SpatialToolName, …>`，缺条目即 `tsc` 失败；`withPresentation` 在注册时拒绝未收录的工具；`tools/tests/presentation.spec.mjs` 断言字典键与目录完全一致。
- 地图标签页浮层与工具行共用 `map-theme.ts`，样式读宿主 `--dsw-*` 设计 token，随宿主亮/暗主题切换。

## 版本与证据

`SymbolStyle` 与 `FeatureOverrides` 的版本令牌（`sym-…@v1`、`ovr-…@v1`）由全字段摘要推导，记录不经新版本无法被编辑；分类权威仍在 `spatial-viz` 的 `StyleSpec`/`LegendSpec`。

证据：`tests/`（投影、协议、occurrence 渲染身份、手势与面板通道、用户变更、派生面、制品路由）与 `map/arcgis-mcp/tests/composition.e2e.mjs` 的组合 lane。能力矩阵见 `map/docs/verification-matrix.md`，绑定契约见 `map/docs/map-container-binding.md`。

依赖方向：图层呈现沿 `map-container → map-layers → spatial-viz`，资源与制品读取沿 `map-container → spatial-catalog`。上游 `packages/` 从不导入本包；插件与其他插件一样经 loader 进入。

## 已知限制与延后工作

- 用户变更在通知进入收件箱时生效。若在下一轮之前以清空收件箱的方式取消 agent，通知被移除，地图保留该变更但模型永远不会得知。
- 面板只编辑预设；自由符号编辑（颜色、线宽）仍经对话完成。
