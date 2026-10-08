# Map Harness

[English](README.md) | 中文

Map Harness：[DeepSeek Harness](./README.upstream.md) 的派生智能体框架，为地理任务追加实时地图画布与空间分析工具。这一增量即地理空间可视化推理（Geospatial Visualized Reasoning）：当任务本身是地理的——选址、覆盖、叠置、分布——智能体在地图上绘制、查看并推理，而不是面对纯文本。

**开发者预览——版本间会出现破坏性变更。** 本 harness 可执行模型生成的命令并访问文件、进程与网络；运行前请阅读[安全说明](SAFETY.zh.md)。

<!-- 保留这些锚点：docs/user/guide/index.zh.md 与 docs/user/guide/providers.zh.md 链接到 #run；docs/user/develop/basic/{index,publish}.zh.md 链接到 #run-from-source。 -->
<a id="run"></a>

<a id="run-from-source"></a>

## 快速开始

前置条件：Node.js `^22.19.0 || >=24.0.0` 与 pnpm `11.7.0`（如 `corepack enable`），见 `package.json`。
```sh
git clone https://github.com/MicTx/map-harness.git && cd map-harness
pnpm install          # install workspace dependencies
pnpm run build:lib    # build upstream host libraries (host + client phases)
node map/bin/build-web.mjs   # build map packages and the web frontend under the map brand title
node map/bin/map-harness.mjs web    # start the map harness web UI (default profile: map-web)
```
最后一条命令默认在 `http://127.0.0.1:3080` 启动 Web UI 并打开默认浏览器；传入 `--no-open` 可跳过。后续见上游[用户指南](docs/user/guide/index.zh.md)。


## 架构

Map Harness 是派生项目：[DeepSeek Harness](./README.upstream.md)（上游，MIT）的树保持原样，本项目的增量只放在 `map/` 层。

```
Upstream verbatim (apps/ vendor/ ...; exceptions registered in map/UPSTREAM.md)
└── map/                      ← the only owned area of this repository
    ├── tools/                ← map toolkit (model-facing map/geo spatial tools)
    ├── client-ui-brand/      ← brand plugin, occupying the sidebar.brand.* official slot
    ├── profiles/map-web/     ← map-web bundle (brand patch layer)
    ├── bin/                  ← map-harness CLI wrapper and build scripts
    ├── docs/                 ← map layer design records
    ├── README.md             ← slot contract
    └── UPSTREAM.md           ← upstream update process
```

品牌与地图能力仅通过上游扩展插槽（按 id 替换或插入插件行的 patch 层）挂载；上游文件保持原样，仅 [map/UPSTREAM.md](./map/UPSTREAM.md) 登记的自有门面文件与集成补丁例外。完整插槽契约与逐包接入机制见 [map/README.zh.md](./map/README.zh.md)。

## 上游更新

见 [map/UPSTREAM.md](./map/UPSTREAM.md)：新版本导入 → 零冲突检查 → 重装依赖 → 重建上游与 map 层 → 冒烟，全程不触碰 `map/` 层。

## 贡献

贡献方式见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)，行为准则见 [CODE_OF_CONDUCT.zh.md](CODE_OF_CONDUCT.zh.md)；上游社区频道见 [README.upstream.zh.md](./README.upstream.md)。基准测试见 [BENCHMARK.md](BENCHMARK.md)。

## 许可证

Map Harness 以 [GNU Affero General Public License v3.0](./LICENSE) 发布。内置的上游 [DeepSeek Harness](./README.upstream.md) 代码版权所有 (c) 2026 DeepSeek，仍遵循其 MIT License（全文收录于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，第三方依赖及其许可证也披露于该文件）。
