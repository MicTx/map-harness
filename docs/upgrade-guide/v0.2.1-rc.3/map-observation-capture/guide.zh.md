---
kind: upgrade-guide
description: "地图观察的客户端/服务端截图契约改为「先认领、后采集」握手，并新增可配置的源截图策略。"
---

# 地图观察认领与截图策略

[English](guide.md) | 中文

## 变更

`map_observe` 证据现在使用单一 `POST /api/map/observation` 路由：`action: "claim"`、携带令牌的 `kind: "capture"` 或 `kind: "decline"`，以及携带令牌的 `action: "cancel"`。客户端先认领已接受的 `observationRequest`，仅在该修订渲染后截图，再等待宿主异步校验。宿主使用共享严格回执 schema、当前请求/修订及宿主计算的来源、规范 base64 和一次有界 PNG 解码完成校验后保存附件；还会读回附件，仅当实际字节、摘要、PNG 类型、长度和尺寸均与准入截图一致时才发布元数据，归一化或改写图像会被拒绝。接纳证据经 `map-observation` 元数据 v1 折叠进 `latestObservation`。无效或错误令牌提交会保留待处理等待；只有有效结算、超时、受信任的工具清理或 dispose 才释放它。`MapPluginConfig.observation` 支持加载时解析的部分覆写，非法值使加载失败。`capturePolicy` 默认为 `unverified`，保留为来源策略元数据，不再阻止截图。可见栅格覆盖层纳入截图，隐藏或零透明图层不进入来源证据。

## 迁移

观察、动作和耗时的每轮限制现为可选，默认不限。可恢复失败保留本轮控制；用户接管或接受 `finish` 会停止本轮。自定义客户端读取 `mapContainer.interaction` 并向 `/api/map/use` 提交停止。相机候选不证明渲染完成。Agent 的候选决定使用 `agent-applied` 或 `agent-dismissed`，与人工审核状态区分。

1. 使用单一action路由：先认领，再携带该令牌提交截图回执或decline；取消使用同一令牌。
2. 自托管客户端须保留截图回执字段（`renderedRevision`、`viewId`、`generation`、`cameraEpoch`、`gestureEpoch`、`imageSize`、`mapContentRect`、`cssViewSize`、`camera`、`georeference`、`sources`、`includedOverlays`、`pngBase64`）。只有 `georeference` 为 `{ kind: 'none', reason: 'unreadable-camera' }` 时，`camera` 才可为 `null`。
3. 在 `MapPluginConfig.observation` 中只设置需要的资源限制。`capturePolicy` 和来源许可字段不再控制截图。`maxBytes`、`maxPixels`、`maxDimension`、`maxPending` 或 `maxEarlyClaims` 必须是文档界内的正整数。
4. 打开地图并调用`map_observe`：结果包含已保存附件、sha256、宿主校验的来源和地理参考；地图wire状态出现`latestObservation`。
5. 同时升级地图宿主与客户端。仅在需要限制时设置 `interaction.maxActions`、`maxObservations`、`maxElapsedMs`。新相机记录使用 map-change v7 和 map-use v1，旧记录仍可读取；旧投影缓存从 Session 日志重建。
6. 相机结果报告 `source_revision` 和拟提交的 `candidate_revision`；两者均不证明渲染。相机动作后省略 `map_observe.expected_revision`。可恢复拒绝后重新观察；用户明确接管时停止。
7. 更新候选消费方，区分 `agent-applied`、`agent-dismissed` 与人工接受、拒绝。`map_edit_annotation` 以 Agent 归属应用、排除或撤销候选。
