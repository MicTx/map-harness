---
description: "描述并校验地图图层的呈现——符号、逐要素覆盖、影像叠加、底图来源与标记几何——并派生地图与工作台显示的图例。"
kind: "package-library"
---

# @map-harness/map-layers

[English](README.md) | 中文

## 摘要

用本库描述单个地图图层的外观并派生其图例。它拥有整层 `SymbolStyle`（单几何块或独占热力图）、逐要素稀疏覆盖、零密钥影像瓦片准入、不透明底图来源与选择记录、标记几何、分组名、确定性自动配色与预设符号库。地图工具、`mapContainer` 投影与浏览器工作台消费本包。校验器返回全部问题及稳定字段码，不抛出。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

在需要校验、版本化或解析图层呈现记录的地方导入：地图工具的参数边界、`mapContainer` 投影折叠，以及经 `map-container` 使用它的浏览器工作台。它是依赖库而非插件层，不声明 `cordis.yml` 行。

### 入口

```text
import { asSingleSymbol, autoSymbolOf, legendOfSymbol } from '@map-harness/map-layers'

const symbol = asSingleSymbol(autoSymbolOf('population'))
const legend = symbol === undefined ? undefined : legendOfSymbol(symbol)
```

`autoSymbolOf` 返回图层自动配色的单几何面，图例从该面派生；热力图符号没有符号图例。被拒绝的记录返回问题清单而非抛出。精确类型与接受范围由[包入口](src/index.ts)定义；呈现词汇、wire 字段与工具面由[图层呈现参考](../docs/map-layers.md)定义。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`SymbolStyle` 是可判别记录：`single` 携带可选的 point、line、fill 块，`heatmap` 携带一个独占块。块 `opacity` 与层级透明度相乘，而不是取代它。单符号还可声明 `semantic`（固定 12 词表）与 `label`（`field` 与可选缩放范围）；显式块按几何族取代语义块。`FeatureOverride`/`FeatureOverrides` 在图层符号之上叠加逐要素稀疏补丁，解析顺序为逐要素覆盖 > 分类 > 符号 > 语义块 > ArcGIS 默认；渲染与图例读取同一解析结果。`symbolVersion` 与 `overridesVersion` 的摘要覆盖令牌之外的每个字段，因此记录不经产生新版本就不可编辑。

`validate*` 系列把每个问题报告为携带字段路径与稳定码的 `LayersIssue`；`parseBasemapSource` 与 `parseBasemapSelection` 返回带相同稳定失败码的解析结果。`ImagerySpec` 准入只接受无 userinfo、无 query 的零密钥 HTTPS XYZ 模板，并存储规范化后的 `{level}/{row}/{col}` 形式。`BasemapSource` 与 `BasemapSelection` 携带品牌化 id、已校验发布日期、角色与兼容性检查，不含宿主端点或凭据引用。`AnnotationGeometry` 是浏览器草稿与宿主准入共享的封闭记录，准入拓扑与会话预算归 map-container 所有。

`autoSymbolOf(layerId)` 把层 id 摘要到固定 12 色类别色板，因此同一 id 在重放与新进程中始终同色；自动点带白色光晕，自动面为 0.3 透明度加同色相深描边。`SYMBOL_PRESETS` 是固定的 `preset:<name>` 库，由工具边界在进入投影前展开并校验。`legendOfSymbol` 先解析语义默认，显式保留块透明度使图例与渲染合成同一 rgba，并可按图层数据携带的几何族收窄图例行；图例只派生，从不第二次决定颜色。分组显示名为 1..64 字符且无控制字符，组集合是现用组名，从不是第二注册表。

| 源码 | 职责 |
|---|---|
| `src/contract.ts` | 符号块、覆盖、影像、分组名、版本摘要与校验器 |
| `src/semantic.ts` | 语义词表与已解析单符号 |
| `src/palette.ts` | 确定性 12 色自动符号 |
| `src/preset.ts` | 固定预设库与 id 解析 |
| `src/legend.ts` | 单符号图例派生 |
| `src/basemap.ts` | 底图来源与选择记录及兼容性检查 |
| `src/annotation-geometry.ts` | 共享标记几何记录与有效性检查 |

依赖方向仅 `map-layers → spatial-viz`（复用 `isHexColor`、`vizDigestOf`、`featureIdOf` 语义）；地图工具与投影导入本包，浏览器工作台经 `map-container` 读取。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [图层呈现参考](../docs/map-layers.md) — 呈现词汇、投影词汇、工具面与验证入口。
- [Map-container 契约](../map-container/README.zh.md) — 消费这些记录的投影折叠与浏览器工作台。
- [Spatial-viz](../spatial-viz/README.zh.md) — 相邻的分类权威（`StyleSpec`/`LegendSpec`）。
- [图层呈现升级说明](../../docs/upgrade-guide/v0.2.0-rc.2/map-layer-presentation/guide.zh.md) — 外部可感知的词汇与 wire 变化。

<a id="model-experience"></a>
## 模型体验

通过应用这些记录的 `map_*` 样式工具与 `mapContainer` 浏览器工作台间接影响模型；模型可见样式结果与渲染像素归这些消费方所有。

#### KV 缓存影响

本库不组装模型请求，也不编辑请求历史；发布的文本与元数据由调用工具与面板负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 预设与自动配色是固定库：部署不能注册新的预设 id 或色板槽位，其他呈现需显式符号记录。
- 标记几何仅接受 Point、LineString 与单环 Polygon；Multi* 几何与多边形洞不可编辑，准入拓扑与会话预算归 map-container。
- 影像叠加仅准入零密钥 HTTPS XYZ 模板；带认证的影像须经部署来源适配器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
