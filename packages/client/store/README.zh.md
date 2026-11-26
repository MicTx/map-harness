---
description: "具有显式快照、订阅与生命周期所有权的浏览器可观察状态存储。"
kind: "package-library"
---
# @deepseek-ai/dsh-client-store

[English](README.md) | 中文

## 概述

供 Client 控制器与 renderer 适配器使用的不依赖 React 的 observable 和快照存储基础原语。本包负责同步与 animation-frame 发布、基于 Immer 的更新、浅比较和可选的浏览器持久化；`@deepseek-ai/dsh-client-ui-renderer` 负责构造 React 钩子。

Client 组合通过 `ctx.browserStorage` 提供浏览器本地持久化。空命名空间保留原有键，非空命名空间隔离键且不迁移原有数据。没有提供者的独立树使用独立的默认适配器。存储失败由操作所有者处理；订阅者在释放监听前接收外部变更，本地写入不会通知订阅者。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包提供浏览器侧状态基础原语，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些存储既不组装也不发送模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **持久化仅限浏览器本地**——持久化存储使用 `localStorage` 中的 JSON；非浏览器运行时会禁用持久化，本包也不提供跨设备同步。
- **Web 壳构建输入**——静态 ESM 为 Vite 保留第三方导入；独立消费方自行提供开发依赖（[依赖规则](../AGENTS.md#dependency-declaration)）。构建默认为生产模式；`NODE_ENV=development` 启用开发检查。整份替换的 `set()` 仅在非生产模式冻结快照；`update()` 保留 Immer 的自动冻结。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
