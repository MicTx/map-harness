# @map-harness/map-layers

[English](README.md) | 中文

地图层的版本化图层呈现词汇——与 `spatial-viz` 分类权威并列的呈现权威。

- `SymbolStyle` —— 整层呈现记录：`single`（可选的 `point`/`line`/`fill` 块）或 `heatmap`（单块、独占）。每个块携带颜色、尺寸、线型与可选的块 `opacity`（`[0,1]`，缺省 1），它与层级透明度相乘，而不是取代它。
- `FeatureOverride` / `FeatureOverrides` —— 符号之上的逐要素稀疏补丁；解析顺序为逐要素覆盖 > 分类 > 符号 > ArcGIS 默认。
- `ImagerySpec` —— 影像叠加层的零密钥 HTTPS XYZ 瓦片准入；userinfo 与 query 字符串在结构上拒绝，存储模板恒为规范化 ArcGIS `{level}/{row}/{col}` 形式。
- 分组显示名 —— 1..64 字符、无控制字符；组集合是隐式的（现用组名），从不是第二注册表。
- `autoSymbolOf(layerId)` —— 确定性自动配色：层 id 的摘要落在固定 12 色类别色板的槽位；同 id 同色，无计数器与随机，重放稳定。
- `SYMBOL_PRESETS` / `resolveSymbolPreset` —— 内建 `preset:<name>` 库（marker 形状 × 色板基准 × 尺寸/透明度档位、线型、面层、热力图）。预设是工具边界的显式 resolve 步骤：id 展开为完整符号，再行校验。
- `legendOfSymbol` —— 单符号图例派生；行显式携带块透明度，使图例与渲染合成同一 rgba。图例只派生，从不第二次决定颜色。

版本令牌（`sym-…@v1`、`ovr-…@v1`）与 `spatial-viz` 的 `styleVersion` 同构：digest 覆盖令牌之外的每个字段，因此记录不经产生新版本就不可编辑。校验器返回全部问题（`LayersIssue`：字段 + 稳定码）而非抛出。

依赖方向：仅 `map-layers → spatial-viz`（复用 `isHexColor`、`vizDigestOf`、`featureIdOf` 语义）。投影折叠与工具导入本包；浏览器工作台经 map-container 消费。纯库——无宿主插件行。

```sh
pnpm --filter @map-harness/map-layers run test   # contract + palette suites
```
