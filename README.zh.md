# Map Harness

[English](README.md) | 中文

Map Harness 是自托管的地理任务智能体：在实时地图上绘制、查看并分析。

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

当任务本身是地理问题——选址、覆盖、叠置、分布——智能体把数据放上地图，在模型支持视觉时查看自己画出的结果，并运行带版本的空间分析，而不是对着纯文本推理。每段对话拥有自己的地图：重启、上下文压缩或分叉之后，重放会话日志即可重建同一张地图。

> [!WARNING]
>
> 开发者预览：版本之间可能出现不兼容变更。智能体可以执行模型生成的命令，并访问文件、进程与网络；运行前请阅读[安全说明](SAFETY.zh.md)。

## 功能

| 能力 | 你可以做什么 |
|---|---|
| **对话驱动地图** | 用自然语言定位地点、添加或绘制图层、切换 2D/3D 与底图。使用支持视觉的模型时，智能体会查看地图截图，并可在部署设定的可选每轮限额内平移、缩放和查看地图；你自己对地图的操作始终优先。 |
| **图层与符号化** | 显隐、排序、分组图层，并用专题分级、热力图与逐要素覆盖调整样式；图例与实际渲染的符号一致。 |
| **底图与历史影像** | 使用 Esri World Imagery、固定版本的 Esri Wayback、OpenStreetMap 与天地图，并比较两个时相，确认新增、消失或变化的地物。 |
| **数据导入导出** | 导入 GeoJSON、CSV（含 TSV）、Shapefile（ZIP）与 KML（字段有歧义时等待你确认），通过天地图检索地名与 POI（需要天地图 key），按引用导出并附 SHA-256 摘要。 |
| **空间分析** | 缓冲区、叠置、面积、距离、等值线、核密度、坡度、通视与视域分析。 |
| **可达性与空间统计** | 借助高德、天地图、百度、腾讯或 Mapbox 的路径规划计算路网服务覆盖范围，用 Moran's I 与 Getis-Ord Gi* 检验空间自相关与热点，识别变化、聚类与流动模式。 |
| **决策与选址** | 按覆盖、公平与成本权重比较候选选址、做选址分配、验证预测；归因与效应结果标注 `causal`、`association` 或 `unknown`，相关性绝不会被报告为因果。 |
| **标注与协作** | 在受保护、普通图层变更无法替换的标注层上绘制、编辑和撤销标注，导出 GeoJSON，并发编辑按地图 revision 校验；智能体的标注修改记录为 agent 操作，不冒充人工审核。 |

<!-- 保留这些锚点：docs/user/guide/index.zh.md 与 docs/user/guide/providers.zh.md 链接到 #run；docs/user/develop/basic/{index,publish}.zh.md 链接到 #run-from-source。 -->
<a id="run"></a>

<a id="run-from-source"></a>

## 快速开始

Map Harness 从源码工作副本运行。需要 Node.js `>=24.9.0` 与 `package.json` 中 `packageManager` 锁定的 pnpm 版本；Linux 与 macOS 还需要 C 编译器，用于编译一个小型原生插件。

```sh
pnpm install                       # install workspace dependencies
node map/bin/build-web.mjs         # build the agent runtime, map packages, and the Web frontend
node map/bin/map-harness.mjs web   # start the Web UI with the map-web profile
```

Web UI 默认在 `http://127.0.0.1:6425` 启动并打开默认浏览器（`--no-open` 跳过打开，`--port <n>` 修改端口）。首次启动后，打开**设置 → 模型**，填入你自己的 DeepSeek API Key，或在启动前导出 `DEEPSEEK_API_KEY`。`pnpm run start:web` 与 `make web` 启动同一档案；`node map/bin/test.mjs` 运行 map 测试套件。

源码工作副本的数据位于 `~/.map-harness-dev/<checkout-key>`（可用 `MAPHARNESS_HOME` 改用其他目录）。天地图、高德、百度、腾讯与 Mapbox 的地图服务 key 均为可选，在设置中填写；Esri 底图无需 key。默认模型提供方是 DeepSeek，可在模型页[添加其他提供方](docs/user/guide/providers.zh.md)。数据目录的详细说明见[安装参考](map/docs/installation.md)。

## 工作原理

- **对话拥有地图。** 工具调用提出地图变更，被接受的变更折叠进会话投影，因此仅凭会话日志即可重现地图。
- **统一的空间工具目录。** 智能体调用登记在同一冻结目录中的空间工具，经进程内 MCP 服务器提供；见[能力索引](map/docs/capability-index.md)。
- **按对话的版本化数据。** 导入与派生的数据成为每段对话专属资源清单中的不可变版本，分析与导出都引用确切版本。
- **浏览器内的 ArcGIS。** 每段对话的地图用 ArcGIS Maps SDK for JavaScript 渲染在侧栏中。
- **仓库结构。** `map/` 包含 Map Harness 的全部代码：工具、地图容器、空间库、档案与发布工具（[包说明](map/README.zh.md)）。`map/` 之外的智能体运行时是 [DeepSeek Harness](README.upstream.md)（MIT），除 [map/UPSTREAM.md](map/UPSTREAM.md) 登记的根级项目文件与集成补丁外均原样导入。

## 文档

- [安装参考](map/docs/installation.md)：数据目录、按用户安装（managed）、升级与数据导入。
- [能力索引](map/docs/capability-index.md)：全部模型可见地图工具及其登记方式。
- [包说明](map/README.zh.md)：各 map 包及其接入智能体运行时的方式。
- [运行时用户指南](docs/user/guide/index.zh.md)：Web UI、模型提供方等运行时功能。
- [安全说明](SAFETY.zh.md)：运行可访问文件、进程与网络的智能体所涉及的风险。

公开源码树排除维护者的私有笔记和会话录制。使用这些录制的回放测试需要开发仓库。

## 参与贡献

欢迎在 [issue 区](https://github.com/MicTx/map-harness/issues)报告问题与观察；暂不接受外部 pull request。另见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)、[行为准则](CODE_OF_CONDUCT.zh.md)，私下报告安全漏洞见 [SECURITY.zh.md](SECURITY.zh.md)。

## 许可证

Map Harness 以 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布；商业使用需另行书面授权。旧版本保留其随附的许可。本仓库中的 DeepSeek Harness 代码版权所有 (c) 2026 DeepSeek，仍可依 MIT License 使用，许可全文与第三方依赖的许可一同收录于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
