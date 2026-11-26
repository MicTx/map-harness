---
kind: upgrade-guide
description: "开启固定早期影像时，可见的近期影像可能自动调整为 50% 不透明度。"
---

# 开启早期影像时混合不透明的近期图层

[English](guide.md) | 中文

## 变更

在地图面板选择或重新开启早期影像时，可见且不透明度为 100% 的近期影像会调整为 50%。`map_set_imagery` 在 `early_visible: true` 且同时省略 `recent_visible` 和 `recent_opacity` 时采用同一规则；显式设置优先。单独选择 `early_release_id` 仍不会改变早期影像的可见性。既有 Session 数据及其格式保持不变。

## 迁移

1. 如果 `map_set_imagery` 调用方在显示早期影像时需要近期图层完全不透明，请在同一次调用中传入 `recent_opacity: 1` 或显式传入 `recent_visible`。
2. 如果需要其他混合比例，请在地图面板选择或重新开启早期影像后调整近期影像的不透明度。使用 `map_get_state` 或面板中的近期影像行确认最终不透明度。
