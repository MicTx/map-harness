# Map Harness 安装权威文档

本文是 Map Harness 安装、数据根、迁移与维护命令的唯一权威参考。程序分 portable（解压即用的 Web 服务包）与 managed（每用户安装、可维护升级）两种发行形态，两种形态共用同一套实例数据根规则；本文所有行为描述均以当前源码实现为准。发布附件与许可说明见 GitHub 发布规范，面向 LLM agent 的安装引导见 [Release 安装引导](release-install-guide.md)。

## 数据根解析

Map Harness 拥有独立于 DeepSeek Harness（DSH）的用户数据根。启动时按「正式版 / 预览版 / 源码开发」三类入口解析（[实现](../bin/instance-home.mjs)）：

| 入口 | 默认数据根 |
|---|---|
| 正式版（portable 或 managed，stable 渠道） | `~/.map-harness` |
| 预览版（preview 渠道） | `~/.map-harness-preview` |
| 源码开发（本仓库 checkout） | `~/.map-harness-dev/<checkout-key>` |

`MAPHARNESS_HOME` 是唯一公开覆盖；空白值视为未设置。值支持 `~`/`~/`/`~\` 展开和相对路径（按启动时 cwd 解析），路径中的空格按字面保留。`<checkout-key>` 是 checkout 规范化路径的 16 位摘要，用于阻止两个 worktree 的 profile 链接互相替换；同一数据根在 portable 与 managed 间切换时身份保持。

继承的 `DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_RESOURCE_CACHE`、`DSH_OFFICE_SIDECAR` **不参与** Map 数据根选择：它们只在解析时参与脱敏冲突检测。Map 数据根与已知 stock DSH 根（包含其 agents 与 runtime 缓存位置）、`~/.agents`、`~/.cache/deepseek-harness`、安装根、导入源根发生相等、包含或经符号链接指向同一位置时，启动报 `MAP_HOME_CONFLICT`，没有"警告后继续共享"的开关。首次启动会得到一个干净的 Map 实例；这不代表旧数据被删除。

数据根内由 `map/` 层创建的持久目录为 0700、文件为 0600；已存在目录的权限从不静默收紧。每个数据根在首次准入时写入 `map-instance.json` 标记（格式 `map-harness-instance-1`，`identityRevision` 1），记录 `instanceId`、mode、channel 与 source 模式的 `checkoutKey`。重启复用同一 `instanceId`；标记损坏、版本未知或与当前 mode/channel/checkout 不匹配时启动停止并报 `MAP_HOME_MARKER_INVALID` 或 `MAP_HOME_CONFLICT`。非空且无标记的数据根报 `MAP_HOME_UNCLAIMED`，需先完成显式导入（见「旧数据导入」），不做静默接管；并发首启或中断残留报 `MAP_HOME_INITIALIZING`。

实例解析后，Map 在加载任何上游 CLI、凭据服务或运行时下载之前，把内部 `DSH_HOME`、`DSH_AGENTS_HOME=<home>/agents`、`DSH_RESOURCE_CACHE=<home>/cache/runtime` 指向该数据根（[桥接](../bin/instance-home.mjs)）。外部启动入口会清掉继承的 DSH runtime/installation 路径与角色选择器；`DEEPSEEK_API_KEY` 等供应商变量和用户的 `.env` 照常透传。

## 启动与实例锁

一个数据根同一时间只允许一个 Map 主服务写者。锁由实际运行服务的进程持有：POSIX 用原生非阻塞 `flock`，Windows 用按数据根命名的本地内核信号量（[实现](../bin/instance-lock.mjs)）。锁被持有时再次启动报 `MAP_INSTANCE_BUSY`，不会启动第二个写者、不接管端口、不终止任何进程。`map-run/instance.json` 只保存非秘密诊断（`format:1`、productId/instanceId/generationId/version/pid/startedAt/state），`pid` 存活或端口占用都不构成实例身份；锁文件 inode 稳定，删除活锁文件会失去排他。

Map Web 端口默认固定为 `6425`（profile 配置 `port: !!js ctx.webStartup.port ?? 6425`），所有启动入口（源码、start:web、portable、managed）共用同一默认地址 `http://127.0.0.1:6425`；显式 `--port`/`--host` 继续走上游校验，被占用即报错，不扫描端口、不复用占用它的进程。

## 安装

### portable：解压即用

从 Release 下载与运行服务的主机操作系统和 CPU 匹配的附件（`mac-arm64`、`mac-x64`、`linux-arm64`、`linux-x64`、`win-x64`；Linux 目标使用 GNU libc），对照 `SHASUMS256.txt` 校验后解压。macOS/Linux 运行 `./start-web.sh`，Windows 运行 `start-web.cmd`。启动器定位包内同目标原生服务，校验 manifest 与全部列出文件后引导首次凭据配置并启动服务；全程不调用 PATH 中的 dsh/node/python，无需安装 Node.js、npm、Python 或桌面安装器。默认数据根 `~/.map-harness`；`MAPHARNESS_HOME` 可隔离状态。升级方式：停止旧服务、解压新包到旧程序目录旁或覆盖、运行新启动器；用户数据在程序目录之外，不受影响。

### managed：每用户安装

managed 包在 portable 基础上提供可维护的每用户安装（打包时全部目标均为 managed 发行才附带 `install-map.*`/`uninstall-map.*` 与逐目标 `map-install-manifest.json`；每平台默认安装根：macOS `~/Applications/Map Harness`、Windows `%LOCALAPPDATA%\Programs\Map Harness`、Linux `~/.local/opt/map-harness`；preview 渠道使用对应 Preview 名称）。安装与维护命令经 `map-harness manage` 分发（[实现](../bin/manage.mjs)）：

```text
map-harness manage install   --package-root <dir> --expected <file> [--install-root <dir>] [--data-home <dir>] [--json]
map-harness manage status    --install-root <dir> [--json]
map-harness manage doctor    --install-root <dir> [--json]
map-harness manage update    --archive <file> --checksums <file> | --package-root <dir> --expected <file> [--dry-run] [--json]
map-harness manage rollback  --to <version> [--dry-run] [--json]
map-harness manage uninstall [--install-root <dir>] [--dry-run] [--json]
map-harness manage import    --from <snapshot> --to <home> [--session ID] [--snapshot readonly|backup] [--max-bytes N]
map-harness manage import    --apply --plan <file>
```

- `install` 要求 `--package-root` 指向解压后的 managed 包目录、`--expected` 指向**独立保存**的 release identity 文件（`format: map-harness-install-identity-1`，含 product/distribution/channel/target/version/identityRevision/sourceDigest/payloadSha256），包内 manifest 自身不作可信身份输入。`install-map.sh`/`install-map.cmd` 先校验 `--manager-sha256 <64-hex>`（来自独立取得的 release checksums）再执行包内原生 manager；不匹配即退出，不执行任何包内代码。
- `--install-root` 或 `MAPHARNESS_INSTALL_ROOT` 只选择程序根，不影响数据根；`--data-home` 记录启动器默认数据根，安装器从不创建它。
- 安装事务顺序为 inspect → stage → verify → quiesce → backup-if-needed → commit → health → receipt：初始安装只认领空根，逐文件校验后发布不可变 `versions/<version>-<digest>/` 载荷、双槽文本指针（`active-slot`、`slots/A`、`slots/B`）与 `receipts/<operation-id>.json`，最后原子切换 active slot。同版本同摘要为 no-op；数据根、安装根与 stock DSH 根互相禁止重叠。
- `status` 报告布局状态（`absent`/`not-directory`/`empty`/`foreign`/`incomplete`/`damaged`/`ready`）与活跃版本；`doctor` 额外逐项校验布局、载荷字节与启动器字节。两者不启动服务、不读数据根内容。退出码：0 成功，2 usage，3 conflict，4 busy，5 environment（[定义](../bin/manage.mjs)）。
- 所有维护命令都接受 `--install-root <dir>` 或 `MAPHARNESS_INSTALL_ROOT` 选择程序根；用法行只为简洁省略。
- `update` 只接受同 product/channel/target 的更高版本（普通 update 拒绝降级）：`--archive` 必须配 `--checksums`（JSON 格式 `map-harness-update-checksums-1`，含 `archiveSha256`、`packageName`、`files[]`、`maxBytes`、`expected`），先按独立摘要校验归档再解压；`--package-root` 配 `--expected` 直接使用已验证的解压目录。`--dry-run` 完成校验与数据根状态判断后输出 `state: not-committed, result: dry-run` 的 receipt，不写载荷、不切槽。相同版本相同摘要为 `no-op`；数据根主服务忙时报 `MAP_INSTANCE_BUSY`，数据根无 Map 标记时报 `MAP_DATA_UNKNOWN`，都不推进提交。健康检查失败且数据未升级时自动切回旧槽；后续状态见 receipt 的 `committed`/`cleanup-pending`/`outcome-unknown`。
- `rollback` 只切回本安装中已登记、receipt 绑定且载荷校验通过的旧版本目录（`--to <version>`），不写新字节；仅当旧版本可读当前 `dataCompatibility` 时才允许，否则保持当前选择并报告恢复备份路径。
- `uninstall` 只删除收据列明且仍匹配本安装的文件与程序根；未知内容保留并报 `MAP_INSTALL_REFUSED`。数据根和用户工作区**永不删除**，本阶段没有 `--purge-data`。维护事务同样先取安装维护锁并检查数据根主服务锁；`--dry-run` 只输出计划。
- 退出码同上：0 成功（含 no-op/dry-run），2 usage，3 conflict，4 busy，5 environment；receipt 的 `state`/`result` 是机器可读事实，不按 message 字符串路由。

### managed 安装布局

```text
<install-root>/
  map-install.json              product/installation/channel/target/owned entries
  active-slot                   单行 A 或 B
  slots/A  slots/B              指向 versions/<version>-<digest> 的相对指针
  versions/<version>-<digest>/  不可变完整载荷
  map-harness(.cmd/.ps1)        稳定薄启动器，运行 active slot 的 start-web.*
  receipts/<operation-id>.json  每次操作的状态与摘要
  .map-maintenance.lock         安装维护锁
```

安装根只拥有登记条目；未知文件保留并报告。启动器经文本指针定位当前版本，不依赖 PATH 中的 Node 或 Python。Windows x64 的更新、回滚与卸载通过外置事务 worker 执行：`delegateWindowsTransaction` 在 win32 以 `process.execPath manage transaction-worker <request> <result>` 启动安装树外已校验 worker，等待归属安装树进程退出后以 `inPlace:true` 执行真实事务并写最终 receipt；本交付未在真实 Windows 主机验证进程枚举、SEA 自替换与命名信号量维护锁路径，不声明 Windows 平台资格。

## 旧数据导入

旧共享根（见迁移章节）中的 Map 数据通过显式导入迁移，**不整库复制、不移动、不硬链接**（[实现](../bin/instance-import.mjs)）：

1. 准备源快照：先停止旧 DSH/Map 写者，制作只读快照或一致性备份目录；`--snapshot readonly|backup` 声明快照性质，缺省 `unconfirmed`。
2. dry-run 生成计划：`map-harness manage import --from <snapshot> --to <empty-home> --session <ID> --snapshot readonly`。stdout 输出 JSON 计划（`format: map-harness-import-plan-1`），列出候选会话（`map-candidate`/`needs-selection` 分类、证据类型）、引用闭包（attachment、`spatial-store`、scale 引用）、字节数、`conflicts` 与 `unresolved`。无 `--session` 时列出候选但 `status` 为 `needs-selection`；存在冲突时为 `blocked`。Map 会话识别综合 analyst 头、版本化 Map 事件、Map 工具调用与 store 引用，单凭 `agentPreset` 或 cwd 不足以判定。
3. 选定会话后重跑 dry-run，将 `status: ready` 的计划保存到源与目标之外（如 `plan.json`）。
4. 执行导入：`map-harness manage import --apply --plan plan.json`。apply 只接受同源快照指纹的计划：目标发布前复扫源与目标，指纹或状态变化即报 `MAP_IMPORT_SOURCE_CHANGED` 保留 staging。所有已提交 Session 代际、附件与地图资源按引用闭包复制，摘要与 SessionId 不改；credentials、`.env`、browser-auth、identity、schedules、goals、settings、cache、logs、锁、run 记录与共享 agents/skills 一律不复制（[跳过清单](../bin/instance-import.mjs)）。目标必须为空、尚不存在或属于该未完成操作；已启动的数据根（含 `map-instance.json` 或 `agents/`）不能作为 `--to` 目标（`target-not-empty`）。导入会在目标发布带 marker 的完整实例，完成后可直接首次启动。
5. 导入器从不删除或修改源。源根保留到用户自行确认迁移成功。

预算与失败码：默认 `--max-bytes` 10 GiB、`--max-log-bytes` 64 MiB、`--max-files` 100000；超限、缺附件、活跃源、混合归属分别报 `MAP_IMPORT_BUDGET`、`MAP_IMPORT_MISSING`、`MAP_IMPORT_SOURCE_CHANGED`、`MAP_IMPORT_INCOMPLETE` 等具名错误。

## 迁移：从共享 `~/.dsh` 升级

旧版 Map 与 stock DSH 共用 `~/.dsh`（`MAPHARNESS_HOME → DSH_HOME → ~/.dsh`）；升级后旧数据与 stock DSH 不可再共享。升级到独立数据根的步骤见[升级指南](../../docs/upgrade-guide/v0.2.1-rc.3/map-standalone-home/guide.zh.md)。要点：不需要迁移时首次启动自动创建新的空数据根；要迁移旧数据则应在首次启动前对空目标执行导入。旧 `MAPHARNESS_HOME` 无标记非空根需先显式导入；`.credentials.yaml`、`.env` 与供应商 Key 不迁移，需在新实例重新配置。

## 错误码速查

| 前缀 | 错误码 | 含义与处理 |
|---|---|---|
| 数据根 | `MAP_HOME_INPUT` / `MAP_HOME_PATH` / `MAP_HOME_IO` | 路径非法、不可访问或 I/O 失败；检查输入与目录权限 |
| 数据根 | `MAP_HOME_CONFLICT` | 数据根与 stock DSH 根、安装根、导入源重叠；另选独立路径 |
| 数据根 | `MAP_HOME_MARKER_INVALID` / `MAP_HOME_UNCLAIMED` / `MAP_HOME_INITIALIZING` | 标记损坏、非空无标记需显式导入、首次初始化占用中 |
| 启动入口 | `MAP_ENTRY_CONTEXT` / `MAP_ENTRY_ARGUMENT` | 内部入口上下文或诊断参数不合法；从产品启动器重启 |
| 实例锁 | `MAP_INSTANCE_BUSY` / `MAP_INSTANCE_LOCK_FAILED` / `MAP_INSTANCE_RELEASE_FAILED` | 同根已有写者、锁获取失败、释放失败且服务必须保持停止 |
| managed | `MAP_INSTALL_INPUT` / `MAP_INSTALL_IO` / `MAP_INSTALL_SCHEMA` / `MAP_INSTALL_IDENTITY` | 输入、I/O、manifest/schema 或发行身份不匹配 |
| managed | `MAP_INSTALL_EXISTS` / `MAP_INSTALL_REFUSED` / `MAP_INSTALL_BUSY` | 已安装需走 update、根含未知内容、安装维护锁被占用 |
| managed | `MAP_INSTALL_STATE` / `MAP_INSTALL_DIGEST` / `MAP_INSTALL_PAYLOAD` / `MAP_INSTALL_SPACE` / `MAP_VERSION_CONFLICT` | 布局状态、摘要、载荷、磁盘空间或版本冲突 |
| managed | `MAP_DATA_UNKNOWN` | 记录的数据根无 Map 标记；先确认服务活动再维护 |
| 导入 | `MAP_IMPORT_INPUT` / `MAP_IMPORT_PATH` / `MAP_IMPORT_FORMAT` / `MAP_IMPORT_MISSING` | 参数、路径、计划格式或引用对象缺失 |
| 导入 | `MAP_IMPORT_BUDGET` / `MAP_IMPORT_SOURCE_CHANGED` / `MAP_IMPORT_CONFLICT` / `MAP_IMPORT_DIGEST` / `MAP_IMPORT_INCOMPLETE` | 预算、源快照变化、归属冲突、摘要不符或闭包不完整 |
| 通用 | `MAP_OPERATION_UNKNOWN` | 未知管理命令或该构建未搭载对应模块；按提示使用匹配版本 |

## 目录布局

数据根内的域目录、命名与权限规范见 [目录与路径规范](directory-layout.md)。
