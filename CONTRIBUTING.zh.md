# 贡献

[English](CONTRIBUTING.md) | 中文

感谢你愿意为 Map Harness 作出贡献！

本仓库（Map Harness）是 [DeepSeek Harness](./README.upstream.md) 的下游 overlay。上游代码的贡献请提交到 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)；本仓库的贡献只面向 `map/` 层（上游文件如何保持原样见 [map/UPSTREAM.md](map/UPSTREAM.md)）。

Map Harness 仍处于早期阶段、维护团队很小，目前无法接受外部 PR。以下方式同样有帮助：

- 把 `map/` 层的问题与观察报告到本仓库的 tracker；上游自身的问题请改报上游 tracker。
- 阅读与分享本项目；欢迎撰写有关 Map Harness 的博客文章与操作指南。
- 上游生态活动（围绕 DeepSeek Harness 的插件、讨论与社区问答）继续在 [README.upstream.zh.md](./README.upstream.md) 列出的上游社区频道进行。


文档与根目录门面文件以双语配对维护（`foo.md` + `foo.zh.md` + `foo.i18n.yaml` 一致性记录）；编辑任一侧后同步另一侧，并用 `pnpm run verify-translation-pairing --write <file>` 重录——见 [docs/i18n/README.md](docs/i18n/README.zh.md)。

探索未至之境。
