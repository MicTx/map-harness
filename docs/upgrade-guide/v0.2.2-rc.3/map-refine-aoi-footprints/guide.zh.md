---
kind: upgrade-guide
description: "map_refine_aoi 用真实 OSM 建筑足迹替换矩形 AOI 候选；spatial-connect 新增可由部署覆盖的无 key 足迹来源。既有工具、记录与配置都不失效。"
---

# map_refine_aoi 用建筑足迹精修 AOI 候选

[English](guide.md) | 中文

## 变更

新增 `map-mutation` 工具 `map_refine_aoi`，用真实建筑足迹替换像素矩形近似的 AOI 候选。它接受已有候选图层的 `candidate_id` 或显式 WGS84 `bbox`（每边 ≤0.05°），向配置的足迹来源查询窗口内的建筑，按「是否包含候选质心 → 与窗口的叠合比」为每个闭合足迹排序并全部返回——不合并、不声称边界。结果是一个真实多边形图层（版本化 `add-layer` 变更），要素带 `source`、`licence`、`attribution`、`selection` 与指向被替换候选的 `refines` 链接；原矩形保留不动，结果中列为 `superseded`。来源不可达、无数据与 4xx 分别为 `REFINE_SOURCE_UNAVAILABLE`、`REFINE_NO_FOOTPRINTS`、`REFINE_SOURCE_INVALID`，三种情况下候选都原样保留——空结果绝不回退到矩形。

来源是 spatial-connect 新增的 `spatialFootprints` 服务：默认无 key 的 OSM Overpass（`https://overpass-api.de/api/interpreter`，ODbL 1.0，署名 © OpenStreetMap contributors），带硬超时、仅对 429/5xx 的有限重试、响应字节上限与有界查询窗口。Multipolygon relation 不重建，只返回带 building 标签的闭合 way，结果的 limitations 会如实说明。精修候选的确认仍归用户。

## 迁移

1. 从不精修候选的 Session 无需任何改动：既有工具、记录与配置都不变。
2. 公共 Overpass 默认端点在受限网络下慢且不稳定。在 `spatial-connect` 插件配置里声明可达的镜像或私有足迹服务——`footprints: { baseUrl, timeoutMs, maxRetries, licence, attribution }`——或设 `footprints: null` 关闭来源；此时工具以 `REFINE_SOURCE_UNAVAILABLE` 拒绝，候选不变。
3. 读取 `tool/result.meta` 的消费者会看到新工具的 `add-layer` 变更，沿用既有 `map-change` kind；没有新的 meta kind 或 schema 版本。
4. 视觉提案记录可带可选属性 `supersededBy` 指向精修图层。它是属性不是状态：`VisualProposalStatus` 五态不变，历史记录缺省仍有效，按 `status` 分支的读者不受影响。
5. 枚举固定空间工具目录的读者必须接受 `map_refine_aoi`；arcgis-mcp 目录、直接 handler 与工具目录文档已列出它。
6. 精修足迹是 ODbL 许可数据：展示或导出该图层时保留工具报告的 `attribution`。
