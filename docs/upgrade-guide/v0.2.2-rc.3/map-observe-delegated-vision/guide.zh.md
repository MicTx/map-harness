---
kind: upgrade-guide
description: "map_observe 新增可选 focus，文本模型 Session 可经授权的视觉子会话读图；观察记录新增版本 4，OSM 变为可授权。既有记录与配置都不失效。"
---

# map_observe 为纯文本 Session 委托视觉子会话读图

[English](guide.md) | 中文

## 变更

此前，只要 Session 当前模型未经验证支持图像输入，`map_observe` 就以 `VISION_UNAVAILABLE` 拒绝。现在它改为解析可选的 `observation.vision` 路由（`provider`/`model`）：当 Session 的子代理模型选择策略授权该路由、且该模型经验证支持图像输入时，由一个视觉子会话读取截图，工具把子会话的结构化分析（`summary`、`observations`、`limitations`）以文本返回；**绝不**把像素交给纯文本模型。持久化的观察记录新增 schema 版本 4，且只有版本 4 携带 `visualAnalysis`（`provider`、`model`、`childSessionId`）；版本 1–3 仍可读，直读场景的写入与以往完全一致。

随之一起交付两处较小的事实：`map_observe` 接受可选 `focus`（1–512 字）作为视觉问题，省略时沿用 Session 目标；`osm-standard` 的 `automatedMapUse` 默认改为 `unverified`，并接受部署显式声明 `allowed`，OSM 专属的硬禁止已删除。来源许可仍是可读事实，不作为截图或地图操作的准入。

## 迁移

1. 当前模型支持图像的 Session 无需任何改动：观察仍为版本 3，图像照常交给模型。
2. 要让纯文本 Session 能观察，在 `map-container` 插件配置里设置 `observation.vision`，并通过子代理模型选择策略为该 Session 授权同一 `provider`/`model`。两者缺一，`map_observe` 仍以 `VISION_UNAVAILABLE` 拒绝——现在是在任何截图之前。
3. 按 `schemaVersion` 分支读取 `tool/result.meta` 的消费者必须接受 `4`：版本 4 的记录一定有 `visualAnalysis`，带 `visualAnalysis` 的记录一定是版本 4。只比较 `observationId`/`mapRevision` 的读者不受影响。
4. 基于版本 4 观察提出的 `map_markup`/`map_mark_changes` 候选必须命名读图子会话的 `provider`/`model`，否则以 `visual-proposal-pairing` 拒绝。
5. 依赖「OSM 对自动化使用一律拒绝」的部署，若想保留这一事实，应显式为 `osm-standard` 声明 `automatedMapUse: denied`；不会自动授予任何许可。
6. 只在需要回答特定视觉问题时传 `focus`；省略时行为与以往相同。
