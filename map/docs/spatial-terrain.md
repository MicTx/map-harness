# 地形与视线分析（spatial-terrain@1）

本文是地形与视线能力的现行契约：版本化 `spatial-terrain@1` 方法（垂直基准/单位/纪元、水平 CRS、精确资源版本绑定、精度预算、采样策略）、格网高程面与建筑/体素障碍、采样视线（line-of-sight）计算、以及有界地形预览显示。设计依据：[空间决策架构](../../.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md)（「地形、建筑、体素和视线分析依业务扩展，高程基准、地形版本和垂直单位是这些算法的前置元数据」）。

## 范围与不承诺

**做什么**：小规模注册 DEM 点格网上的采样视线/可见性、有界地形预览图层、遮挡诊断、斜距/水平距与高程误差报告。

**不做什么**：

- 不做实时地形、大栅格、多传感器融合或复杂体素分析（spec §3.2 由规模包承接）。
- 不做 viewshed 面域可视域（大规模栅格计算）。
- 不承诺椭球级精密测距：距离定义固定为观测点锚定的局部切平面（`local-tangent-plane`），路径超过 100 000 m 直接拒绝而不是给出误差未披露的答案。
- 不发明默认垂直基准：缺 datum/units/epoch 中的任何一项，精密分析在读字节之前就拒绝；WGS84 显示投影不是分析 CRS。

## 契约（`@map-harness/spatial-terrain`）

### TerrainSpec（`spatial-terrain@1`）

完全解析的规格，每个默认值在工具层写死后才做校验：

| 字段 | 约束 |
|---|---|
| `surface` | `ref`（`res-…@vN`，必须带版本）+ `revision`（内容摘要）+ `elevationField` + `horizontalCrs` + `vertical{datum,units,epoch}` |
| `vertical.units` | 本版只实现 `m`；其他单位具名拒绝（`vertical-units-unsupported`） |
| `curvature` | 必须显式声明：`none` 或 `refraction-corrected`（`refractionK ∈ [0,1)`，记录默认 0.13） |
| `accuracy` | `surfaceMeters`（必填，由调用者按 DEM 精度声明）、`observerMeters`、`targetMeters` |
| `sampling` | `intervalMeters` > 0、`maxSamples` ∈ [2, 65536]；超界拒绝而不是静默变粗 |
| `buildings`（可选） | Polygon 足迹 + `heightField`；`base: 'terrain'`（足迹质心处地表）或 `'absolute'`（`baseField`） |
| `voxels`（可选） | Point 单元中心 + `zField` + `cellMeters`；障碍与地表共用同一垂直基准 |
| `controlPoints`（可选） | 实测控制点；给出时必须配 `controlToleranceM`，计算前逐一核对，不合格拒绝 |

`revisionsMatch({ref, revision}, {ref, revision})` 是过期版本判定：ref 与内容摘要都相等才算同一版本。

### 高程面与障碍

- 格网：注册资源中的 Point 要素按经纬度晶格放置；缺格（`incomplete-grid`）、重复点（`duplicate-grid-point`）、非有限高程（`grid-point-invalid`）全部具名拒绝——洞不被插值掩盖。
- 插值：晶格内双线性；晶格外返回 `undefined`（不外推）。
- 建筑：射线式点在多边形内判定（切平面坐标）；`base: 'terrain'` 时基座取足迹质心处的地表高程，足迹出界拒绝。
- 体素：占据单元 `[z−cell/2, z+cell/2]`，只有视线真正穿过单元才遮挡——悬空单元不当作从地面起的实心柱。

### 视线计算

- 采样：观测点→目标点连线按 `intervalMeters` 等距采样（含两端）；所需样本数超过 `maxSamples` 拒绝（`beyond-sample-bound`）。
- 曲率/折射：对地表与障碍逐样本施加 `(1−k)·d²/(2R)` 修正（R = 6 371 000 m 固定常量）；`curvature: none` 时修正为零。记录在结果的 `curvature` 块。
- 遮挡诊断：首个低于障碍面超过不确定度的样本命名为 `firstObstruction`（样本序号、距离、射线高程、障碍高程、来源 terrain/building/voxel）。
- 距离：`horizontalDistanceM`（切平面）、`slantDistanceM`（端点直线），定义字段 `distanceDefinition: 'local-tangent-plane'` 一并记录。
- 判定规则（诚实语义）：
  - `visible`：全部样本的净空 > 不确定度；
  - `blocked`：存在样本净空 < −不确定度（给出 firstObstruction）；
  - `indeterminate`：两者之间——掠射视线在声明误差预算内的诚实答案，绝不强迫为 visible。
  - 目标端点不因裸地面自遮挡（地面目标净空恒为 0），但其上的建筑/体素仍计入；观测端点连同本地地面一起计入。
- 不确定度：`hypot(σ_observer, σ_target) + σ_surface`（端点按方和根、地表按线性叠加的保守上界）。

## 工具面

### `terrain_add_layer`（地图变更，携带 `map-change` meta）

从授权解析的精确地表版本装载有界地形预览：

1. 垂直元数据三元组（`vertical_datum`/`vertical_units`/`vertical_epoch`）必填，`vertical_units` 仅支持 `m`；校验在任何字节读取之前。
2. 经治理授权读取（`readResourceBytes`，域 + 摘要校验）后解析格网；结构缺陷具名拒绝。
3. 显示副本是晶格的确定性降采样（`MAX_TERRAIN_DISPLAY_POINTS = 1024` 上限），点要素携带 `elevation` 属性（2D 预览）；预览不是分析面。
4. 图层记录携带 `terrain` 身份块（`surfaceRef`/`revision`/垂直元数据/晶格形状），经标准提交协议折叠；浏览器 occurrence 把 revision 计入渲染身份 token，同一图层 id 换版本必重绘，卸载即清。

### `geo_line_of_sight`（分析 + 发布，携带 `spatial-terrain` meta）

- 完全解析 `TerrainSpec` 后校验；拒绝列出全部结构性问题（字段 + 稳定码）。
- `surface_sigma_m` 必填：判定规则只在声明了地表精度时才诚实。缺省即拒绝，不悄悄按 0 处理。
- 可选 `layer_id`：把解析出的版本与已装载预览的 revision 比对，不一致以 `TERRAIN_VERSION_CONFLICT` 拒绝——显示与分析永不静默分叉。
- 成功运行把解析规格与完整采样表发布为不可变 catalog artifact（经 accepted-call 配对），模型文本只保留有界摘要（verdict、firstObstruction、距离、不确定度、sampling、curvature、limitations）；durable `spatial-terrain@1` meta 记录方法版本、surface ref + revision、垂直元数据、specDigest、headline 与 artifact 引用。
- 取消/失败不发布、不改图；错误结果不携带 meta。

## 显示与分析共用一个 revision

同一地表版本的 revision（ref + 内容摘要）同时出现在：`terrain_add_layer` 的回执与图层记录、浏览器渲染 token 与测试 handle（`terrainRevisions`）、`geo_line_of_sight` 的结果与 `spatial-terrain` meta、发布的 artifact 输入引用。任何一处版本变化都会被另一处察觉：预览重绘、分析拒绝或显式重绑。

## 边界与归属

- 依赖方向：`map-tools → spatial-terrain`（纯库，零 map 内依赖）；`map-container` 只拥有 `MapLayerTerrain` 显示身份词表，不依赖 spatial-terrain。
- 持久化：`terrain` 是图层上的可选序列化字段，携带它的 meta 要求当前 `MAP_META_SCHEMA_VERSION`；`MAP_PROJECTION_STATE_VERSION` 升至 7，旧缓存丢弃后从日志重放（不改写历史）。
- 协同补丁不能写入 `terrain` 身份（collab 词表不携带该字段）；地形预览只经 `terrain_add_layer` 进入，补丁可以删除/重排它们。
