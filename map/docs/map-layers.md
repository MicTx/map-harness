# 图层呈现与影像图层

`@map-harness/map-layers` 是图层呈现的权威契约库，与 `spatial-viz` 的分类权威正交。分类样式（StyleSpec）决定分类颜色/分级尺寸/缺测形状；呈现符号（SymbolStyle）决定几何块基线（形状、尺寸与线宽、线型、填充/描边）与块透明度；逐要素覆盖在两者之上；ArcGIS 默认符号在最后。图例永远派生：已分类图层用 `legendOf(style)`，仅符号图层用 `legendOfSymbol(symbol)`，二者都不再决定颜色。

## 词汇与边界

- `SymbolStyle`：`presentation: 'single'` 时可带 `point`/`line`/`fill` 块（至少一个），`presentation: 'heatmap'` 时独占 `heatmap` 块且不得携几何块。块 `opacity ∈ [0,1]`（缺省 1）随符号色进 rgba，与层级 `opacity` 相乘生效，不是第二透明度通道。`sizePx ∈ [3,40]`、`widthPx/outlineWidthPx ∈ [0.5,12]`、`radiusPx ∈ [8,60]`、ramp ∈ `viridis/plasma/inferno/magma/blues/reds`；颜色一律 6 位 hex。
- `FeatureOverride`：`{ featureIds (1..256，条目内互异), patch }`，每条目 ≤16 条、层内 id 总数 ≤1024、载荷 ≤16 KiB；id 为 `featureIdOf` 稳定标识（GeoJSON `id` 成员或 `f-<n>`）。后条目覆盖前条目。
- `ImagerySpec`：零密钥 HTTPS 瓦片模板；无 userinfo、无 query/fragment、≤512 字符，须含完整 `{z}/{y}/{x}` 或 `{level}/{row}/{col}`，存储形式统一规范化为 `{level}/{row}/{col}`（带凭据的模板结构上不可入档）。
- `BasemapSource` / `BasemapSelection`：严格纯数据来源与成对选择记录；角色、投影、模式、兼容注记、发布日期、自动化许可以及截图许可是显式事实，宿主端点与凭据引用不进入公开记录。`null` 选择仍由容器解释为历史固定底图。
- 组名：1..64 显示字符、无控制字符；组集合是现用组名集合，无独立组注册表。
- 版本令牌：`sym-…@v1` / `ovr-…@v1` 与 `sty-…@v1` 同构——digest 不覆盖令牌自身，校验拒绝不重 derive 的载荷；预设展开自动同步推导。

## 确定性配色与预设

`autoSymbolOf(layerId)` 是纯摘要函数：层 id 规范摘要取 12 色类别色板槽位，同 id 永远同色、重放与新进程一致、无计数器与随机；碰撞率即色板大小（1/12）。生成的默认符号：点带白色光晕，面为 0.3 块透明度加同色相深描边。

`semanticBlocksOf(semantic)` 是固定语义符号表（12 词，色相互异）；`resolveSingleSymbol` 在显式块之下展开语义默认，渲染与面板图例都读解析结果，图例按数据几何族收窄行。`label.field` ≤64 显示字符，`minZoom/maxZoom ∈ [0,24]` 且 min ≤ max；heatmap 呈现不得携 semantic/label。`map_add_layer` 的版本化分支以它生成最小图例。

`SYMBOL_PRESETS` 是稳定 id 的预设表（`preset:<name>`）：marker 形状 × 色板基准 × 尺寸/透明度档位、四种线型、含半透明与仅描边两种面层档位、两种热力图档位。预设是工具边界的显式 resolve 步骤：id 展开为完整符号后再校验。

## 投影变更词（meta v8 / state v21）

三个变更词折叠进单一 `mapContainer` 投影，走既有 CAS/配对/幂等/撤销纪律：

- `set-layer-state`：`{ states: [{ layerId, visible?, opacity?, group?|null }] }`（≤32 条，每条目至少一字段、同层不重复）。presentation-only：不动 data/displayDigest、不烧渲染身份。inverse 为逐层先前值稀疏补丁，post-state 增 `layerStates` 切片。
- `set-symbol-style`：`{ entries: [{ layerId, symbol|null }] }`（≤8）；null 清除回落自动配色。
- `set-feature-overrides`：`{ entries: [{ layerId, overrides|null }] }`（≤8）；折叠时按层数据逐 id 核对存在性，未知 id 以 `feature-unknown` 整笔拒绝。
- `add-layer` 扩展：可携 `imagery` 身份块且 `data` 缺省（二者互斥）。
- `set-basemap`：`{ selection: BasemapSelection | null }`。`null` 只表示回到历史固定底图，不伪装成显式来源；逆变更为先前选择，兼容性在折叠层再次校验。
- `set-imagery-display`：`{ display: ImageryDisplayState }`。三层显隐、近期影像透明度 `[0,1]` 与固定早期 Wayback release；可见早期影像必须绑定固定 release，逆变更为先前显示状态。

层记录新增 `symbol`、`overrides`、`group`、`imagery`，状态携带显式 `basemap`、`imageryDisplay` 与可选 `role`；`MAP_META_SCHEMA_VERSION` 8、`MAP_PROJECTION_STATE_VERSION` 21（旧缓存行弃置重折叠）。v1–v7 记录照常解码；`set-basemap`、`set-imagery-display` 与其新字段只属 v8，旧版本构建对 v8 只读拒绝。heatmap 与分类样式互斥、且要求全 Point 要素——工具与折叠双层拒绝。`role: 'user-annotation'` 只允许固定 `user-annotations` 层使用，普通模型变更词不得创建、替换、移动或移除该层。

## 工具面

- `layer_set_state`（`states`、`expected_revision?`）：批量显隐/透明度/分组一次修订、可撤销；`map_get_state` 的层摘要透出 `opacity` 与 `group`。
- `layer_set_style`（`layer_id`、`symbol|preset|auto` 三选一、`overrides?`、`expected_revision?`）：符号与覆盖同调时合成一个 patch、一个修订。与 `map_set_view` 同类：纯投影变更、不发布 artifact、无发布配对。
- `map_set_imagery`（`labels_visible?`、`recent_visible?`、`recent_opacity?`、`early_visible?`、`early_release_id?`）：`early_release_id` 只接受官方固定 release，单独选择不自动显示，`null` 清除并同时关闭早期影像；`early_visible: true` 且未指定近期设置时，将可见且不透明度为 100% 的近期影像设为 50%，其余省略字段保持当前值。

注册面见 [capability-index 的注册铁律](capability-index.md#注册铁律)：名册、身份行、直连 handler、MCP 声明、帧名册与文档六件套全部适用；layer 工具还须在 `map-container/src/tool-cards/` 补展示字典条目（工具卡片见 [map-container 会话工具卡片](../map-container/README.zh.md#会话工具卡片)）。

既有 `spatial-collab` 的 `update-layer`/`upsert-layer` 保留为兼容路径：`update-layer` 展开 `...current` 天然保留新字段，`upsert-layer` 的整层重建按 id 从当前层保留 `symbol`/`overrides`/`group`；collab 词表不收窄、不改名。新代码只经新词表达状态变更。

- 会话中每个地图工具调用按 `map/map-container/src/tool-cards/` 的展示字典渲染为「动作 · 对象」卡片（中文动作名、带单位参数与结果、错误码）；新增或改名工具必须同时补字典条目，否则 `tsc` 与注册期失败（[map-container 会话工具卡片](../map-container/README.zh.md#会话工具卡片)）。

## 渲染与图例（browser 半）

occurrence 按 R4 顺序解析符号（override > 分类 > symbol > 默认）：块/覆盖透明度进符号色 rgba、层级 `opacity` 走既有 `graphics.opacity` 通道自然相乘；`renderToken` 增 `symbolVersion`/`overridesVersion`/imagery 段，token 不变零重建。heatmap 层以客户端 `FeatureLayer`（source=同层数据、`objectIdField: '__fid'`）+ `HeatmapRenderer` 承载（同数据、仅换载体）；所有色带的零密度端点均透明，不覆盖底图，正密度沿所选色带着色；imagery 层渲染 `WebTileLayer`（visible/opacity 直映射）。

## 验证入口

- `pnpm --filter @map-harness/map-layers run test`：契约正负例、版本令牌、预设等价、色板确定性。
- `pnpm --filter @map-harness/map-container run test`：`layer-state.spec.mjs` 与 `annotation-state.spec.mjs`（折叠/撤销/幂等/version 门/受保护角色准入）、`imagery-display-state.spec.mjs` 与 `source-overlay-render.spec.mjs`（三层显示状态、版本边界与早期在下/近期在上的渲染顺序）、`occurrence.spec.mjs`（R4 顺序、块透明度、heatmap 交换、tile 通道、token 重绘）。
- `pnpm --filter @map-harness/map-tools run test`：`layer-tools.spec.mjs`（真实 Session+投影链路、expected_revision、取消零变更、collab 兼容往返、tile 准入）。
- `snapshots/session/map-layer-styles`：真实 DeepSeek 录制的 `layer_set_state`+`layer_set_style` 链路，keyless 回放。

外部可感知变化（投影代际 9、词汇 v5、wire 新字段）见 [升级说明](../../docs/upgrade-guide/v0.2.0-rc.2/map-layer-presentation/guide.md)。
