---
description: "通过 map_* 与 geo_* 工具，让地图分析 Agent 编辑、查询、测量并观察会话地图。"
kind: package-reference
---

# @map-harness/map-tools

[English](README.md) | 中文

## 概述

当会话需要地图编辑和空间分析时选择本包。`map_list_basemaps`、`map_set_basemap` 和 `map_set_imagery` 带修订检查地选择来源和影像。`map_edit_annotation` 可更新、删除、设置样式、排序或撤销标记，也可由 Agent 应用或排除视觉候选，并保留原作者。`data_export` 将标记发布为不可变 GeoJSON。`map_observe` 向支持图像输入的模型返回绑定修订的图像。

历史影像可在 `map_list_basemaps` 中指定 `source_id: 'esri-wayback'`，并可按关注点和缩放级别查询局部证据；`map_set_basemap` 必须指定固定 `release_id`。`map_set_imagery` 为早期影像层选择同样的固定 release，但不抓取 local 或 coverage 证据；`map_get_state` 报告三层显示状态。发布日期不等于拍摄日期，缺失的拍摄日期保持未知。宿主在应用选择前核验 release。

`map_markup` 把支持图像输入的模型对最新 `map_observe` 附图的判读转成带 WGS84 几何的有界 `sketch` 或 `target` 候选。Agent 可通过 `map_draw` 或 `map_apply_patch` 应用几何，用户仍可审查。候选自评不是概率。

比较两期固定 release 时，`map_compare_views` 核验已保存图像字节、发布日期、共同相机/CRS/affine/内容矩形/尺寸与覆盖层组合后返回两图；`map_mark_changes` 返回有界 WGS84 候选。发布日期不等于拍摄日期或变化发生日期；工具不输出面积、精度或召回率。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当选定的 Agent preset 应获得地图工具目录时，在组合中挂载此插件。

### 何时选择

当会话需要地图编辑、视觉观察或数值 geo_* 分析时选择本包；没有地图的会话应省略地图 profile，而不是注册宿主服务缺失的工具。

### 最小配置

本插件没有包级配置。地图宿主拥有来源目录、来源写入锁及观察资源限制。

```yaml
- id: map-tools
  name: '@map-harness/map-tools'
```

来源策略分类作为元数据保留，不阻止观察；见 [map-container README](../map-container/README.zh.md) 和[观察升级指南](../../docs/upgrade-guide/v0.2.1-rc.3/map-observation-capture/guide.zh.md)。

`map_use` 每次接受一个 `pan`、`zoom`、`click` 或 `finish`。每个像素动作消费最新的 `observation_id`，下次动作前须重新观察。平移/缩放结果给出 `source_revision` 和拟提交的 `candidate_revision`，不表示已接受或已渲染版本；相机动作后调用 `map_observe` 时省略 `expected_revision`，观察最新已接受状态。点击返回有界 SDK 命中与宿主派生属性，或空命中列表。每轮限制可选，默认不限。可恢复拒绝后可再次观察；用户明确接管或 `finish` 会停止本轮控制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 展开查看</summary>

`src/a-index.ts` 注册直接 Native 定义及其纯宿主 presenter。可选 MCP 消费方在 `src/mcp-tools.ts` 适配相同工具定义；对于 `map_observe`，它在 canonical structured result 上调用原生图像 renderer，使已保存的同一附件继续成为模型可见图像。底图工具先经地图宿主解析目录 id、角色兼容性、模式/投影支持与修订稳定性，再提出 `set-basemap` 变更；模型输入永不携带来源 URL 或凭据。`map_edit_annotation` 用配对的 Agent 结果编辑标记、设置图层样式和顺序、处理视觉候选；应用的候选归属 Agent，不伪称用户确认。标记 GeoJSON 导出冻结已接受地图修订。发布元数据前，观察工具会读回保存图像，并要求字节与已准入 PNG 完全一致。地图状态、来源传输、观察采集、投影元数据和工具卡片文案由 [map-container](../map-container/README.zh.md) 所有；MCP 传输与注册由 [arcgis-mcp](../docs/arcgis-mcp.md) 所有。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Map-container 契约](../map-container/README.zh.md) — 投影、客户端截图与工具卡片归属。
- [ArcGIS MCP provider](../docs/arcgis-mcp.md) — 内部 MCP 传输与执行绑定。
- [验证矩阵](../docs/verification-matrix.md) — 地图包检查与组合证据。

-----

<a id="model-experience"></a>
## 模型体验

### map_observe 结果

#### 请求上下文与条件

该工具要求当前调用已被接受、Agent 当前模型支持图像输入且附件存储可用。

#### 模型看到的内容

结果会追加有界 JSON 观察摘要，并把同一张已保存图像附件作为模型图像输入。工具描述为：`Observe this session's current map and return its image, observation id, sources, and positioning limits. Requires an open map and an image-capable current model. The image is evidence of the cited map revision, not a measurement; use geo_* or stats_* tools for numeric values.`

#### Token 效果

结果包含来源摘要、定位状态、限制说明与图像像素。图像 token 成本取决于截图尺寸及当前 provider 的图像计费方式。

#### KV Cache 效果

每次观察都会把一个新的工具结果和图像追加到 Session 历史，不会改写此前前缀。后续模型请求可能再次包含已有观察图像，缓存行为由 provider 所有。

## 已知限制与延期工作

- 来源不可用、凭据缺失、视图过期或模型不支持图像时，相应操作仍会拒绝。
- 没有有效 affine 地理参考的图像是只读证据；数值测量请用 geo_* 或 stats_* 工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 展开查看</summary>

本包不维护独立的工具目录。模型可见工具定义与 presenter 归 `src/a-index.ts`、`src/observation-tools.ts` 和 `src/presentation/` 所有；模型可见工具变更还应同步更新 map-container 的展示条目。

</details>
