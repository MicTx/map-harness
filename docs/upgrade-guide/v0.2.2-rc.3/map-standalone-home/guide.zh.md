---
kind: upgrade-guide
description: "Map Harness 不再共享 ~/.dsh：每个入口解析独立的数据根，忽略继承的 DSH_HOME 根，旧数据只经显式导入迁移。"
---

# Map 使用自己的数据根

[English](guide.md) | 中文

## 变更

Map Harness 此前按 `MAPHARNESS_HOME` → `DSH_HOME` → `~/.dsh` 解析数据目录，因此 stock DeepSeek Harness 安装与 Map 共用会话、凭据、调度、缓存和浏览器状态。Map 现在解析一个独立的数据根：发行版为 `~/.map-harness`，预览构建为 `~/.map-harness-preview`，源码检出为 `~/.map-harness-dev/<checkout-key>`。`MAPHARNESS_HOME` 仍是唯一的公开覆盖；继承的 `DSH_HOME`、`DSH_AGENTS_HOME` 或 `DSH_RESOURCE_CACHE` 不再选择 Map 的数据根，只用于拒绝冲突。同一数据根上的第二个进程以 `MAP_INSTANCE_BUSY` 失败，而不是接入运行中的实例；Map Web 端口默认固定为 `6425`（传显式 `--port` 可改用其他端口）；启动行显示 `map-harness web`。`~/.dsh` 下的旧数据留在原处，不再与新实例共享：首次启动创建一个空的新根，绝不删除或改写旧根。

## 迁移

1. 如果没有需要迁移的内容，启动一次 Map；首次启动会创建 `~/.map-harness` 及其 `map-instance.json` 标记、`agents/` 和 `cache/runtime/` 目录。用 `ls ~/.map-harness/map-instance.json` 确认。与 `~/.dsh`、`~/.agents` 或安装根重叠的数据根以 `MAP_HOME_CONFLICT` 失败；请选择单独的根。
2. 如果你设置了 `MAPHARNESS_HOME`，继续使用它。没有 Map 标记的非空目录以 `MAP_HOME_UNCLAIMED` 拒绝，不会被直接接管；用下面的导入迁入。
3. 要把选定的旧 Map 会话及其资源带过来，请在**首次启动 Map 之前**导入：停止旧写者，准备旧根的只读快照或静止备份，在 `~/.map-harness` 不存在或为空时运行 dry-run（`map-harness manage import --from <snapshot> --to ~/.map-harness --session <ID> --snapshot readonly`）；它打印一份 JSON 计划。把 `status: ready` 的计划保存到两个根之外，再用 `map-harness manage import --apply --plan <file>` 应用。导入会发布一个带标记的实例，随后即可启动。已启动过的根（带标记或含 `agents/`）会被拒绝作为目标；请导入到另一个空路径并改设 `MAPHARNESS_HOME`。凭据、`.env`、stock 会话、调度和共享 agents/skills 永不导入；请在新实例中重新配置供应商密钥。
4. 导出 `DSH_HOME` 为 Map 指定目录的脚本必须改为导出 `MAPHARNESS_HOME`。等待 `dsh web:` 启动行的脚本必须改为等待 `map-harness web`。
5. 确认隔离：在 stock DeepSeek Harness 运行时启动 Map，验证 `~/.dsh` 和 `~/.agents` 未变，然后打开打印的 `127.0.0.1` URL 并重新配置供应商密钥。
