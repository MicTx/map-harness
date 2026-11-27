# 目录与路径规范

本文是地图产品创建或读取的全部路径的权威规范：Harness home 内的数据与配置、会话工作区、系统临时目录和构建输出。路径的位置、命名与权限都由数据本身的性质推导，不按习惯指定。登记表由 `map/tests/directory-layout.spec.mjs` 与源码双向对照；存储内部布局与生命周期见 [存储对象清单](storage-lifecycle.md)。

## 推导原则

一条路径应放在哪里，由数据的四个性质决定：

| 性质 | 问题 | 决定什么 |
|---|---|---|
| 所有者 | 谁写入、谁定义格式 | 一个目录段只属于一个所有者；所有者导出该段内的名称常量 |
| 可重建性 | 丢失后能否从别处重建 | 权威数据进 home 存储根并参与备份；派生缓存进 `<map-home>/cache/`；一次操作的中间态用临时目录 |
| 生命周期 | 随安装、会话还是单次操作存在 | 安装级与会话级进 home；单次操作结束即删除 |
| 可见范围 | 只属于本机用户、可由用户编辑，还是可公开 | 用户数据仅所有者可读；用户可编辑的配置走上游 profile 补丁层；可公开的只有构建输出 |

由此得到五类落点：

| 类别 | 落点 | 例子 |
|---|---|---|
| 权威用户数据 | `<map-home>/<域>-store/` | 目录库、可达性运行库 |
| 用户配置 | 上游 profile 与补丁层 | `<map-home>/profiles/map-web/cordis.patch.yml` |
| 写入前暂存 | 所属存储根内的 `staging/` | 导入字节、scale 分块 |
| 进程临时目录 | `$TMPDIR/map-<用途>-XXXXXX/` | 发布暂存、原生自检 |
| 构建与发布输出 | `<仓库>/.dsh-build/map-<用途>/` | 原生成品、公开构建记录 |

暂存放在存储根内而不放系统临时目录：发布靠 `rename` 原子完成，而 `rename` 只在同一文件系统内原子。

保持单一 home 根，不拆分到 XDG 目录：一个 `MAPHARNESS_HOME`（或按入口区分的默认根）即可隔离或迁移全部状态。需要与数据分开清理的缓存放 `<home>/cache/`。

## 目标布局

```text
<map-home>/                            解析规则见 installation.md：release=MAPHARNESS_HOME→~/.map-harness；
│                                      preview=MAPHARNESS_HOME→~/.map-harness-preview；source=MAPHARNESS_HOME→~/.map-harness-dev/<checkout-key>
├── map-instance.json                  实例标记（format map-harness-instance-1，identityRevision 1）
├── agents/                            本实例代理指令/共享 skills 根（内部 DSH_AGENTS_HOME 桥接目标）
├── cache/runtime/                     运行时/工具下载派生缓存（内部 DSH_RESOURCE_CACHE 桥接目标）
├── map-run/                           实例锁与非秘密诊断记录
├── map-maintenance/                   导入清单与维护操作记录
├── profiles/map-web/                  上游 profile 格式；启动器首启初始化，已存在的文件不覆盖
│   ├── package.json                   bundle 栈：base → web-app → map-web
│   ├── cordis.patch.yml               用户补丁层
│   └── node_modules/@map-harness/     源码检出链接（仅源码 wrapper）
├── spatial-store/                     spatial-catalog 的 root
│   ├── sessions/<sessionId>/          每会话一库
│   │   ├── store.db
│   │   ├── files/<id 前 6 位>/<id>-v<N>.geojson
│   │   ├── staging/  backups/  trash/
│   │   └── scale/{versions,staging}/
│   └── trash/                         整库删除的原子中转
└── accessibility-store/               spatial-accessibility 的 root
    └── accessibility-runs.db
$TMPDIR/map-<用途>-XXXXXX/             单次操作，任何退出路径都删除
<仓库>/.dsh-build/map-<用途>/          构建与发布输出，gitignored，`pnpm run clean` 删除
<工作区>/                              会话 cwd；地图工具只读
```

数据根内其余顶层名（`sessions/`、`storages/`、`attachments/`、`logs/`、`.env`、`.credentials.yaml` 等）归上游运行时所有，在 Map 独立数据根内由上游按同一 `DSH_HOME` 桥接值写入；地图层不写这些名称。旧共享根不再作为任何 Map 入口的默认值或回退（解析与冲突规则见 [installation.md](installation.md)）。

## 命名

- 段名只用小写 ASCII 字母、数字和连字符：在大小写不敏感的文件系统、Windows 文件名规则、URL 与 shell 中都无需转义。
- 地图层独占的名称以 `map-` 开头。home、系统临时目录和构建输出都是与上游及其他程序共享的命名空间；统一前缀让地图产品的全部落点能按前缀枚举、备份和删除，也不会与上游以后新增的名称冲突。`spatial-store/` 与 `accessibility-store/` 是已承载用户数据的存量名，保留不改。
- 存储根内部的名称由所有者导出为常量（如 `STORE_DB_NAME`、`STORE_DIRS`、`SESSIONS_DIR_NAME`），其他包经常量或所有者 API 取路径，不重写字面量。
- 扩展名表示内容格式：`.db` 为 SQLite，`.geojson` 为 GeoJSON，逐行 JSON 用 `.jsonl`。
- 格式版本写在内容里（SQLite `PRAGMA user_version`、manifest 版本字段），不写进路径；只有不兼容的新世代必须与旧世代并存时，路径才带 `v<N>`。`<id>-v<N>.geojson` 中的 `v<N>` 是对象版本，属于数据身份。
- 不可信标识（会话 id、资源 id、用户起的名称）进入路径前由所有者校验为单个可移植段，在任何 `join` 之前以具名错误拒绝；会话库的规则在 `map/spatial-storage/src/sessions.ts`。
- 持久数据中的引用只存存储根内的相对路径与稳定 id，不存主机绝对路径，备份才能恢复到另一位置。

## 创建与权限

- 地图层创建的持久用户数据目录为 0700，文件为 0600；首启生成的 profile 与 preset 配置同样按所有者私有创建。SQLite 数据库先以 `openSync(path, 'wx', 0o600)` 建出空文件再交给 SQLite，WAL 与 SHM 文件随主库权限创建。
- 已存在的目录与文件不改权限：用户可能有意放宽了它们。
- 启动器创建缺失的 home 时只把 home 本身建为 0700，父目录保持系统默认。
- 写入按暂存、校验、改名完成：字节先写进同一存储根的 `staging/`，校验后 `rename` 到最终位置，最后登记目录行。崩溃只留下可回收的暂存字节，不会留下指向缺失文件的登记。
- 删除先 `rename` 进所属根的 `trash/` 再删除，读者看不到删了一半的目录。

## 临时路径

- 系统临时目录只服务一次操作，不跨进程重启保存状态；需要保存的中间态属于存储根内的 `staging/`。
- 创建方式固定为 `mkdtempSync(join(tmpdir(), 'map-<用途>-'))`：随机后缀与 0700 权限由 `mkdtemp` 保证，前缀让残留能找到所有者。
- 每条退出路径都删除：函数内用 `try`/`finally`；脚本可能经 `process.exit()` 退出时，用 `process.once('exit', …)` 登记删除。
- 插件源码（`map/*/src/`）不用系统临时目录，中间态放在自己的存储根内，与会话隔离和授权域保持一致。scale worker 的入口脚本因此写在 `scale/staging/job-*/`。
- 测试的临时根用 `trackedTmpDir`，规则见 [验证矩阵](verification-matrix.md) 的资源可靠性约定。

## 工作区

- 会话工作区是用户自己的目录，常常是 Git 仓库。地图工具只读它：读取一律经 `readBoundedWorkspaceFile`（工作区包含校验、逐段不跟随符号链接、字节上限）。
- 地图层不在工作区创建文件或目录，也没有 `.map/`、`exports/` 之类的固定目录。导入的数据复制进目录库成为不可变版本；导出产物发布进目录库，用户经界面下载并自选保存位置。
- 返回模型的结果与错误不含主机绝对路径。工具参数里的 `path` 按原样记入结果元数据；它与调用参数一样已在会话日志中，不额外暴露信息。

## 配置与解析

- 数据根解析只认 `MAPHARNESS_HOME`（空白视为未设置），按入口取默认根：release `~/.map-harness`、preview `~/.map-harness-preview`、source `~/.map-harness-dev/<checkout-key>`；`~`、`~/`、`~\` 展开为用户主目录，相对路径按启动目录解析。继承的 `DSH_HOME`/`DSH_AGENTS_HOME`/`DSH_RESOURCE_CACHE` 不参与选择，只参与冲突拒绝（重叠即 `MAP_HOME_CONFLICT`）。源码 wrapper 与原生启动器都在准入后把解析结果桥接为内部 `DSH_HOME`/`DSH_AGENTS_HOME`/`DSH_RESOURCE_CACHE`，此后所有子路径由上游从这一个值派生。完整解析、标记与导入规则见 [installation.md](installation.md)。
- 插件不自行解析 home、启动目录或系统临时目录：存储根是受验证的必填 Config 字段，由 profile 以 `dshHomePath('<段>')` 提供。只读的外部路径登记在下文“外部路径”表。
- 不新增地图专属配置文件：持久修改写 `<map-home>/profiles/map-web/cordis.patch.yml`，单次启动用 `--patch`；层序见上游 [profile 加载顺序](../../docs/user/develop/basic/publish.md#the-loading-order)。
- 凭据在配置中只以环境变量名或凭据引用出现，值由启动环境、`<map-home>/.env` 或 `<map-home>/.credentials.yaml` 提供；规则见 [工程骨架](engineering.md)。

## 路径登记表

本表是机器门禁的输入。`home` 行必须与 profile 中的 `dshHomePath` 调用双向一致；`temp` 行必须与产品脚本和插件源码中进入系统临时目录的 `mkdtempSync` 双向一致。

| 类型 | 名称 | 所有者 | 用途 |
|---|---|---|---|
| home | `spatial-store/` | `map/spatial-catalog/` | 会话资源目录、产物与 scale 对象库 |
| home | `accessibility-store/` | `map/spatial-accessibility/` | 可达性运行库 |
| temp | `map-audit` | `map/bin/audit-public-tree.mjs` | 公开快照审计暂存 |
| temp | `map-public-tree` | `map/bin/audit-public-tree.mjs` | 公开文件树暂存 |
| temp | `map-public-snapshot` | `map/bin/public-snapshot.mjs` | 公开快照提交暂存 |
| temp | `map-public-verify` | `map/bin/public-snapshot.mjs` | 公开快照提交的离线安装与门禁校验副本 |
| temp | `map-release-stage` | `map/bin/publish-release.mjs` | 发布清单暂存 |
| temp | `map-release-assets` | `map/bin/publish-release.mjs` | 发布资产暂存 |
| temp | `map-runtime` | `map/bin/pack-runtime.mjs` | 运行时打包暂存 |
| temp | `map-web-release` | `map/bin/web-service-release.mjs` | Web 服务发布打包暂存 |
| temp | `map-web-service-smoke` | `map/bin/smoke-web-service.mjs` | Web 服务冒烟启动暂存 |
| temp | `map-application-browser` | `map/bin/application-browser-check.mjs` | 应用浏览器检查 |
| temp | `map-application-check` | `map/bin/application-bootstrap.mjs` | 原生应用自检 |
| temp | `map-instance-diagnostic` | `map/bin/instance-preload.mjs` | 只读诊断的私有配置副本 |
| temp | `map-windows-transaction` | `map/bin/windows-transaction.mjs` | Windows 外部事务 worker 暂存 |
| temp | `map-native-download` | `map/bin/native-prebuilds.mjs` | 原生预构建下载 |
| temp | `map-native-probe` | `map/bin/native-prebuilds.mjs` | 原生预构建探测 |
| temp | `map-application-sea` | `map/bin/application-sea.mjs` | SEA 打包暂存 |
| temp | `map-perf-bench` | `map/spatial-perf/bin/perf-bench.mjs` | 性能诊断暂存 |

| 外部路径 | 访问规则 |
|---|---|
| `<工作区>/` | 插件只读，且必须经 `readBoundedWorkspaceFile` |
| `<仓库>/.dsh-build/` | 构建输出；由 `map/bin/build-application.mjs` 锚定仓库根 |
| `$TMPDIR/` | 只允许上表 `map-` 前缀的一次性目录 |

## 现存偏差

- `.agent-presets/map-analyst/` 仍由两个启动器首启复制；preset 实际由 bundle 声明行提供，遗留副本待发布窗口与原生产物启动器同步清理。
- scale 分块继续使用既有 `.ndjson` 扩展；导出产物继续沿用目录库既有 `.geojson` 存储。两者承载用户数据；格式保持现状，不做迁移。
- 测试夹具中的历史临时名不进入产品运行时；新增测试优先使用 `trackedTmpDir`，产品路径新增时必须先改本表。
