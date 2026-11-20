# 地图能力索引与注册铁律

本文是 map 层模型可见能力的唯一注册规范：能力索引的真源、新增能力必须完成的注册链、各层禁止的行为，以及锁定索引一致性的门禁。协议与联动细节见 [arcgis-mcp.md](arcgis-mcp.md)；已知工程陷阱见 [engineering.md](engineering.md)。

## 真源

地图能力索引的真源是 `map/tools/src/spatial-catalog.ts` 的统一身份表 `SPATIAL_TOOL_CATALOG`：当前 72 个模型可见空间工具，每个名字一行，逐行记录 `name`、`family`、`owner`、`provider`、durable `metaKind` 与 `metaSchemaVersion`。名册层由 `map/tools/src/mcp-service.ts` 的 14 个家族名册数组构成，其并集就是冻结的 `SPATIAL_MCP_TOOL_NAMES`；家族（family，26 个）是比名册更细的能力语义分组，一个名册可承载多个家族。provider 的 `tools/list` 冻结、agent 侧 adapter、最终模型 assemble 全部对照这张表，未知、重复、缺失名在定义期抛错。

## 注册铁律

新开发任何模型可见地图操作能力——新工具名、新家族、新 meta kind——必须一次性完成以下六件套注册，缺任何一件都算索引漂移，而不是"以后再补"：

1. **名册**：在 `mcp-service.ts` 对应家族名册数组加入新名字。名册之间互斥，并集必须等于 `SPATIAL_MCP_TOOL_NAMES`；确需新名册时同步扩展该并集定义。
2. **身份行**：在 `spatial-catalog.ts` 的 `IDENTITY` 表加行，声明 family、owner、provider 与成对的 `metaKind`/`metaSchemaVersion`（只读无协议元数据的结果两者同置 null）。新 meta kind 同时在 `map-container` 协议与 fold 侧注册，保持单一地图真源。
3. **直连 handler**：在 `a-index.ts` 的 `DIRECT_SPATIAL_HANDLERS` 加条目。该记录的键类型是 `Record<SpatialToolName, ToolDefinition>`，漏条目直接编译失败——这是类型层面的注册强制，不要绕过它恢复手写数组。
4. **MCP 声明**：在 `arcgis-mcp/src/catalog.ts` 以 `server.registerTool` 注册同名工具并声明参数说明。MCP 参数说明不会自动继承 direct 工具 schema，两处文字由 parity 测试逐字段对照。
5. **帧名册**：在 `map/spatial-context/src/protocol.ts` 的 `FRAME_SPATIAL_TOOL_NAMES` 加名（空间上下文帧的工具折叠名单，与目录名册由 projection parity 测试钉住）。该包被 spatial-catalog 反向依赖，不能反向 import 目录表，所以名单独立维护、靠测试对齐。
6. **文档**：在 [arcgis-mcp.md](arcgis-mcp.md) 工具表格加行，写明 MCP 结果与持久化作用；新家族在本文现状清单补行。新增测试文件还须把路径登记进 [verification-matrix.md](verification-matrix.md)（verification-matrix.spec.mjs 强制）。

完成五件套后，能力才进入会话：tools/list 冻结名单、adapter、assemble、mapContainer fold 与文档表格由同一批门禁看住（见下）。

## 摩擦消解：会话、Agent、地图各层职责

- **会话层**只消费 tools/list 冻结名单与已注册的 durable meta kind；不得在会话配置里临时拼装地图工具。
- **Agent 层**只调用已注册名。map-analyst persona 明确：全部地图能力已在会话工具清单中，不得编造未提供的工具或参数；目录外需求用已注册工具组合实现，并在回答中说明限制。这是"不现场重写已有能力"的模型面表达。
- **地图层**只 fold 已注册 metaKind 的 `tool/result.meta`；未注册 meta 的结果被忽略，不产生第二份地图真源。

## 禁止行为

- 绕过 `DIRECT_SPATIAL_HANDLERS` 或 `SPATIAL_TOOL_CATALOG`，在插件体内现场写 handler 数组或按名字分支派发。
- 复制 direct schema 语义到 MCP 声明之外的任何第三份描述；文档表格是描述，不是真源。
- 在 preset、prompt 或 profile 里私加未注册的工具名；persona 提到的能力必须能在名册里查到。
- 运行时动态注册或注销地图工具；地图能力面是进程生命周期内冻结的。
- 把工具 schema 写入 prompt 后解析 JSON 文本代替真实 MCP 交换。

## 门禁

- `map/tools/tests/capability-index.spec.mjs`：名册唯一且并集等于名单、身份行完整且与名单一一对应、直连 handler 穷尽覆盖且仅覆盖名单、MCP `registerTool` 集合等于名单、[arcgis-mcp.md](arcgis-mcp.md) 覆盖全部名字。漏注册在此失败并点名工具。
- `map/tools/tests/mcp-tools.spec.mjs`：direct 注册暴露完整目录、tools/list schema 与 direct definitions 逐字段 parity。
- 定义期校验：未知、重复、缺失名在 provider freeze、adapter、assemble 三处立即抛错。

## 现状清单

| family | 工具 |
|---|---|
| map-mutation | map_add_layer, map_draw, map_remove_layer, map_set_view, map_fit_view, map_set_mode, map_set_basemap, map_set_imagery, map_use, map_markup, map_edit_annotation |
| map-read | map_list_basemaps, map_get_state, map_locate, map_observe |
| visual-change-read | map_compare_views |
| visual-change-write | map_mark_changes |
| geo-analysis | geo_buffer, geo_area, geo_intersect, geo_distance, geo_union, geo_difference, geo_perimeter, geo_point_line_distance, geo_nearest, geo_contour |
| catalog-write | catalog_register |
| catalog-read | catalog_resolve |
| map-save | map_save |
| catalog-data | data_import, data_export |
| layer-write | layer_set_state, layer_set_style |
| decision-write | decision_update |
| collab-write | map_apply_patch, map_undo |
| run-submit | run_submit |
| run-read | run_get |
| run-cancel | run_cancel |
| stat-analysis | stats_zonal, stats_autocorrelation, stats_hotspot, pattern_change, pattern_cluster, pattern_flow |
| decision-model | attribution_association, attribution_explain, attribution_effect, forecast_validate, forecast_fit, forecast_predict, scenario_compare, location_allocate |
| viz-read | viz_recommend |
| viz-style | viz_create_style, viz_density, viz_export_kml, viz_classify, viz_compare, viz_aggregate |
| terrain-display | terrain_add_layer |
| terrain-analysis | geo_line_of_sight, terrain_viewshed, terrain_slope |
| stream-workbench | stream_open, stream_advance, stream_pause, stream_resume |
| stream-materialize | stream_materialize |
| scale-ingest | scale_ingest |
| scale-read | scale_read |
| scale-scan | scale_scan |

durable meta kinds：`map-agent-annotation`、`map-change`、`map-visual-comparison`、`map-use`、`map-visual-proposal`、`map-visual-change`、`analysis-result`、`catalog-result`、`map-save-receipt`、`data-export`、`decision-change`、`accessibility-run`、`spatial-stat`、`spatial-decision`、`viz-style`、`spatial-terrain`、`spatial-scale`。只读无协议元数据的工具：`map_list_basemaps`、`viz_recommend`。
