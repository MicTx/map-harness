---
kind: upgrade-guide
description: "地图底图选择与三层影像显示新增 map-change meta v8、投影 state v21 与三个模型工具。"
---
# 地图底图与影像显示协议

[English](guide.md) | 中文

## 变更

地图会话可携带显式 `BasemapSelection`：一个基础来源加一个可选且兼容的文字注记来源；另可携带 `ImageryDisplayState`，控制参考注记、近期影像与固定早期 Wayback 影像三层资源。成功的 `map_set_basemap` 或 `map_set_imagery` 工具结果会写入 `map-change` metadata v8，分别携带 `set-basemap` 与 `set-imagery-display` 变更。`mapContainer` 投影状态 v21 透出 `basemap`（`null` 表示历史上的固定 World Imagery 默认值）与 `imageryDisplay`（默认参考注记开、近期影像开且透明度 1、早期影像关）；`map_get_state` 同时报告两者。v1–v7 map-change 记录仍可读取；只接受这些版本的软件会对 v8 记录只读拒绝，不会误应用。低于 state v21 的投影缓存行从 Session 日志重折叠。

模型面新增只读 `map_list_basemaps`、带修订检查的 `map_set_basemap` 与带修订检查的 `map_set_imagery`。影像工具切换三层显隐、设置 `[0, 1]` 的近期影像透明度，并选择或清除一个固定官方 Wayback release；它只读取官方 release 目录，不抓取 local、coverage 或 metadata 证据。近期影像渲染在早期影像之上，透明度用于调节两期对比。自定义 MapServer、WMTS 与 XYZ 来源由 `Config.sources` 部署配置；来源端点和凭据引用留在宿主，不进入 Session 日志。

## 迁移

1. 更新外部 map-change 解析器以接受 `schemaVersion: 8`、`set-basemap` 与 `set-imagery-display` 判别词。保留 v1–v7 读取路径，不给早于这些字段的日志合成显式选择或显示状态。
2. 更新投影消费方读取必填 `basemap` 与 `imageryDisplay` 字段；把 `null` basemap 解释为历史默认值，并在旧 wire 省略影像状态时套用文档化默认值。丢弃 `stateVersion` 不是 21 的投影缓存行，并从 Session 日志重折叠。
3. 挂载地图 profile 时，把三个模型工具加入工具清单。受控来源配置在 map container 的 `sources` 设置下；不要把私有端点或凭据放进模型输入或持久化选择。
4. 验证方法是回放一个 v8 之前的 Session，逐层切换影像、设置近期透明度、选择并清除固定 Wayback release，重启 Loader，并核对显示状态、相机、业务图层与操作台账保持一致，同时不发生 local 或 metadata 抓取请求、Session 日志不出现私有端点。
