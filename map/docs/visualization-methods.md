# 可视化类型与时空方法路由

## 摘要

`viz_recommend` 根据明确的分析场景和本会话实际载入的数据选择方法，返回支持状态、输出种类、缺口、限制与后续工具。它不运行分析、不修改地图，也不把选型当成统计证据。类型目录由 `map/spatial-viz` 独立维护，不依附 ArcGIS 对象或改变现有 `StyleSpec`/`SymbolStyle` 持久格式。

## 目录

- [类型与 schema](#类型与-schema)
- [场景选择](#场景选择)
- [数据条件与拒绝](#数据条件与拒绝)
- [GitHub 来源与范围](#github-来源与范围)
- [验证与扩展](#验证与扩展)

## 类型与 schema

`VisualizationSpec` 以 `schemaVersion`、`type` 标识选型意图，可绑定 `field`、`unit`、`measure`、`denominatorField`、`timeBinding`。[独立 JSON Schema](../spatial-viz/visualization.schema.json) 与 `VISUALIZATION_SPEC_SCHEMA` 同源，测试拒绝静态文件漂移。`VISUALIZATION_SPEC_SCHEMA` 提供 JSON Schema 结构校验；消费者还必须调用 `validateVisualizationSpec` 验证真实日历日期、IANA 时区、递增半开窗口及分母语义。结构合法不代表数据可用，也不代表 renderer 已实现。

`VISUALIZATION_CATALOG` 是类型、用途、几何要求、执行前提、限制和来源的单一事实来源。每项分别声明 `support` 与 `output`：`native` 为既有直接展示，`derived` 需已有工具计算几何或数值，`analysis` 只有表格/报告，`unsupported` 无可执行工具。完整目录从源码导出，以下按家族列出检索入口，不把外部项目能力算成本项目能力。

| 家族 | 目录身份 |
|---|---|
| 符号与类别 | `single-symbol`、`unique-value`、`graduated-symbol`、`proportional-symbol` |
| 分布与量值 | `choropleth`、`graduated-color`、`dot-density`、`bivariate`、`cartogram`、`heatmap`、`kernel-density` |
| 聚合 | `grid`、`hexbin`、`h3`、`point-cluster` |
| 连续表面与地形 | `contour`、`isoband`、`raster`、`hillshade`、`terrain`、`slope`、`viewshed`、`line-of-sight` |
| 移动与路网 | `network-accessibility`、`flow-summary`、`flow-map`、`od-arc`、`trajectory`、`animated-trips`、`vector-field` |
| 时间与比较 | `time-animation`、`temporal-change`、`small-multiples`、`swipe`、`comparison`、`realtime` |
| 统计与预测 | `hotspot`、`local-autocorrelation`、`space-time-cluster`、`uncertainty`、`forecast` |
| 三维 | `space-time-cube`、`extrusion`、`point-cloud`、`volume` |

## 场景选择

先提供 `scenario`，再绑定 `layer_id` 和实际字段。省略图层可发现相关方法与数据缺口；提供 `type` 会检查该精确方法，不会静默换成另一种方法。`time_binding` 为封闭对象，必填 `timeField`、`timezone`、`granularity` 和嵌套的 `window: {from, to}`；`from`/`to` 不能放在 `time_binding` 顶层。

| 场景 | 默认方法与后续工具 | 不可混淆的条件 |
|---|---|---|
| 定位 `locate` | 单符号；`layer_set_style` | 位置符号不是相对量值 |
| 类别 `category` | 类别渲染目录项 | 自动类别渲染尚未接入，返回 `unsupported` |
| 总量 `magnitude` | 分级点符号；`viz_classify` 的 `encoding=size` | 仅点；不是连续面积比例符号，不自动生成面质心 |
| 率/密度 `magnitude` | 面用分级设色，点/线用分级颜色；`viz_classify` | 必须是实际同行分子/正分母比值；缺测不是零 |
| 点浓度 `density` | 屏幕热力；`layer_set_style` | 全部 Point、2D、没有分类样式；像素强度随缩放变化 |
| 数值密度（指定 `kernel-density`） | `viz_density` → `map_add_layer` → `viz_classify` | 原始 resource 图层；均匀圆核质量/πr²，仅在样点求值，不是 Gaussian KDE 或连续面 |
| 点聚合 `aggregation` | 方格；`viz_aggregate` | 单元边长是经纬度度数，不是等面积米；仅 count/sum；产物是显示聚合 |
| 比较 `compare` | `viz_compare` | 两个不同兼容图层，字段、量纲、单位一致，统一断点；不是多窗或卷帘 |
| 变化 `change` | `pattern_change`；指定 `time-animation` 可做描述性时间轴 | 前者为 UTC 日/周/月统计表；后者支持时区时间轴，复用固定分类，不是逐帧重分级或显著性检验 |
| 流动 `flow` | `pattern_flow` 的观测转移表 | 需要非空字符串 entity 与明确 time，UTC 分箱和采样间隙检查；不生成 OD 线或轨迹 |
| 轨迹 `trajectory` | 轨迹目录项 | 轨迹构建/动态尾迹尚未接入，不能用转移表冒充 |
| 显著热点 `hotspot` | `stats_hotspot` | 需足够 Point 数值观测、邻域和多重检验；不是热力图 |
| 自相关 `autocorrelation` | `stats_autocorrelation` | 置换检验与邻居支持；相关不是因果 |
| 时空聚类 `cluster` | `pattern_cluster` | 空间半径、时间半径、min_pts 与覆盖率；不是显示 marker 聚合 |
| 可达性 `accessibility` | `run_submit` → `run_get` | 路网 provider、设施、人口和窗口需另行验证；不退回直线 buffer |
| 地形 `terrain` | `terrain_add_layer`；指定 `slope` 可得坡度报告 | 高程网格预览不是 DEM mesh，坡度汇总不是坡度栅格 |
| 可视 `visibility` | `terrain_viewshed`；指定 `line-of-sight` 可通视 | 表面版本、垂直基准、观察点与高度；视锥不是可视域，报告不是渲染栅格 |
| 表面 `surface` | 已加载 XYZ 用 raster；样点用 `geo_contour` → `map_add_layer` | 插值需采样支持、网格尺度与断点；等值线不是实测边界 |
| 预测 `forecast` | `forecast_validate` → `forecast_fit` → `forecast_predict` | 时间前推验证、基线、区间、漂移和外域检查；不自动生成预测地图 |
| 实时 `realtime` | `stream_open` → `stream_advance` → `stream_materialize` | 需流场景与事件源，静态 time binding 不能替代 |
| 不确定性 `uncertainty` | 不确定性地图目录项 | 尚无关联图形编码；已有报告区间不能被当成已绘制地图 |

## 数据条件与拒绝

工具从当前 Session 的已接受 projection 画像，不接受调用者上传的统计摘要，也不按字段名称猜单位。画像扫描选定字段的实际有限数、正数、非负数、明确偏移量时间戳、窗口内观测与同行比值，保留缺测；不把数字字符串转换为数字。带目录身份的主图层和比较图层在画像前重查本会话 `refStateOf`，revoked、tombstoned、recalled、unknown 均拒绝，不从旧显示副本继续派生模型可见摘要。

`data_profile.distinctCountSemantics` 说明字段的 `distinct`、`numericDistinct` 与 `ratio.distinct` 均封顶为 2：0 和 1 是精确计数，2 只表示至少两种取值，不是精确去重数，不能据此推断实际分类数。该限制保持画像扫描的去重内存有界。

`recommended` 表示选型数据条件满足，不是所有分析参数都已验证；仍需遵循返回的 `preconditions` 和工具参数。`needs-data` 列出明确缺口，不能执行建议来绕过缺口；`unsupported` 返回空 `nextTools`，替代类型仅供重新选择。所有结果显式 `analysisExecuted=false`，不携带统计或地图变更 meta；完整结果含引用与方法清单不超过 16 KiB。

## GitHub 来源与范围

来源用于核验方法分类与开源实现，不表示引入其代码、依赖或许可证。GitHub 无法被穷尽；这里覆盖主要方法家族、保留扩展身份，并以目录每项的 `sources` 为可检索入口。核验日期为 2026-10-26；通过 GitHub repository/contents/tree API 检查，语义级阅读与仅路径核验分开记录。

| 一手来源 | 本次读取或核验内容 | 许可与适用限制 |
|---|---|---|
| [deck.gl](https://github.com/visgl/deck.gl/tree/master/docs/api-reference) | 阅读 heatmap、screen-grid、hexagon、scatterplot 文档；核验 arc/path/polygon/column/point-cloud、H3/S2/geohash/trips/3D tile 等文档路径 | MIT；图层存在不代表本项目已接入 |
| [Kepler.gl](https://github.com/keplergl/kepler.gl/tree/master/docs/user-guides/c-types-of-layers) | 阅读 heatmap、trip 与官方用户指南；核验点/线/面/cluster/grid/H3/S2/vector/raster/WMS/3D tile/A5/flow/geohash/Zarr 类型路径 | MIT；路径核验不是完整 API 或精度验证 |
| [AntV L7](https://github.com/antvis/L7/tree/master/examples/demos) | 阅读 heatmap/grid.ts、line/flow.ts；核验 raster 的 NDVI/multiband/TIFF 示例路径 | MIT；只作跨引擎分类对照，不引入依赖 |
| [PySAL esda](https://github.com/pysal/esda/tree/main/esda) | 阅读 Moran 源码/官方说明；核验 getisord/geary/local/multivariate 模块 | BSD-3-Clause；显著性检验与描述性密度分开 |
| [MovingPandas](https://github.com/movingpandas/movingpandas) | 阅读 Trajectory/StopDetector API；核验 trajectory/aggregator/generalizer/smoother/splitter 路径 | BSD-3-Clause；轨迹分析不代表现有地图能绘制轨迹 |
| [Cesium](https://github.com/CesiumGS/cesium/tree/main/packages/engine/Source) | 阅读 CZML API；核验 CzmlDataSource、PointCloudShading、VoxelPrimitive 源文件 | Apache-2.0；仅核验源码路径的项不承诺渲染行为已实测 |
| [Esri 点密度示例](https://github.com/Esri/arcgis-pro-sdk-community-samples/blob/master/Map-Authoring/Renderer/DotDensityRenderer.cs) | 阅读 polygon quantities→DotDensityRendererDefinition 的实际代码 | Apache-2.0 示例；ArcGIS SDK 本身的许可另行约束 |
| [Esri CIM renderers](https://github.com/Esri/cim-spec/blob/main/docs/v3/CIMRenderers.md) | 阅读 BivariateFieldInfo/双变量图例条目 | GitHub SPDX 为 NOASSERTION，不视作已获可复制代码许可；只作规格引用 |
| [QGIS](https://github.com/qgis/QGIS/tree/master/src/analysis) | 核验 raster 的坡度/晕渲/KDE 与 network 文件；阅读 ST-DBSCAN 的 Point/time 参数和文件许可 | GPL-2.0-or-later（所读 ST-DBSCAN 文件）；不复制实现 |
| [GDAL viewshed](https://github.com/OSGeo/gdal/blob/master/alg/viewshed/viewshed.cpp) | 阅读 DEM→viewshed 算法入口、说明与文件头 | 所读文件 SPDX 为 MIT；仓库总体许可 API 为 NOASSERTION，不以仓库总标签替代逐文件许可 |
| [Topogram](https://github.com/shawnbot/topogram) | 阅读连续面积 cartogram README，核验 src 与 LICENSE | MIT；变形拓扑与本项目单符号不是同一能力 |
| [SpaceTimeCube](https://github.com/banbar/SpaceTimeCube) | 阅读 QGIS 插件的空间/时间分箱、Gi*/Moran 与逐时间片 TIFF 说明 | GPL-3.0；与当前二维时间筛选不同，不声称本项目已有 cube |
| [UncertaintyMapping](https://github.com/muwangshu/UncertaintyMapping) | 阅读不确定属性分级设色 README 与论文出处 | MIT；README 自述开发中、Usage 未提供，不把它推荐为成熟可集成方案 |
| [webgl-wind](https://github.com/mapbox/webgl-wind) | 阅读风场粒子示例的用途、数据输入和运行说明 | ISC；矢量场不同于普通 vector tile 图层 |
| [leaflet-side-by-side](https://github.com/digidem/leaflet-side-by-side) | 核验仓库 split-screen overlay 用途与 license | MIT；仅作卷帘交互参考 |
| [statsmodels forecasting](https://github.com/statsmodels/statsmodels/tree/main/statsmodels/tsa/forecasting) | 核验 forecasting/holtwinters/statespace 目录与 LICENSE | BSD-3-Clause；仅说明预测方法家族，不声称算法与本项目一致 |

`Esri/arcgis-maps-sdk-javascript-samples` 的 GitHub API 返回 404，未作为已核验来源；`Esri/jsapi-resources` 是模板/开发资源仓库，未拿它冒充全类型目录。未下载、运行或复制外部代码。

## 验证与扩展

`map/spatial-viz/tests/schema.spec.mjs` 校验目录覆盖和结构/语义拒绝；`profile.spec.mjs` 验证缺测、同行比值、原型键和窗口；`routing.spec.mjs` 锁住场景排他、未实现类型、原始 resource 条件与几何选择。工具级 `map/tools/tests/viz-recommend.spec.mjs` 使用真实 projection/catalog/MCP，断言隔离、撤回拒绝、模型输出回放和零地图变更。`snapshots/session/map-visualization-routing` 通过 `dsh --profile headless` 执行推荐与未支持方法拒绝。

扩展方法需同步类型身份、目录数据、实际工具与输出种类、路由前提、正向和相邻方法排他反例。只有真实实现与入口验证后才能把 `unsupported` 升为可执行；无需修改既有样式持久版本，也无需把全部目录塞入每轮提示。

## 开发备注

无。
