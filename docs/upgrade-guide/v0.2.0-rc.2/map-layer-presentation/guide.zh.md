---
kind: upgrade-guide
description: "地图图层新增呈现状态（显隐、透明度、分组、符号、逐要素覆盖）与零密钥影像叠加层，meta schema 升至 v5；旧版读取器对 map-change 只读拒绝。"
---

# 地图图层呈现词汇与影像图层

[English](guide.md) | 中文

## 变更

地图图层线格式升至 meta schema 版本 5。变更词汇新增 `set-layer-state`（批量显隐、透明度与显示分组名）、`set-symbol-style`（整层符号或热力图呈现）与 `set-feature-overrides`（符号之上的逐要素补丁）；`add-layer` 新增可选的 `imagery` 身份块，承载零密钥 HTTPS 瓦片叠加层。图层记录可携带 `symbol`、`overrides`、`group` 与 `imagery`；影像层没有要素数据，`data` 与 `imagery` 互斥。

两个模型工具暴露上述新词：`layer_set_state` 与 `layer_set_style`。两者都是纯投影变更、不发布产物，因此没有发布配对。`map_add_layer` 增加第三互斥来源 `tile_url`（及 `tile_attribution`）：模板必须为 HTTPS、零密钥（无 userinfo、无 query）且含 `{z}/{y}/{x}` 或 `{level}/{row}/{col}`，存储形式统一规范化为 `{level}/{row}/{col}`。

持久化投影代际 8 → 9：旧版本写下的缓存行被弃置并从会话日志重折叠。版本 4 的变更记录仍可解码（旧词汇）；旧版构建遇到 v5 记录只读拒绝而非误读。`map_add_layer` 的版本化分支现在以图层 id 的确定性色板推导最小图例，不再使用单一常量蓝色，因此重放录制会显示逐图层图例颜色。

## 迁移

1. 重建全部 map 包（`pnpm run build && node map/bin/build.mjs`）；profile 链接构建后的 `lib/` 入口，过期的 `map-container` lib 无法折叠新词。
2. 不要改写会话日志。携带 v4 map-change 记录的旧日志照原样重放；新投影缓存在代际 9 重新折叠它们。
3. 仅需变更显隐、透明度或分组时，用 `layer_set_state` 取代整层替换（upsert 或替换式 `add-layer`）——替换会重新准入数据并烧掉渲染身份，新词两者都不触碰。
4. 断言 `map_add_layer` 图例的录制期望会变色：图例现由图层 id 推导。用仓库自身的录制/刷新命令重录受影响场景，不要手工改动期望文件。
5. 热力图呈现要求全为 Point 要素且无分类样式的图层，线、面与已分类图层一律拒绝；逐要素覆盖的 id 必须存在于图层数据（`featureIdOf` 键），未知 id 以 `feature-unknown` 诊断整体拒绝。
6. 浏览器面板应读取新 wire 字段（`symbol`、`overrides`、`group`、`imagery`），并经由 `legendOfSymbol` 派生符号图例；已分类图层的图例仍来自 `legendOf(style)`，绝不来自符号。
