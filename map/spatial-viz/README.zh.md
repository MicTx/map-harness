---
description: "在本地工具中构造地图样式，在浏览器中显示已解析样式、图例、联动选择和时间控件。"
kind: "package-library"
---

# @map-harness/spatial-viz

[English](README.md) | 中文

## 摘要

用已解析的样式，让地图、图例、图表和表格保持同一份样式、数据与时间修订。本地工具通过包根入口计算分级断点、聚合地理数据并选择可视化方法。浏览器视图通过独立的 `/browser` 入口显示这些结果，并管理选择与播放。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本地工具实现导入 `@map-harness/spatial-viz`。浏览器视图与共享图层呈现辅助函数导入 `@map-harness/spatial-viz/browser`：

```text
import { classifyValue, legendOf } from '@map-harness/spatial-viz/browser'

const classIndex = classifyValue(style, value)
const legend = legendOf(style)
```

调用方提供已验证、具有固定断点和取值域的 `StyleSpec`。逐值呈现保留明确的缺失、下溢与上溢类别，不负责构造分级。浏览器入口还提供地图工作台使用的时间轴、联动选择、表格、直方图及视图清单函数。精确签名与类型由[浏览器入口](src/browser.ts)定义。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

主机入口与浏览器入口共享数据约定和呈现派生。[呈现辅助函数](src/display.ts)应用已解析的样式；[联动视图](src/linked.ts)从该样式派生选择与导出元数据。浏览器运行时依赖图只包含这些辅助函数、数据约定与时间轴实现。分级断点计算、聚合、扫描、数据画像和方法路由归主机入口所有。

构建分别生成 `lib/index.js` 与 `lib/browser.js`，因此浏览器调用方不会加载主机计算入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [可视化工作台](../docs/spatial-viz.md)说明消费这些函数的工具与地图界面。
- [主机入口](src/index.ts)定义完整计算 API。

-----

<a id="model-experience"></a>
## 模型体验

通过序列化计算结果与呈现元数据的可视化工具间接影响模型。

#### KV 缓存影响

本库不组装模型请求，也不编辑请求历史。调用工具负责发布的文本与元数据。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 浏览器显示与交互代码需要交付给浏览器；核心计算代码的保护由本地应用负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
