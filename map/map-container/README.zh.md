# @map-harness/map-container

[English](README.md) | 中文

本会话的地图：宿主侧的权威 `mapContainer` 会话投影及其 `ctx.map` 只读面，以及浏览器侧的地图标签页——画布与图层管理面板。一份由会话日志折叠出的地图状态；模型经 `map_*` 工具写入，用户经图层面板的变更路由绘制、编辑、删除、撤销并导出标记。

## 宿主半

连续 `map_use` 的控制状态位于 `mapContainer.interaction`。每轮 `interaction.maxActions`、`maxObservations` 和 `maxElapsedMs` 均可选，默认不限。可恢复失败保留本轮控制；用户接管或接受 `finish` 会停止本轮。`/api/map/use` 将有界 claim/result/cancel 与会话配对；重放恢复状态而不重做 SDK 动作。详见[连续地图操作](../docs/map-container-binding.md#连续地图操作map_use)。

启用 Wayback 时，宿主从 `$DSH_HOME/cache/map/wayback-catalog.sqlite` 加载最近一次校验通过的版本目录，然后在启动和每个 `wayback.cacheTtlMs` 间隔后刷新。仅完整通过校验的批次可替换旧目录。刷新失败会记日志，不阻塞地图启动，也不丢弃可用目录。`GET /api/map/wayback?operation=catalog` 和早期影像选择仅使用本地快照。首次同步期间若无目录，接口返回 `503` 和 `Retry-After`；失败后提示不可用，读取不会触发上游同步。Session 保留选定的固定版本。地图渲染按需获取 WMTS capabilities，再按视口加载瓦片，不预下载，也不回退到最新版本。

点位查询仍通过有界官方服务。局部候选按解码后的 256×256 影像像素去重，保留最早影像及其余各不同影像的最新发布版；这只判断解码像素完全相同，不等同于感知相似。畸形 tilemap 返回失败，不误报无变化。拍摄日期来自点位元数据，不来自发布日期；中心和四角采样只描述这些点，缺失、未知和查询失败分别呈现。`Config.wayback` 还控制局部缓存条目数、请求并发和超时。

`visualProposals` 投影字段保存模型标绘与目标候选，并绑定已保存观察、可信 call/model 身份、像素几何及 WGS84 结果。用户确认、编辑后确认与拒绝通过用户变更 CAS 结算。Agent 应用或排除通过配对的 `map-agent-annotation` 结果、独立候选状态、Agent 归属要素和可撤销的修订检查历史结算。每次 fold 重建候选与标记状态；重放不调用模型或重新截图。浏览器半的附件引用使用纯类型导入，避免 Vite 客户端加载附件包的 Node 运行时。

`observationHistory` 有界保存观察记录；`comparisons` 保存两图 id、字节摘要、固定 release、共同视角与限制的版本化记录；`visualChanges` 保存绑定单个 comparison 与同一 affine 的双图变化候选。比较创建与候选决定都从已接受工具结果折叠，不重新截图或请求模型；重放从会话日志恢复两图证据和决定。


- `mapContainer` 投影把已接受的 `map_*` 工具结果（`tool/result.meta` 中带版本的 `map-change` 元数据）折叠为持久图层清单、视图、研究区、操作账本与在途调用表。折叠是会话日志的纯同步函数，重放可重建同一张地图。
- `ctx.map`（`MapContainerService`）供工具读取该状态，没有写路径。
- `POST /api/map/change` 是用户写入路径。它按浏览器看到的修订号、并以模型变更同样的候选校验接纳一个有界变更（`set-layer-state`、`reorder-layers`、`remove-layer`、`set-symbol-preset`、`set-basemap`、`set-imagery-display`、`set-view`，以及仅限用户标记的 `annotation-create`、`annotation-update`、`annotation-delete`、`annotation-undo`），然后把一条 `map-user-change` 通知注入 live agent 的 next-step 收件箱，不唤醒模型。折叠在收件箱插入提交时应用该通知，因此响应返回时地图已改变；之后的认领按同一 operation id 重放。标记记录使用 `[map-user-change v3]` 标记；影像显示记录使用 `[map-user-change v7 imagery]` 标记；静止相机视图记录使用 `[map-user-change v8 view]` 标记；v1/v2 通知仍可读取，但不能携带标记字段。宿主派生标记 feature id、时间戳、白名单属性、逆快照与摘要；已应用 operation id 重试返回已接受修订号且不再注入通知；更新携带目标 feature 的已接受更新时间作为 feature 级 CAS，歧义的网络重试只在同 revision 且同完整载荷时复用 operation id。拒绝使用固定码：`invalid-change`、`unknown-session`、`stale-revision`、`layer-unknown`、`preset-unknown`、`oversized`、`annotation-limit`、`geometry-invalid`、`annotation-unknown`、`annotation-protected`。
- `set-wayback-comparison` 通知记录两个不同的官方局部 release 和关注点，不切换当前底图。宿主在准备两份来源前后检查实况视窗与局部证据。该操作使用 `[map-user-change v4]` 标记；投影重放保存的描述，不重新请求外部服务。当前 schema 中省略可选字段的记录会在身份检查前补齐，来源事实发生变化仍返回 `SOURCE_CHANGED`；固定 Wayback release 保留各自的 release 身份，不回退到目录占位记录。
- 视觉观察服务把一次 `map_observe` 等待与一次客户端截图配对：已接受的 `tool/call` 播种 `observationRequest`，客户端仅在精确修订渲染后认领不透明令牌、截图并携带令牌和回执提交；宿主以共享严格回执 schema、当前请求/修订/来源身份、规范 base64 与一次有界 PNG 解码校验。`POST /api/map/observation` 是承载 `claim`、`capture`、`decline` 与令牌认证 `cancel` 的单一路由；纯 Node 宿主调用同一服务。早期认领仅保留至自身截止时间。无效或错误令牌提交不会消费在途等待；有效截图、decline、取消、超时或 dispose 才释放它。附件保存后，工具经 `readImage` 读回并核对字节、sha256、PNG 类型、长度和尺寸与已准入截图完全一致；归一化或存储漂移会拒绝记录。接纳记录经 `map-observation` meta v1 折叠到 `latestObservation`。
- `Config.observation` 在 provider 加载时解析来源策略元数据和资源限制。`capturePolicy` 与来源许可不阻止截图；不可用来源和无效截图身份仍会拒绝。隐藏或零透明图层不进入证据。`MAX_OBSERVATION_BYTES` 表示默认字节上限；`maxBytes` 可以覆写。默认限制为 8,388,608 字节、16,777,216 像素、单边 8,192 像素，以及 64 个待处理等待/早期认领；待处理数最多可配置为 1,024。可选 `vision`（`provider`/`model`）声明文本模型可委托的视觉路由：仅当 Session 的子代理模型策略授权该路由且该模型经校验接受图像时，`map_observe` 经视觉子会话读图，观察记录升为版本 4。来源许可是可读事实：`osm-standard` 的 `automatedMapUse` 默认 `unverified`，部署可显式声明 `allowed`，不再有 OSM 专属的硬禁止。
- `Config.sources` 在宿主激活时校验部署预设、命名凭据绑定、自定义来源描述、目录限制和来源写入锁。公开目录记录不包含端点或凭据引用；目录校验不会请求来源服务。部署可设置 `sources.proxy.outboundProxy = { urlEnv, targetResolution }` 让来源请求走一个显式代理：`urlEnv` 指定保存代理 URL 的环境变量名（必须使用 `DSH_` 命名空间，模型子进程环境会将其清除），`targetResolution` 选择 CONNECT 目标是已核验的字面地址（`local`）还是原始 hostname（`proxy`）；`proxy` 模式把 hostname 解析交给该代理，部署必须由代理执行同等的 private/metadata/multicast 出站拒绝，做不到时改用 `local`。未配置时保持直连，环境中的代理变量不生效；代理凭据只在宿主内存中使用，不进入配置序列化、错误、日志、Session 或公开描述。
- Session 绑定来源路由只暴露部署拥有的事实：`/api/map/sources/catalog` 返回有界公开页，`/api/map/sources/render` 返回已接受投影状态的精确 carrier recipe，`/api/map/sources/resource` 在严格身份、epoch、provider、尺寸、媒体类型、DNS 与重定向检查后只接纳封闭 metadata/tile/export 操作。受控响应使用有界读取和显式缓存策略；失败携带稳定来源错误码，不含私有上游细节。服务重载在等待卸载完成前注销全部三条路径，使新服务可以立即重新注册。
- `GET /api/map/artifact` 把一个精确版本目录对象的字节流式发给该会话的浏览器：参数集恰为 `session` + `ref`（`res-…@vN` / `art-…@vN`），读取经 `SpatialCatalogService.forSession(session)`（会话隔离、授权与全内容摘要校验），任何失败都以固定码回答——`unknown-session`、`unknown-ref`、`unauthorized`、`digest-mismatch`——且不含存储细节。

## 浏览器半

地图停止按钮在 390px 下仍可达，并跟随浅色与深色主题。指针、滚轮、绘制和键盘接管立即失效本地待执行动作，宿主通知使停止状态跨刷新保留。相机目标已接受不代表画面已呈现：被抑制的待执行相机写报告 `CAMERA_SUPERSEDED`，已接受逻辑修订仍保留在历史中。像素平移/缩放保留捕获时的 SDK scale 和 rotation；SDK LOD zoom 不等于应用按比例尺定义的 zoom。

- `MapTabBody` 为一个标签页挂载 ArcGIS 视图，并提供「底图管理 / 图层管理 / 用户标记」浮动面板，默认选中「图层管理」。每个标签页以语义表格管理内容，切换或收起时保留搜索、滚动和操作状态。可拖动标题栏、调整四边或四角；位置和尺寸只保留于当前地图，地图可用区域变化时自动约束。窄地图默认收起并预留导航列；面板和底部控件避让实测 SDK 署名条，悬停 `FeatureCard` 避开面板。
- 来源读取失败保留业务图层，提供本地化重试入口，并用有界指数退避代替高频重试；ArcGIS 初始化完成后重新应用记录相机。任何宽度的地图标签页都使用同一张统一面板卡片（窄标签页保持单卡片浮层），粗指针获得 44px 控件与 16px 输入文字；Esri 公共瓦片载体固定使用预设单域（不扩散到 services 子域），持续瓦片失败同样走来源失败重试条。
- `LayerPanel` 参照 Mapbox 图层列表：「图层管理」标签页先列最上层的图层。待确认候选位于列表顶部的可滚动「待确认」区域，提供预览、确认、取消和更多操作；确认后写入地图，预览定位到对应候选要素。普通图层保持扁平列表，无分组标题；每行依次为拖动把手、类型/样式预览、名称与显示状态、显隐开关、缩放与「更多」。名称默认是普通文本，色带显示在名称下方；「更多」打开操作对话框，含透明度、预设样式、单符号颜色编辑、上移/下移、属性表（`featureIdOf` 行 id，每页 8 行，≤12 列）、精确版本下载、导出和两步删除。用户标记与底图管理标签页共享这套设计语言：同样的工具条、条件搜索（超过 4 条出现）、滚动列表、行解剖（类型色板、名称与状态、显隐眼睛、悬停动作）与同一类操作对话框；标记编辑与影像来源选择都在对话框内完成。
- `MapboxControls` 在地图实例上挂载官方 Mapbox GL JS v3 控件组：右上一个 `mapboxgl-ctrl-group` 承载放大、缩小与复位正北的罗盘，第二个承载全屏；左下是 100px 比例尺，右下是紧凑归属控件。`map-theme.ts` 的 `MAPBOX_CTRL_GEOMETRY` 与 `MAPBOX_CTRL_ICONS` 逐值照抄厂商样式表（32px 按钮、4px 圆角、`0 0 0 2px rgba(0,0,0,.1)` 外圈、`#ddd` 分隔线、`#eee` 悬停、`#0096ff` 焦点环、原样 SVG data URI）；`installMapTheme` 把 `MAPBOX_CTRL_CSS` 追加在宿主主题之后，使厂商值在层叠中胜出。相机写入经 `MapOccurrence.zoomBy`、`resetBearing` 与 `mapControlState`，只读实况视图、不预演会话状态。图层行使用 DSH 共享控件和宿主主题色。
- 标记分组用 `SketchViewModel` 创建点、折线、多边形和矩形；完成后的几何先投影为 WGS84 并校验，才推进一次已接受修订。草稿只存在 occurrence 的临时 graphics layer，正式标记存在受保护的 `user-annotations` 层并使用宿主派生 id。标记行与图层行同构：几何类型色板、名称与类型、悬停的定位与「更多」动作；点击行打开操作对话框完成名称/说明编辑、样式预设、几何编辑与两步删除，补偿撤销与 GeoJSON 导出留在工具条的「更多」菜单。编辑只作用于已接受状态；投影/提交失败以内联 alert 报告，绝不把拒绝结果伪装为成功。
- 批量操作位于标题下方：全部显示/全部隐藏只提交与目标状态不同的图层（无差异的点击不消耗修订号），并显示作用图层数量；清空图层移入批量操作的「更多」菜单，显示影响数量，行内二次确认后逐层提交删除，遇到第一次拒绝即停止并报告已删数量。图层和标记色块使用地图的有效颜色，包含符号、图层透明度和逐要素覆盖；多色分段显示，图层弹窗列出完整图例。影像行标识类型，截断名称可在操作弹窗查看完整内容。
- 「底图管理」标签页以三行表格负责来源选择：参考注记、近期影像、早期影像各占一行，行内眼睛直接提交 `set-imagery-display` 显隐变更（早期无来源时禁用），名称下方显示当前来源与不透明度摘要。「更多」打开与图层一致的操作对话框：参考注记行给出兼容注记来源下拉框，近期影像行给出基础来源下拉框与不透明度滑杆，早期影像行列出本地 Wayback 版本并提交一条固定 `set-imagery-display` 选择。打开或重试只读取本地目录，不查询点位证据或触发官方刷新。三个对话框遵循目录加载/错误/写入锁状态，提交 `set-basemap` 或 `set-imagery-display` 变更，并在基础来源不兼容时自动清空注记，绝不静默回退。选择或重新开启早期影像时，若近期影像可见且不透明度为 100%，则将其设为 50%；已隐藏或已调整的近期影像保持原样。两项变更写入同一条可撤销记录。
- 显隐、透明度、顺序、预设与单符号颜色变更和删除提交到变更路由并立即生效；模型在下一轮读到通知。导出仍经 `session.prompt`（引用源标签 `mapPanel`）排队一条 `[map-panel v1]` 文本，因为它会产生目录制品。面板永不预演状态：每个控件都渲染 wire。
- 要素绘制采用 Mapbox 默认风格：点带白色光晕；线为圆头圆角并叠在半透明白色衬线上；仅图例色的面为半透明、描边取同色相深色；选中态为青色描边加粗。语义符号（`map-layers`）在显式块之下解析。分类颜色不继承图层名称推断出的透明度，但显式声明的符号和要素级覆盖仍保留各自的透明度。
- `labeling.ts` 在 2D 视图静止时于屏幕空间放置自动标注：取符号 `label.field`，否则取首个名称类属性（`name`、`名称`、`title` 等）。上层图层先占位；点依次尝试上、右、下、左；标注互不压盖、不压任何点符号、不出视口，拥挤处丢弃。每个被丢弃的候选计入一个屏幕网格 `+N` 簇角标，已放置名称加角标计数始终覆盖全部候选；放大后放置更多名称，点击角标把相机框到该簇 bbox。标注与角标绘于仅在有标注时存在的置顶覆盖层；角标是覆盖层唯一可命中的内容，并随标注在相机操作时隐藏。
- 标注使用 10.5px 微软雅黑和白色光晕；DOM 覆盖层与 PNG 合成都消费同一光晕样式。有符号色时将其 RGB 各通道缩放至 55% 作为文字颜色，没有符号的图层使用中性深灰色。
- 悬停要素在命中要素的投影几何四周打开 `FeatureCard`：命中的最上层数据要素（跳过标注与衬线）获得高亮，卡片以纯文本列出至多 24 个字段（隐藏内部 id，超出计数），标题取标注字段。字符串属性在进入 graphic 前截断至 256 字符。定位依次尝试要素右、左、下、上侧及居中/贴边候选，保持地图边距，并避开常驻面板、标题条、工作区、状态/错误提示、署名和 SDK UI 等可见地图悬浮 DOM；空间不足时收缩尺寸并滚动，极端无解时仍在地图内取最小重叠。相机静止和尺寸变化会重锚已打开卡片，关闭后保持关闭直到下次悬停。同一时刻只跑一次命中测试（取最新指针位置）；移出所有要素或离开视图也会关闭卡片。不使用 ArcGIS 弹窗：它在窄侧栏标签页中锚定到视口之外。
- 挂载后新增且不在可见范围内的图层会自动定位，但用户标记层、同一修订改变相机或显式相机写入尚未结算时除外。标记编辑和撤销不移动相机；点击标记的「定位」才主动框选。挂载和回放不自动定位。相机写入按具体视图排队，渲染回执等待该视图的排队写入结算。
- `MapOccurrence.captureView()` 与观察认领共用类型化 `captureViewOf(MapView | SceneView)` 适配器和同一截图事务（`observation-capture.ts`）。截图尺寸取自已安装 SDK 的 `Screenshot.data.width/height`；事务冻结 occurrence/view/revision/camera/gesture/layout/source 身份，使用同一取消信号和绝对截止时间，并在每个异步阶段后重新读取状态。观察截图期间若 ArcGIS `updating` 状态变化，客户端会等待连续两帧稳定并在原截止时间内重试；相机、来源、布局、修订或渲染健康变化仍拒绝。它把标注和完整来源署名换行合成为采用主题 token 颜色的页脚行，再用实际 `toMap` 样本推导 affine 系数并校验四个独立点（`capture-math.ts`）。无法读取相机时产生 `georeference.kind: 'none'` 与 `unreadable-camera`；`captureView()` 仍解析 `{ dataUrl, viewport }`。缺失/已销毁视图、SDK 停滞或抛错会以普通 `CaptureError` 对象 reject（`no-view` / `capture-timeout` / 带 `detail` 的 `capture-failed`）。`view-policy.ts` 同时拥有 zoom/scale 互逆对与取景估算。
- 每次 2D 相机静止都 POST 到 `/api/map/viewport`（`viewport.ts` 按会话保留最新一份，最多 256 个会话）。用户手势后静止的相机若不同于已接受的 `mapContainer.view`，还会写入一条 `set-view` 用户变更，因此重开或切换会话会恢复最终相机和最终图层状态。spatial-context 快照把它渲染为 `用户视窗` 行，模型无需对话消息即可基于用户所见推理。`gesture.ts` 仍做相机归因（`syncCamera`、focus `goTo` 的程序化写入静音），仅供测试指标；手势文本不进入对话。画布将 ArcGIS 清空后的 UI 与 overlay 内层保持指针穿透，未遮挡区域的拖拽与滚轮直达视图表面；组合用例断言实时相机位移且最新上报与新相机一致。

## 会话工具卡片

- `src/tool-cards/` 是全部空间工具唯一的展示字典：每个工具一条中文动作短语、一个图标类别，以及卡片列出的参数与结果字段，配带单位的格式化器（米/公里、平方米/平方公里、WGS84 度、计数）。几何数组与大段 JSON 不进卡片；残缺或流式中的参数退化为只显示动作名。
- 浏览器按字典条目各注册一个 keyed `tool.call.toolview` 行（`MapToolCard`）。行只从持久化的调用切片派生标题（`动作 · 对象`）、参数与结果行和失败错误码，因此实时流与回放渲染一致；字典之外的工具保持通用行。
- `@map-harness/map-tools` 用 `withPresentation` 包装每个注册的空间工具，复用同一字典生成 Host 的 `presentCall`/`presentResult` 卡片（ACP 与 CLI 面）。模型可见的 `output.render` 文本不变。
- 新增或改名空间工具必须在同一改动里补字典条目。`map-tools` 把字典重新声明为 `Record<SpatialToolName, …>`，缺条目即 `tsc` 失败；`withPresentation` 在注册时拒绝未收录的工具；`tools/tests/presentation.spec.mjs` 断言字典键与目录完全一致。
- 地图标签页浮层与工具行共用 `map-theme.ts`，样式读宿主 `--dsw-*` 设计 token，随宿主亮/暗主题切换。

## 版本与证据

`SymbolStyle` 与 `FeatureOverrides` 的版本令牌（`sym-…@v1`、`ovr-…@v1`）由全字段摘要推导，记录不经新版本无法被编辑；分类权威仍在 `spatial-viz` 的 `StyleSpec`/`LegendSpec`。

证据：`tests/`（投影、协议、occurrence 渲染身份、手势与面板通道、用户变更、标记状态/绘制/UI、派生面、制品路由）与 `map/arcgis-mcp/tests/composition.e2e.mjs` 的组合 lane。能力矩阵见 `map/docs/verification-matrix.md`，绑定契约见 `map/docs/map-container-binding.md`。

依赖方向：图层呈现沿 `map-container → map-layers → spatial-viz`，资源与制品读取沿 `map-container → spatial-catalog`。上游 `packages/` 从不导入本包；插件与其他插件一样经 loader 进入。

## 已知限制与延后工作

- 用户变更在通知进入收件箱时生效。若在下一轮之前以清空收件箱的方式取消 agent，通知被移除，地图保留该变更但模型永远不会得知。
- 面板编辑预设与单符号颜色；其它自由符号属性（线宽、虚线）仍经对话完成。
- 标记几何接受 Point、LineString 与单环 Polygon；本版不编辑 GeoJSON Multi* 或多边形洞。
