---
kind: upgrade-guide
description: "地图页签不再向对话发送 `[map-gesture v1]` 视图观察；视窗改为以快照上下文进入模型。"
---

# 地图视窗改为隐式模型上下文

[English](guide.md) | 中文

## 变更

此前，用户在 map-web 地图上拖拽会以 `[map-gesture v1]` 用户消息 steer 正在运行的轮次，地图页签还有一个「发送视图观察」按钮用于排队发送一条。现在手势文本不再进入对话，按钮已删除。每次 2D 相机静止都 POST 到 `/api/map/viewport`，下一次 spatial-context 快照携带 `用户视窗` 行（中心、缩放、可见范围、WKID、2D/3D）和 `地图环境` 行。

map-web 的两项默认值随之变化。spatial-context 的步数预算不再有默认上限：快照显示 `steps N/不限`，`budget.maxModelSteps` 只在组合显式设置时生效。`spatial-accessibility` 行只在设置了 `TIANDITU_API_KEY` 时加载；未设置时 `run_*` 工具返回 `SPATIAL_SERVICE_UNAVAILABLE`，插件不再在加载期失败。

受影响的是读取 `[map-gesture v1]` 消息、点击已删除按钮或依赖 64 步默认上限的自动化与测试。`MapOccurrence.submitGestureObservation()` 仍然存在，但地图界面不再调用它。

## 迁移

1. 从快照的 `用户视窗` 行或宿主 `mapViewport` 服务（`viewportOf(sessionId)`）读取用户视窗，不再解析 `[map-gesture v1]` 消息。
2. 删除点击 `[data-gesture-submit-button]` 的界面自动化；相机无需该按钮即可到达模型。
3. 需要保留步数上限时，在 overlay 的 spatial-context 行设置：

   ```yaml
   - id: spatial-context-agent
     config:
       budget:
         maxModelSteps: 64
   ```

4. 没有天地图 key 又要运行可达性任务时，用免 key 的 provider 启用该行：`- id: spatial-accessibility`，设 `disabled: false` 与 `config.provider: controlled-lattice`。
5. 确认：启动 `node map/bin/map-harness.mjs web`，平移地图后发送一条消息，检查模型请求中包含 `用户视窗:`。
