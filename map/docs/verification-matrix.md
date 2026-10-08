# 能力→验证矩阵与门禁归属

本文是 map 层跨包验证的权威矩阵：每个领域/工程包的测试层映射、owner、focused 命令与 out-of-scope 记录，以及 snapshot/GUI/expected/benchmark/CI 门禁的归属和刷新规则。逐套件命令与发布流程见 [engineering.md](engineering.md)；本文回答的问题是「哪类行为变更必须由哪层证据击穿回归，当前哪层还没有证据、为什么」。

范围依据：`.spec/specs/2026-09-24_add-spatial-verification-gates/spec.md`（验证门禁包）与 `.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md`（P0a→P3 阶段所有者）。分层词汇沿用仓库 [docs/testing.md](../../docs/testing.md)。

## 机器门禁

`node --test map/tests/verification-matrix.spec.mjs`（已并入 `node map/bin/test.mjs`）执行以下校验，防止矩阵与树漂移：

1. 下文每个 owner 段落（`### \`<dir>/\`` 开头）必须存在，且段落内 `unit`/`integration`/`Loader`/`snapshot`/`numeric`/`perf`/`ops` 七条分层 bullet 齐全；写 `none` 的层必须给出 `none — <原因>`。
2. 文中每个反引号引用的 `map/...` 路径必须真实存在。
3. `map/**/tests/` 下每个 `*.spec.mjs`/`*.e2e.mjs` 套件文件必须至少被一个段落或回放清单引用（无未登记套件）。
4. `map/bin/test.mjs` 聚合的每个 suite 标签必须出现在本文聚合小节（runner 与文档互相钉住）。
5. 文中每条 `pnpm --filter <pkg> run <script>` / `pnpm run <script>` / `node <path>` 命令必须能解析到真实的 package.json script 或文件。

## Owner 矩阵

### `map-container/`（node 半：projection/protocol/`ctx.map` 服务）

- unit: `map/map-container/tests/projection.spec.mjs` 提交协议 decode/validate/settle、plain-JSON 状态、负向准入
- integration: `map/map-container/tests/map-rig.mjs` + `plugin.spec.mjs` 真实 Session/ProjectionRegistry/plugin 挂载；`view-request.spec.mjs`、`view-policy.spec.mjs`、`default-open.spec.mjs` 视图语义
- Loader: `map/tests/built-replay.spec.mjs` 子进程挂载 built 插件重放同一日志；`map/tests/loader-smoke.spec.mjs` 组合行
- snapshot: `snapshots/session/map-analyst-turn`（keyed 已建立，2026-09-26）：map_add_layer 的真实调用/结果与容器折叠进入录制会话；工具 schema 面经 pin 头进入 `tool-schemas.expected.json`；keyless 双模式回放绿（见「门禁归属」）
- numeric: `map/tools/tests/numeric-answers.spec.mjs` 中投影 CRS 往返与解析面积答案覆盖容器承载的 WGS84 交换格式
- perf: none — 无性能敏感路径的既定预算；归属见 out-of-scope 表
- ops: `map/map-container/tests/plugin.spec.mjs` dispose/重挂载折叠语义（HMR）

- owner: map-container 包（P0a 状态与协议基础）
- command: `pnpm --filter @map-harness/map-container run test`
- suites: `map/map-container/tests/projection.spec.mjs`, `map/map-container/tests/plugin.spec.mjs`, `map/map-container/tests/occurrence.spec.mjs`, `map/map-container/tests/view-policy.spec.mjs`, `map/map-container/tests/view-request.spec.mjs`, `map/map-container/tests/default-open.spec.mjs`
- out-of-scope: 持久化 renderedRevision 回执已于 2026-10-07 交付（occurrence 级 applied/rendered/failed，见 `map-container/` browser 半 owner 行与 [map-container-binding.md](map-container-binding.md)「渲染回执」）；浏览器真实渲染画面由 composition lane 的像素用例覆盖

### `map-container/`（browser 半：occurrence/渲染身份/view tabs/手势写通道）

- unit: `map/map-container/tests/occurrence.spec.mjs` 数据/样式版本渲染身份、删除清缓存、Multi* 拒绝、渲染回执（applied→rendered 与视图身份、迟到完成拒绝）（真实 occurrence + ArcGIS 构造替身 `arcgis-doubles.mjs`）
- unit: `map/map-container/tests/gesture.spec.mjs` 手势写通道——版本化观察文本 round-trip、外来文本静默 miss、未知版本/坏载荷拒绝、超字节序列化拒绝、提交策略（stable 仅运行中 steer、explicit 恒 queue）、观察器状态机（交互窗口/ settle 合并/程序化静音/限频 latest-wins/dispose 取消）、occurrence 接线（真实视图替身：手势到达 sink、程序化同步零观察、显式提交与 no-view）
- integration: 同上；`view-request.spec.mjs` tab 请求协议；`map/arcgis-mcp/tests/composition.e2e.mjs` `gesture write channel` 用例（真实 Web：用户拖拽在运行轮次内 steer 入队且观察文本进入模型会话、显式提交 queue 入队、程序化 set_view 零草稿）
- Loader: `map/tests/built-smoke.spec.mjs` `lib/client.js` closure-factory banner（Web module loader 真实消费形态）
- snapshot: none — 无 Web 快照 lane 归属 map 层；渲染可见变化由 composition e2e 承担（2026-10-07 起含像素级断言：`rendered pixels` 用例断言 2D 绘制（≥5000 px）、切换 3D 场景后保持（≥5000 px）与移除后清空（≤500 px），基准为图例最暗类色；录制 GIF 仍属发布前需要 key 与真实 GUI 改动的独立动作）
- numeric: none — 浏览器半不承载解析数值；投影换算由 ArcGIS 引擎承担，归属 D09 数值语义 owner 审计；手势观察仅携带相机摘要（display WKID 自描述），不做坐标换算声明
- perf: none — 帧预算未建立；见 out-of-scope 表
- ops: `map/map-container/tests/occurrence.spec.mjs` 迟到加载/双 occurrence；手势通道拒绝语义（超字节不发、无运行轮次不入队）见 gesture.spec

- owner: map-container 包（browser 半）
- command: `pnpm --filter @map-harness/arcgis-mcp run test:composition`
- suites: `map/map-container/tests/occurrence.spec.mjs`, `map/map-container/tests/gesture.spec.mjs`, `map/map-container/tests/view-request.spec.mjs`, `map/map-container/tests/arcgis-doubles.mjs`
- out-of-scope: 两条后续项均已交付（2026-10-07）——渲染回执 API（设计 §10.4/§11.2 的 occurrence 级 applied/rendered/failed，含 revision/viewId/失败图层与迟到完成拒绝，经客户端 store 持久化）与像素级画面验证（`pnpm --filter @map-harness/arcgis-mcp run test:composition` 的 `rendered pixels` 用例断言分类图层在 2D 画布上色、切换 3D 场景后保持、移除后清空，并以图例（同一样式版本）的最暗类色为基准）；浏览器手势写通道已交付（设计 §11.1/§11.2：手势作为用户输入经 session prompt 命令入会话队列，运行中限频 steer、显式提交 queue，空闲保持本地草稿，程序化相机变更零观察；随消息附带需接管上游 composer，记为后续项）；`failIfMajorPerformanceCaveat` 的严格 WebGL2 与运行前置见 [engineering.md](engineering.md)「平台限制」

### `tools/`（map_* 容器工具 + 内部 MCP adapter）

- unit: `map/tools/tests/map-tools.spec.mjs` 工具定义/工作区绑定/错误面；`map/tools/tests/catalog-chain.spec.mjs` P0b 链路（真实 catalog 服务）
- integration: `map/arcgis-mcp/tests/arcgis-mcp.spec.mjs` catalog↔handler、execution token 绑定；`map/tools/tests/run-tools.spec.mjs` P1 run_submit/get/cancel 链路（真实 catalog+accessibility 服务；`properties.id` 绑定、跨资源位置回退、显式 id 冲突拒绝、`run_get` 具名计算诊断）
- Loader: `map/tests/loader-smoke.spec.mjs` native 工具面组合；`map/tests/built-smoke.spec.mjs` `tools/lib/mcp.js` 入口
- snapshot: `snapshots/session/map-analyst-turn`（keyed 已建立）：map_* 工具 schema 全量进入录制 pin 头，map_add_layer 真实调用链录制并 keyless 回放（见「门禁归属」）
- numeric: none — map_* 为状态变更语义，无数值答案；几何数值归 geo_* 行
- perf: none — 无性能敏感路径；见 out-of-scope 表
- ops: `map/arcgis-mcp/tests/lifecycle.spec.mjs` 取消 barrier/dispose quiescence/嵌套 guard

- owner: map-tools 包
- command: `pnpm --filter @map-harness/map-tools run test`
- suites: `map/tools/tests/map-tools.spec.mjs`, `map/tools/tests/mcp-tools.spec.mjs`, `map/tools/tests/catalog-chain.spec.mjs`, `map/tools/tests/geo.spec.mjs`, `map/tools/tests/numeric-answers.spec.mjs`, `map/tools/tests/run-tools.spec.mjs`, `map/tools/tests/stat-tools.spec.mjs`, `map/tools/tests/viz-tools.spec.mjs`
- out-of-scope: 向量检索、外部知识图谱和独立语义服务（本轮只交付关系表、关键词/别名检索与现有 `catalog_resolve` 接线）

### `tools/`（geo_* 空间分析与数值）

- unit: `map/tools/tests/geo.spec.mjs` 工具行为/资源限流/错误码；`map/tools/tests/numeric-answers.spec.mjs` 解析答案与独立实现对照
- integration: `map/arcgis-mcp/tests/arcgis-mcp.spec.mjs` 经 MCP dispatch 的 geo 调用
- Loader: `map/tests/built-replay.spec.mjs` + composition e2e（真实 app 全链）
- snapshot: `snapshots/session/map-analyst-turn`（keyed 已建立）：geo_buffer 版本化 ref 分支的真实成功 content（area/bbox/limitations/artifact 元数据）录制在案并 keyless 回放；其余 geo 工具 schema 在 pin 头
- numeric: `map/tools/tests/numeric-answers.spec.mjs` 解析面积/洞/共边/经线弧长/Steiner 缓冲/CRS 往返，容差预写
- perf: none — Turf 计算在资源限流内同步完成；无独立预算
- ops: `map/arcgis-mcp/tests/lifecycle.spec.mjs` geo 在途取消/dispose

- owner: map-tools 包（D09 数值语义的现行实现面）
- command: `pnpm --filter @map-harness/map-tools run test`
- suites: `map/tools/tests/geo.spec.mjs`, `map/tools/tests/numeric-answers.spec.mjs`
- out-of-scope: Point/LineString 求面积改为拒绝、边界接触拓扑判定（D09 审计项）——模型可见语义变更，归 P0b 数值语义 owner 并需快照级证据；本包以「published limitations 披露守卫」钉住现状

### `arcgis-mcp/`（进程内 MCP server/provider）

- unit: `map/arcgis-mcp/tests/arcgis-mcp.spec.mjs` catalog 注册/未知重复缺失拒绝/transport
- integration: 同上 execution token 绑定真实 `ToolExecution` 会话；`lifecycle.spec.mjs` 真实插件挂载
- Loader: `map/tests/loader-smoke.spec.mjs` `arcgis-mcp` 行组合；`map/tests/built-smoke.spec.mjs` built 入口
- snapshot: `snapshots/session/map-analyst-turn`（keyed 已建立）：内部 ArcGIS MCP dispatch 承载的 map_*/geo_* 调用随录制会话走真实 tools/call→tools/list 链路并 keyless 回放
- numeric: none — 纯协议/transport 层
- perf: none — 进程内 transport 无既定预算
- ops: `map/arcgis-mcp/tests/lifecycle.spec.mjs` dispose quiescence/重挂载/幂等

- owner: arcgis-mcp 包
- command: `pnpm --filter @map-harness/arcgis-mcp run test`
- suites: `map/arcgis-mcp/tests/arcgis-mcp.spec.mjs`, `map/arcgis-mcp/tests/lifecycle.spec.mjs`
- out-of-scope: 已部署远程端点运维（跨进程/远程 transport 接入能力由 mcp-transport 承载）

### `client-ui-brand/`（侧栏品牌行）

- unit: none — 无独立 src 逻辑（browser-only stub + row 覆盖）
- integration: `map/arcgis-mcp/tests/composition.e2e.mjs` 品牌行渲染
- Loader: `map/tests/built-smoke.spec.mjs` built 入口契约（host stub 的空 apply 保持 row 存活）
- snapshot: none — UI 文案变化归 locale 字典与 composition 证据
- numeric: none — 品牌行不承载几何或统计数值
- perf: none — 静态文案行，无运行时预算
- ops: none — 无生命周期路径；卸载随 fiber

- owner: client-ui-brand 包
- command: `pnpm --filter @map-harness/arcgis-mcp run test:composition`
- suites: `map/tests/built-smoke.spec.mjs`, `map/arcgis-mcp/tests/composition.e2e.mjs`
- out-of-scope: 品牌视觉像素级验证

### `profiles/`（map-web bundle 组合面）

- unit: none — 声明式 patch，无运行时逻辑
- integration: `map/tests/topology.spec.mjs` patch 行 ⊆ wrapper 链接集交叉校验
- Loader: `map/tests/loader-smoke.spec.mjs` 真实 Launcher `--dump-config`：map host insert 行集与 map-analyst 声明、四 disabled 行（官方品牌、终端/浏览器侧栏、preset-ptc）、`mode: native`、profile 链接与 preset 安装
- snapshot: none — 组合面变化由 Loader smoke 的确定性断言承担
- numeric: none — patch 组合不承载数值
- perf: none — 声明式组合无运行时预算
- ops: `map/tests/loader-smoke.spec.mjs` 缺 built 产物 fast-fail、`DSH_TOOLS_MODE` 逃逸拒绝

- owner: map-web bundle（profiles/map-web）
- command: `node map/bin/test.mjs`
- suites: `map/tests/loader-smoke.spec.mjs`, `map/tests/topology.spec.mjs`
- out-of-scope: 用户根 `cordis.patch.yml` 叠加组合（用户环境差异，Loader 语义归上游）

### `presets/`（map-analyst agent preset）

- unit: none — 声明式组合
- integration: `map/tests/topology.spec.mjs` preset 行解析到 workspace 包 exports 子路径
- Loader: `map/tests/loader-smoke.spec.mjs` 安装断言（`~/.agent-presets/map-analyst`）与非 map-analyst roster 组合断言（standard/minimal/cordis 启用在位、preset-ptc 因 per-scope ptc 呈现逃逸禁用、registry 默认钉定 map-analyst）；`map/arcgis-mcp/tests/lifecycle.spec.mjs` provider 缺失 activation 报错
- snapshot: none — 同上（组合断言由 Loader smoke 承担）
- numeric: none — preset 组合不承载数值
- perf: none — 声明式组合无运行时预算
- ops: `map/arcgis-mcp/tests/lifecycle.spec.mjs` 挂载/卸载/重挂载

- owner: presets/map-analyst（用户根组合）
- command: `node map/bin/test.mjs`
- suites: `map/tests/loader-smoke.spec.mjs`, `map/arcgis-mcp/tests/lifecycle.spec.mjs`
- out-of-scope: 非 map-analyst preset 的会话级行为面（上游所有；roster 组合面已由 Loader lane 验证）

### `bin/`（wrapper 与构建/测试聚合）

- unit: none — wrapper 无独立单测面
- integration: `map/tests/topology.spec.mjs` wrapper 链接集 = 构建集聚合 ∪ map-web
- Loader: `map/tests/loader-smoke.spec.mjs` 真实 wrapper 启动/ relocated fast-fail
- snapshot: none — 无模型可见面
- numeric: none — 包装器不承载数值
- perf: none — 构建时长无预算门禁
- ops: `map/tests/built-smoke.spec.mjs` built 产物/JSDoc 门禁；`map/tests/built-replay.spec.mjs` 子进程重放

- owner: bin 包装器与聚合脚本
- command: `node map/bin/test.mjs --build`
- suites: `map/tests/built-smoke.spec.mjs`, `map/tests/built-replay.spec.mjs`, `map/tests/loader-smoke.spec.mjs`, `map/tests/topology.spec.mjs`
- out-of-scope: win32 `shell: true` 路径的行为矩阵（上游 CI platform matrix 拥有）

### `tests/`（map 级工程门禁）

- unit: 自身即检查——`map/tests/topology.spec.mjs`、`map/tests/build-exports.spec.mjs` 纯源平面扫描
- integration: `map/tests/reliability.spec.mjs` 资源可靠性约定门禁；`map/tests/verification-matrix.spec.mjs` 本矩阵一致性；`map/tests/glm-deepseek-parity.spec.mjs` GLM 网关与官方 DeepSeek 双语料只读结构对比（等价性论证的结构级证据，见「GLM 网关与官方 DeepSeek 的等价性论证」节）
- Loader: `map/tests/loader-smoke.spec.mjs`、`map/tests/built-replay.spec.mjs`
- snapshot: none — 门禁不录制；结构级 keyless 证据由 map parity lane 维护（`node --test map/tests/glm-deepseek-parity.spec.mjs`）
- numeric: none — 数值归 tools 行；结构对比的合规率/一致性计数是结构断言不是几何数值
- perf: none — 无性能预算；归属见 out-of-scope 表
- ops: 全部门禁以退出码结算，不自报通过

- owner: map/tests（本包与后续包共用的门禁层）
- command: `node map/bin/test.mjs`
- suites: `map/tests/topology.spec.mjs`, `map/tests/build-exports.spec.mjs`, `map/tests/reliability.spec.mjs`, `map/tests/verification-matrix.spec.mjs`, `map/tests/glm-deepseek-parity.spec.mjs`, `map/tests/built-replay.spec.mjs`, `map/tests/built-smoke.spec.mjs`, `map/tests/loader-smoke.spec.mjs`
- out-of-scope: 上游聚合门禁（lint strict override、doc-sync、hygiene、coverage）扫描 `packages/`/`apps/`/`docs/`，不含 `map/`；map 层以本目录门禁 + per-package `tsc -b` 等价覆盖

### `spatial-storage/`（存储迁移/备份/引用保护/清理）

- unit: `map/spatial-storage/tests/gc.spec.mjs` 已发布版本 GC——reader pin（幂等/拒绝/保护边呈现）、release 终结（幂等/未知目标/非字节 kind 拒绝）、回收（字节+行+标记原子清退、读取显式 missing）、执行期 pin 复核跳过、未释放零引用不回收、会话引用边保护、并发 lease-held、备份恢复搬迁后标记与相对路径可解析；`map/spatial-storage/tests/migrate.spec.mjs` 迁移阶梯（forward/幂等/失败回滚/dry-run 只读/未来版本拒绝/checksum）；`map/spatial-storage/tests/recovery.spec.mjs` 缺文件/digest 不符/权限变化/未来版本/无父 fork 的分层报告；`map/spatial-storage/tests/sessions.spec.mjs` 会话库布局（路径方案/`invalid-session-id` 拒绝/逐库迁移与 backup-before-write/清单从 sessions/ 派生并跳过外来项/显式 drop 单库删除且不跟随符号链接/根级旧共享库不读不删）
- integration: `map/spatial-storage/tests/backup.spec.mjs` bundle staging→verify→publish 与分层恢复（不覆盖、冲突保留、恢复到新位置后引用可解析、旧 Session 字节不变）；`map/spatial-storage/tests/lifecycle.spec.mjs` 引用图保护/清理 TOCTOU/活动写入保护；`map/spatial-storage/tests/session-lifecycle.spec.mjs` 每会话生命周期（首用建库/逐库 SIGKILL 崩溃回滚且邻居不动/恢复扫描按库/staging 与孤儿清理仅在本库/默认全保留 + 显式 drop）
- Loader: none — 纯库无 plugin 行；计划的 catalog/artifact provider 交付时随其 patch 行评估
- snapshot: none — 无模型可见/协议可见输出；报告均为程序化 API 返回值
- numeric: none — sha256/字节计数为确定性 fixture，不承载几何数值语义
- perf: none — 本地单写者 P0 无既定预算；见 out-of-scope 表
- ops: `map/spatial-storage/tests/migrate.spec.mjs` SIGKILL 崩溃 fixture（子进程步骤中途死亡→该步整体回滚→重跑续升）；`map/spatial-storage/tests/lifecycle.spec.mjs` 并发清理 lease 互斥

- owner: @map-harness/spatial-storage 包
- command: `pnpm --filter @map-harness/spatial-storage run test`
- suites: `map/spatial-storage/tests/gc.spec.mjs`, `map/spatial-storage/tests/migrate.spec.mjs`, `map/spatial-storage/tests/backup.spec.mjs`, `map/spatial-storage/tests/lifecycle.spec.mjs`, `map/spatial-storage/tests/recovery.spec.mjs`, `map/spatial-storage/tests/sessions.spec.mjs`, `map/spatial-storage/tests/session-lifecycle.spec.mjs`
- out-of-scope: 已发布版本 GC 已交付（2026-10-07，schema v5：reader_pins/released_versions + 既有 cleanup lease/plan/execute 协议；显式 release 终结制，无 TTL，语义定义与方法版本维持不自动删除，删除前提见 storage-lifecycle.md）；跨网络/对象存储备份与密钥轮换（部署包扩展，spec §3.2）

### `spatial-catalog/`（版本化目录/不可变导入/产物发布/store 服务）

- unit: `map/spatial-catalog/tests/catalog.spec.mjs` 事务发布阶梯（staging→校验→摘要→原子 version+featureRefs+intent）、(logical,version) 唯一约束、失败回滚、预算拒绝、digest 篡改拒绝、授权过滤（未授权不泄露存在性、撤权显式不可用）、featureRef 确定性；`map/spatial-catalog/tests/semantic.spec.mjs` 定义版本递增、别名/适用域检索、授权过滤、检索上限与未知绑定拒绝；`map/spatial-catalog/tests/governance.spec.mjs` 治理契约（主体/敏感度格/最小权限派生）、ACL 判定矩阵、grant 版本单调、撤权/tombstone/恢复、审计 trail、缓存域隔离与撤权竞态、语义绑定治理、session 对象 fork 继承；`map/spatial-catalog/tests/governance-tenant-recall.spec.mjs` 租户与召回面：租户隔离判定不泄露存在性、租户键控 grant 版本互不影响、单租户默认与既有行为一致、开库拒绝他租户行、配置 fail loud、副本登记幂等有界、`recallCopies` 按对象/租户范围记录并逐副本审计、被召回副本具名拒绝且文案含边界句、未登记副本不可达、fork 副本登记与召回拒 fork、跨租户与召回两类负样本独立可辨；`map/spatial-catalog/tests/session-isolation.spec.mjs` 会话库隔离（跨会话 ref `CATALOG_NOT_FOUND` 不泄露存在性、多会话并发开库互不干扰、视图拒绝他 session 身份与非法 session id、审计/发布配对逐库、fork 不放宽资源可见性）
- integration: `map/tools/tests/catalog-chain.spec.mjs` 真实 catalog 服务 + projection 配对：register→resolve→ref 选择第二点→artifact 发布→版本化图层→retryOf 只取回已发布对象；path/ref 互斥、selector 错误、源覆写不改变旧版本；`map/tools/tests/governance-entries.spec.mjs` 撤权后 resolve/显示/执行/导出/retry 全入口拒绝与发布域 clamp、审计归属；召回后同矩阵全入口 `GOVERNANCE_RECALLED` 具名拒绝、map_save 回执召回边界句与 copy-limit 独立可辨、display/export 副本登记可查
- Loader: `map/tests/loader-smoke.spec.mjs` `spatial-catalog` insert 行与链接集；`map/tests/topology.spec.mjs` 依赖方向（tools→spatial-catalog→spatial-storage）
- snapshot: `snapshots/session/map-analyst-turn`（keyed 已建立）：catalog_register（资源名→确定性 res ref）与 catalog_resolve（feature refs）的真实 content 录制在案并 keyless 回放（readPoint/readAt 与 art-* ref 由快照 identity 归一化为 token）；geo_buffer 发布的 artifact 元数据同场景覆盖
- numeric: `map/spatial-catalog/tests/catalog.spec.mjs` sha256 摘要/字节计数/extent 确定性 fixture；`map/tools/tests/numeric-answers.spec.mjs` 承载几何数值语义
- perf: none — 本地单写者 P0 无既定预算；`maxStoreBytes` 为部署 Config，磁盘满以 `CATALOG_STORE_FULL` 拒绝（见 out-of-scope 表）
- ops: `map/tools/tests/catalog-chain.spec.mjs` map_save 文件/目录/Session flush 各自故障独立报告（accepted 状态保留）；`map/spatial-storage/tests/migrate.spec.mjs` SIGKILL 崩溃回滚对 P0b schema 阶梯成立

- owner: `@map-harness/spatial-catalog` 包
- command: `pnpm --filter @map-harness/spatial-catalog run test`
- suites: `map/spatial-catalog/tests/catalog.spec.mjs`, `map/spatial-catalog/tests/semantic.spec.mjs`, `map/spatial-catalog/tests/governance.spec.mjs`, `map/spatial-catalog/tests/governance-tenant-recall.spec.mjs`, `map/spatial-catalog/tests/session-isolation.spec.mjs`, `map/tools/tests/catalog-chain.spec.mjs`, `map/tools/tests/governance-entries.spec.mjs`
- out-of-scope: 跨存储 DB namespace（PostGIS）；已发布版本的自动 GC；多租户 ACL（P0b 单部署域 + local/sensitive 敏感度格，bundle 记录 authorizationVersion）；历史副本远程召回（治理文档明示不可召回）

### `spatial-context/`（P0c owner：DecisionFrame/上下文注入/方法卡/预算）

- unit: `map/spatial-context/tests/frame.spec.mjs` 来源权限（仅真实 user/message 可改目标）、plan 冲突检查、有界记录；`map/spatial-context/tests/budget.spec.mjs` 预算 preflight/不可重置/补救上限
- integration: `map/spatial-context/tests/projection.spec.mjs` 真实 Session 折叠（goal/plan/证据/资源/注入/预算）+ 与 map-tools producer codec 的 parity；`map/spatial-context/tests/snapshot.spec.mjs` 基线/增量组成、digest 去重、方法卡选择、停止建议
- Loader: `map/tests/loader-smoke.spec.mjs` `spatial-context` insert 行 + `spatial-context/agent` preset 行；`map/tests/built-smoke.spec.mjs` built `index.js`/`agent.js` 入口契约；`map/tests/topology.spec.mjs` 依赖方向（tools→spatial-context→map-container）
- snapshot: `map/spatial-context/tests/loop.spec.mjs` keyless 真实 loop 模型请求快照（mock adapter 断言实际请求内嵌的基线/增量文本）；`snapshots/session/map-analyst-turn`（keyed 已建立）：预注入器（`spatial-context/agent`）在录制组合内，基线+增量注入文本随录制会话 keyless 逐字节回放——墙钟 elapsed 预算行、随体 digest 与被其字宽牵动的 context 计数由快照 identity 层归一化为 `{{elapsed}}`/`{{digest:n}}`/`{{contextBytes}}` 占位，其余预算计数保持回归可见（见「门禁归属」）
- numeric: none — 上下文注入不承载几何数值
- perf: none — 成本记录而非硬门禁（设计 §5.5）；预算为硬计数/字节/时间限制
- ops: `map/spatial-context/tests/loop.spec.mjs` 取消/空首步/reject 不自启不预提交、compaction 后同 goal 重建基线、fork 重放预算（审计 D05/D06 验收）

- owner: `@map-harness/spatial-context` 包（P0c）
- command: `pnpm --filter @map-harness/spatial-context run test`
- suites: `map/spatial-context/tests/frame.spec.mjs`, `map/spatial-context/tests/budget.spec.mjs`, `map/spatial-context/tests/projection.spec.mjs`, `map/spatial-context/tests/snapshot.spec.mjs`, `map/spatial-context/tests/loop.spec.mjs`
- out-of-scope: 自然语言授权判定器（设计 §3.3 明确 P0 不建）；真实供应商费用计费（预算只作估算记录）


### `spatial-accessibility/`（P1 owner：可达性契约/provider/run 存储/覆盖/候选比较/高德、天地图、Mapbox、百度、腾讯 adapter）

- unit: `map/spatial-accessibility/tests/contract.spec.mjs` 外延嵌套/时间窗/阻抗/容量/入口/候选边界校验与直线探索标记；`map/spatial-accessibility/tests/runs.spec.mjs` run 生命周期（durable 先于 worker、去重/冲突、取消/完成竞争、孤儿裁决、quiescence）；`map/spatial-accessibility/tests/provider-config.spec.mjs` 网络源 Config/凭据面（六项已配置源、五家 credential-ref env 名默认、可选 `baseUrl` 透传与非法根拒绝、未知 id 与缺凭据响亮失败、凭据不进配置序列化/错误文本/networkRef）
- integration: `map/spatial-accessibility/tests/network.spec.mjs` 受控 provider（route/serviceArea 定价、barrier、分页、故障码、expansion 内 abort）；`map/spatial-accessibility/tests/amap.spec.mjs`、`tianditu.spec.mjs`、`mapbox.spec.mjs`、`baidu.spec.mjs`、`tencent.spec.mjs` 五家 adapter fixture 契约（各自 wire 解析、错误映射、收缩面、取消与凭据卫生）；`map/spatial-accessibility/tests/metrics.spec.mjs` + `compare.spec.mjs` 覆盖与比较（解析格网、守恒、容量、partial/empty、权重敏感性、固定 revision 导出）；`map/spatial-accessibility/tests/vendor-contract.spec.mjs` 五家厂商契约门禁 key-activated lane（跨界/分页缺失/取消/无效 key 四类 + 真实定价面；无对应 env 各自跳过 exit 0，同断言集受控双跑恒绿）；`map/tools/tests/run-tools.spec.mjs` 真实 catalog+run 服务+projection 的 submit/get/cancel/retryOf 链路，外加 `properties.id` 绑定、跨资源位置回退、显式 id 冲突拒绝与 `run_get` 具名计算诊断
- Loader: `map/tests/loader-smoke.spec.mjs` `spatial-accessibility` insert 行、链接集与 store 根 `dshHomePath('accessibility-store')`；`map/tests/built-smoke.spec.mjs` built `index.js` 入口契约
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 run_submit/run_get/run_cancel schema（模型可见面）；run 行为 content 未录制，由 focused spec 继续（见「门禁归属」通道边界）。2026-09-27 身份解析与计算诊断透出不重录：工具参数 schema 未变，既有 pin 头仍覆盖；具名诊断与 `properties.id` 绑定由 `map/tools/tests/run-tools.spec.mjs` 以第三轮实参复刻守住
- numeric: `map/spatial-accessibility/tests/metrics.spec.mjs` 解析格网手算答案（180/380 覆盖、容量 100/150 溢出、守恒恒等式）
- perf: none — 有界格网计算无既定预算；spec 预算字段（estimate）为确定性上界而非门禁；高德采样服务区的厂商调用数受格网节点上限约束（`AMAP_MAX_LATTICE_NODES`），非本层性能门禁
- ops: `map/spatial-accessibility/tests/runs.spec.mjs` worker 静止 dispose、死 epoch 孤儿裁决、restore 场景 sweepOrphans；`map/spatial-accessibility/tests/network.spec.mjs` provider abort checkpoint；五家 adapter suite 覆盖传输内 abort 与调用间取消检查点

- owner: `@map-harness/spatial-accessibility` 包（P1）
- command: `pnpm --filter @map-harness/spatial-accessibility run test`
- suites: `map/spatial-accessibility/tests/contract.spec.mjs`, `map/spatial-accessibility/tests/network.spec.mjs`, `map/spatial-accessibility/tests/provider-config.spec.mjs`, `map/spatial-accessibility/tests/amap.spec.mjs`, `map/spatial-accessibility/tests/tianditu.spec.mjs`, `map/spatial-accessibility/tests/mapbox.spec.mjs`, `map/spatial-accessibility/tests/baidu.spec.mjs`, `map/spatial-accessibility/tests/tencent.spec.mjs`, `map/spatial-accessibility/tests/vendor-contract.spec.mjs`, `map/spatial-accessibility/tests/runs.spec.mjs`, `map/spatial-accessibility/tests/metrics.spec.mjs`, `map/spatial-accessibility/tests/compare.spec.mjs`
- out-of-scope: 五家真实 API 复验为 key-activated lane（adapter 与 keyless 契约门禁已交付；用户填凭据后运行 `map/spatial-accessibility/tests/vendor-contract.spec.mjs`，对应 env 为 `AMAP_API_KEY`、`TIANDITU_API_KEY`、`MAPBOX_ACCESS_TOKEN`、`BAIDU_API_KEY`、`TENCENT_MAP_KEY`）；组合选址全局优化（P3）；本包 content 行为流录制（keyed 通道已建立，schema 面在 `snapshots/session/map-analyst-turn`，见「门禁归属」）

### `spatial-statistics/`（P2 owner：统计契约/置换检验/时空模式/证据谱系）

- unit: `map/spatial-statistics/tests/contract.spec.mjs` spec 校验（一次返回全部 issue、时间前推/嵌套/词表拒绝）与摘要确定性；`map/spatial-statistics/tests/stats.spec.mjs` Moran/LISA/Gi\* 对照独立稠密实现、9! 全枚举核对置换机制、Cliff–Ord 大样本收敛、种子逐位复现、not_applicable 拒绝（常数场/单元不足/零邻居/孤岛）
- integration: `map/spatial-statistics/tests/patterns.spec.mjs` change/cluster/flow 解析答案（缺窗 unknown、迟到排除、稀疏拒绝、DBSCAN 精确分配、断链不插补、留出漂移/Jaccard 手算）；`map/spatial-statistics/tests/evidence.spec.mjs` 谱系分组不重复计证据、多尺度阶梯逐档重算与符号分歧公开、图例域从冻结结果一次性导出
- Loader: `map/tests/loader-smoke.spec.mjs` wrapper 链接集含 `spatial-statistics`；`map/tests/built-smoke.spec.mjs` built `index.js` 入口契约与生成声明 JSDoc
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 stats_*/pattern_* schema（模型可见面）；统计 content 行为未录制，由 focused spec 继续（见「门禁归属」通道边界）
- numeric: `map/spatial-statistics/tests/stats.spec.mjs`（解析小样例 + 独立稠密实现 1e-12/1e-9 + 9! 全枚举 + 闭式离散度四路对照）；`map/tools/tests/stat-tools.spec.mjs` 端到端数值（分区均值、梯度 I、格网 delta、流计数）
- perf: none — 有界表（≤5000 单元）同步计算无既定预算；大矩阵走 artifact 引用不进 meta
- ops: `map/tools/tests/stat-tools.spec.mjs` 配对缺失/嵌套 dispatch/无效 spec 的拒绝路径、not_applicable 不发布 artifact、meta 经 codec 解码

- owner: `@map-harness/spatial-statistics` 包（P2）
- command: `pnpm --filter @map-harness/spatial-statistics run test`
- suites: `map/spatial-statistics/tests/contract.spec.mjs`, `map/spatial-statistics/tests/stats.spec.mjs`, `map/spatial-statistics/tests/patterns.spec.mjs`, `map/spatial-statistics/tests/evidence.spec.mjs`, `map/tools/tests/stat-tools.spec.mjs`
- out-of-scope: 外部成熟统计 provider 接入（设计 §13.1 后续阶段；工作区内无该依赖，根 lockfile 变更超出 map 层边界）；栅格 zonal 与服务器大数据分块（负载证据具备后引入）；本包 content 行为流录制（keyed 通道已建立，schema 面在 `snapshots/session/map-analyst-turn`，见「门禁归属」）

### `spatial-decision/`（P3 owner：归因/预测/方案优化契约与计算）

- unit: `map/spatial-decision/tests/contract.spec.mjs` 三 spec 族校验（一次返回全部 issue、方法版本快照、设计/特征前置互斥、键序无关摘要）；`map/spatial-decision/tests/linalg.spec.mjs` Student-t/正态分位数对照 R `qt()`/`qnorm()` 公开值（1e-9）、不完全 Beta 闭式与对称恒等、OLS 手算系统与奇异拒绝
- integration: `map/spatial-decision/tests/attribution.spec.mjs` association/explain 解析答案与诚实拒绝；`map/spatial-decision/tests/causal.spec.mjs` 平衡设计恢复真值达 causal、失衡/重叠/干扰/缺设计/无变异分别具名降级、DiD 手算 delta + Welch 区间；`map/spatial-decision/tests/forecast.spec.mjs` 时间前推留出胜过 naive 基线、threshold/quadratic-ridge 解析样例与序列化往返、concurrent 特征在 validate/predict 拒绝（泄漏失败响亮）、域外/漂移具名、独立第二实现逐指标复算；`map/spatial-decision/tests/optimize.spec.mjs` 手算目标、不可行候选具名、默认情景标记、权重扰动翻转、容量/预算/平局确定性、global 枚举域与上界拒绝
- Loader: `map/tests/loader-smoke.spec.mjs` wrapper 链接集含 `spatial-decision`；`map/tests/built-smoke.spec.mjs` built 入口契约
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 attribution_*/forecast_*/scenario_*/location_* schema（含 `model_family` 与 `mode` 扩展）；决策 content 行为未录制，由 focused spec 继续（见「门禁归属」通道边界）
- numeric: `map/spatial-decision/tests/*.spec.mjs`（公开分位数表 + 解析小样例 + 独立第二实现复算）；`map/tools/tests/decision-model-tools.spec.mjs` 端到端数值（平衡设计效应 5、DiD delta 8、趋势延续 74、quadratic-ridge 元数据、覆盖 30/40 与 global 枚举摘要）
- perf: none — 有界表（≤5000 行、≤16 候选、≤64 站点）同步计算无既定预算；全表走 artifact 引用不进 meta
- ops: `map/tools/tests/decision-model-tools.spec.mjs` 配对缺失/无效 spec/concurrent 特征的拒绝路径、not_applicable/unknown/partial 诚实状态、meta 经 codec 解码、`scenario_compare` 无资源输入不发布不配对

- owner: `@map-harness/spatial-decision` 包（P3）
- command: `pnpm --filter @map-harness/spatial-decision run test`
- suites: `map/spatial-decision/tests/contract.spec.mjs`, `map/spatial-decision/tests/linalg.spec.mjs`, `map/spatial-decision/tests/attribution.spec.mjs`, `map/spatial-decision/tests/causal.spec.mjs`, `map/spatial-decision/tests/forecast.spec.mjs`, `map/spatial-decision/tests/optimize.spec.mjs`, `map/tools/tests/decision-model-tools.spec.mjs`
- out-of-scope: 未观测混杂的机器排除（设计 §12.2：机器校验只报告条件）；连续/混合整数求解器、树集成/SVM/神经网络、核方法、大规模分布式训练与实时反馈评价（设计 §3.2 独立发布条件）；本包 content 行为流录制（keyed 通道已建立，schema 面在 `snapshots/session/map-analyst-turn`，见「门禁归属」）

### `spatial-viz/`（可视化工作台 owner：样式契约/分类/时间轴/联动导出）

- unit: `map/spatial-viz/tests/stream-aggregate.spec.mjs` 流式扫描（跨块逐特征相等/unicode 与嵌套数组/字节上限/截断/形状拒绝）与格网聚合（手算格号与求和/确定性/增量等于批量/上限与参数拒绝）；`map/spatial-viz/tests/contract.spec.mjs` 样式词表/量纲括号规则/断点单调/版本再生/时区与窗口校验、图例派生；`map/spatial-viz/tests/classify.spec.mjs` 秩中点 quantile/等距/诚实收缩/半开类/具名缺测越界/比值测量/尺寸分级/统一分类域
- integration: `map/spatial-viz/tests/timeline.spec.mjs` UTC 与 Asia/Shanghai 日历帧、缺测帧不插补、播放暂停步进状态机确定性；`map/spatial-viz/tests/linked.spec.mjs` 图例分箱复用、共享筛选摘要、选择语义、分页属性行、固定 revision 导出冻结
- Loader: `map/tests/loader-smoke.spec.mjs` wrapper 链接集含 `spatial-viz`；`map/tests/built-smoke.spec.mjs` built 入口契约
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 viz_* schema（模型可见面）；viz content 行为未录制，由 focused spec 继续（见「门禁归属」通道边界）
- numeric: `map/spatial-viz/tests/classify.spec.mjs` 解析断点（0..99 quantile-4 → 24.5/49.5/74.5；并集域等距断点 17.5/35/52.5）与比值 fixture；`map/tools/tests/viz-tools.spec.mjs` 端到端断点/类计数/比值域
- perf: none — 有界表（≤5000 行、≤2000 帧）同步计算无既定预算
- ops: `map/tools/tests/viz-tools.spec.mjs` 发布配对、未知图层/常量字段/无时间来源/manual 断点缺来源的拒绝路径；`map/map-container/tests/projection.spec.mjs` set-style 折叠与只读拒绝

- owner: `@map-harness/spatial-viz` 包（可视化工作台）
- command: `pnpm --filter @map-harness/spatial-viz run test`
- suites: `map/spatial-viz/tests/contract.spec.mjs`, `map/spatial-viz/tests/classify.spec.mjs`, `map/spatial-viz/tests/stream-aggregate.spec.mjs`, `map/spatial-viz/tests/timeline.spec.mjs`, `map/spatial-viz/tests/linked.spec.mjs`, `map/tools/tests/viz-tools.spec.mjs`
- out-of-scope: 3D 复杂样式与大数据可视化（设计 §3.2 按 provider 独立发布）；服务端分级/瓦片聚合；本包 content 行为流录制（keyed 通道已建立，schema 面在 `snapshots/session/map-analyst-turn`，见「门禁归属」）

### `spatial-collab/`（协同提交 owner：写者身份/串行提交/冲突差异/补偿撤销/写者生命周期）

- unit: `map/spatial-collab/tests/contract.spec.mjs` patch 词表 fixture（同层更新/删除/排序/重复 patch、边界与坐标拒绝、幂等 id 稳定）；`map/spatial-collab/tests/lifecycle.spec.mjs` 写者 join/断线/重连/授权/释放与 in-flight 静止、dispose 等待 open gate
- integration: `map/spatial-collab/tests/engine.spec.mjs` 串行提交引擎（expectedRevision CAS 一段完成、per-op 期望冲突、删除不自动重放、全有全无、重复 operation id 幂等重放、并发 barrier：后写者读旧基冲突后显式重读、undo verdict matched/already-undone/changed 与多步撤销链）；`map/tools/tests/collab-tools.spec.mjs` 真实 commit 协议端到端（handler 提案不落图、fold 一次折叠+审计账本+fold 侧 duplicate-op 守卫、写者显式身份/权限撤销/断线重连、多步撤销各自新 revision、冲突撤销不改图、恢复后审计与 undo 目标一致）
- Loader: `map/tests/loader-smoke.spec.mjs` `spatial-collab` insert 行与 profile 链接集；`map/tests/topology.spec.mjs` 依赖方向（map-tools→spatial-collab、spatial-collab 零 map 依赖）
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 map_apply_patch/map_undo schema（模型可见面）；冲突/幂等响应由 collab-tools.spec 结构断言承担；collab content 行为未录制（见「门禁归属」通道边界）
- numeric: `map/spatial-collab/tests/engine.spec.mjs` ledger 界界（200 条入界后 72..199 保留）；`map/tools/tests/collab-tools.spec.mjs` revision 计数逐次 +1（patch 原子一段）与 undo 链 revision 4/5/6
- perf: none — 有界 patch（≤8 ops）与有界账本（≤32 条）同步计算无既定预算
- ops: `map/spatial-collab/tests/lifecycle.spec.mjs` release 在 in-flight handler 持 gate 时不结算、dispose 等待全部 gate；`map/tools/tests/collab-tools.spec.mjs` 权限撤销/断线/重连后的提交拒绝路径

- owner: `@map-harness/spatial-collab` 包（协同提交与撤销）
- command: `pnpm --filter @map-harness/spatial-collab run test`
- suites: `map/spatial-collab/tests/contract.spec.mjs`, `map/spatial-collab/tests/engine.spec.mjs`, `map/spatial-collab/tests/lifecycle.spec.mjs`, `map/tools/tests/collab-tools.spec.mjs`
- out-of-scope: 分布式锁/CRDT/离线合并（spec §3.2 单独评估）；浏览器手势写通道（设计 §11.1 进入会话队列，本期模型/服务写者先行）；回滚外部产物（设计 §11.3 明确不承诺）

### `spatial-terrain/`（地形与视线 owner：垂直元数据/版本绑定/采样视线/有界地形预览）

- unit: `map/spatial-terrain/tests/contract.spec.mjs` 版本化 TerrainSpec 词表 fixture（垂直 datum/units/epoch/CRS 缺失逐项具名拒绝、障碍 ref 冲突、控制点词表、grid 洞/重复点拒绝、双线性插值、显示降采样）；`map/spatial-terrain/tests/los.spec.mjs` 解析视线 fixture（分段线性山脊穿越点、匀坡掠射线、曲率解析穿越与折射翻转、建筑/体素遮挡、误差预算内 indeterminate、越界/超采样拒绝）；`map/spatial-terrain/tests/viewshed.spec.mjs` 面域可视域（中央山体手算可见/受阻与阴影带、格网确定性、radius/targets 上限拒绝、off-surface outside 计数、观测点离面拒绝）
- integration: `map/tools/tests/terrain-tools.spec.mjs` 真实 catalog+投影端到端（terrain_add_layer 有界预览折叠与版本重绑、geo_line_of_sight 解析答案与 artifact 发布、terrain_viewshed 面域 artifact 与 tallies 及 radius/targets 拒绝、垂直元数据缺失拒绝先于读取、TERRAIN_VERSION_CONFLICT 显示-分析版本一致门、控制点门、取消与拒绝零发布）；`map/map-container/tests/terrain-display.spec.mjs` terrain 层折叠（当前 meta 版本门、surfaceRef 一致性、旧版本只读拒绝）与 occurrence 渲染身份（revision 进 token、z 高程、2D/3D 同记录、卸载清 token）
- Loader: `map/tests/loader-smoke.spec.mjs` profile 链接集（`spatial-terrain`）；`map/tests/topology.spec.mjs` 依赖方向（map-tools→spatial-terrain、spatial-terrain 零 map 依赖）
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 terrain_add_layer/geo_line_of_sight schema（模型可见面）；verdict/revision/vertical 元数据由 terrain-tools.spec 结构断言承担；terrain content 行为未录制（见「门禁归属」通道边界）
- numeric: `map/spatial-terrain/tests/los.spec.mjs` 全部解析对照（山脊穿越 333.3 m→首采样 350 m、曲率穿越解析点±60、掠射线 indeterminate 带=声明不确定度）；`map/tools/tests/terrain-tools.spec.mjs` 斜距/水平距解析值（hypot(1000,10)）与首障距离/样本序号
- perf: none — 有界网格（≤65536 点）与有界采样（≤maxSamples）同步计算无既定预算
- ops: `map/tools/tests/terrain-tools.spec.mjs` 取消在途调用不发布、拒绝调用不发布；`map/map-container/tests/terrain-display.spec.mjs` 卸载清图形与 revision token

- owner: `@map-harness/spatial-terrain` 包（地形/视线分析与显示身份）
- command: `pnpm --filter @map-harness/spatial-terrain run test`
- suites: `map/spatial-terrain/tests/contract.spec.mjs`, `map/spatial-terrain/tests/los.spec.mjs`, `map/spatial-terrain/tests/viewshed.spec.mjs`, `map/tools/tests/terrain-tools.spec.mjs`, `map/map-container/tests/terrain-display.spec.mjs`
- out-of-scope: viewshed 面域可视域已交付（2026-10-07：观测点确定性目标格网逐目标复用采样视线核，radius 20 km/targets 512 协议上限，全表 artifact 固定）；大栅格 viewshed/实时地形/多传感器融合（spec §3.2 由规模包与外部数据通道承接）；真实 3D 地形 draping 渲染画面（composition lane 断言 DOM/工具链，不断言渲染像素）

### `spatial-realtime/`（实时流 owner：三钟分离/去重/watermark 窗口/背压/checkpoint/物化）

- unit: `map/spatial-realtime/tests/contract.spec.mjs` spec 与场景词表 fixture（重复/乱序/迟到/断线线序 fixture、逐项越界具名拒绝、修订摘要钉定）；`map/spatial-realtime/tests/runtime.spec.mjs` 去重计数、watermark 关窗、迟到追加修订不动旧版、修订账本超界具名丢弃、限速配额、缓冲背压、开放窗口上界、保留驱逐、缺口 `empty` 物化、暂停/继续、确定性重放、三钟与 lag 可见；`map/spatial-realtime/tests/checkpoint.spec.mjs` 续跑与不间断逐字段相等、重投递去重、篡改摘要/游标/计数器逐码拒绝、超界 checkpoint 拒绝编码、导出摘要钉定与固定报告不改写
- integration: `map/tools/tests/stream-tools.spec.mjs` 真实 catalog+投影端到端（stream_open 绑定精确场景版本折叠实时层、stream_advance 加总汇总与折叠、pause/resume 具名冲突、stream_materialize 经配对发布产物并翻转最终态、崩溃恢复幂等不重复发布、取消/未知/嵌套零折叠零发布）
- Loader: `map/tests/loader-smoke.spec.mjs` profile 链接集含 `spatial-realtime`；`map/tests/topology.spec.mjs` 依赖方向（map-container→spatial-realtime、map-tools→spatial-realtime、spatial-realtime 零 map 依赖）；`map/tests/built-replay.spec.mjs` stateVersion 8
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 stream_* schema（模型可见面）；watermark/lag/缺口/修订可见性由 stream-tools.spec 与 stream-display.spec 对折叠图层记录的结构断言承担；stream content 行为未录制（见「门禁归属」通道边界）
- numeric: `map/spatial-realtime/tests/runtime.spec.mjs` 窗口聚合解析答案（count/sum/min/max/mean 手算）与缺口 count=0；`map/tools/tests/stream-tools.spec.mjs` 迟到修订窗口 count=2/sum=12
- perf: none — 有界批次（≤256）与有界配额同步计算无既定预算；checkpoint 有 1 MiB 硬上界（超界拒绝编码）
- ops: `map/tools/tests/stream-tools.spec.mjs` 取消/嵌套/未知流零折叠零发布；`map/map-container/tests/stream-display.spec.mjs` 不可解码 checkpoint 只读拒绝、卸载清图形与 stream token

- owner: `@map-harness/spatial-realtime` 包（实时流与时序更新）
- command: `pnpm --filter @map-harness/spatial-realtime run test`
- suites: `map/spatial-realtime/tests/contract.spec.mjs`, `map/spatial-realtime/tests/runtime.spec.mjs`, `map/spatial-realtime/tests/checkpoint.spec.mjs`, `map/tools/tests/stream-tools.spec.mjs`, `map/map-container/tests/stream-display.spec.mjs`
- out-of-scope: 真实流供应商接入与多源融合（spec §3.2 部署输入；受控场景资源为唯一配置源）；push 通道/后台线程（首期 pull 驱动，设计明确不逐事件唤醒模型）；无限保留（checkpoint 与保留窗口全部有界）；本包 content 行为流录制（keyed 通道已建立，schema 面在 `snapshots/session/map-analyst-turn`，见「门禁归属」）

### `stream-providers/`（真实流供应商 owner：SSE/completions 双族接入/停靠读取有界轮/cc-switch 具名凭据/多源融合水位/执行轮解析）

- unit: `map/stream-providers/tests/contract.spec.mjs` 版本词表与界桩（id/凭据引用/sse/completions 逐字段越界具名拒绝、九结局闭合枚举、fusion 2..8 源界与悬空源名拒绝）；`map/stream-providers/tests/sse.spec.mjs` 真实 loopback SSE 九结局全覆盖（burst 读取/配额停读续读/干净关闭/开超时/401/unreachable/坏 content-type/坏 UTF-8 与坏 JSON 流违规/未认证 feed）；`map/stream-providers/tests/completions.spec.mjs` token 增量组装跨轮持久、`[DONE]` 干净终态、协议块与叙述行分离计数、坏 JSON 块流违规、error 块、开超时与 401；`map/stream-providers/tests/fusion.spec.mjs` 脚本化语义（滞后源压水位、eventTime/声明序/到达序稳定释放、命名空间同 id 不冲突、满队不读线、暂停冻结队列、offline 源退出水位、全失败 offline 轮、越预算溢出携带零丢失、终结源不约束）
- integration: `map/stream-providers/tests/fusion.spec.mjs` 双真实 loopback 源真喂 `StreamRuntime.advanceLive`（滞后水位压尾、暂停解绑、9/9 admitted/processed、重投递去重吸收）；`map/stream-providers/tests/service.spec.mjs` 真实 loopback + sqlite fixture store 端到端（listSources 脱敏只具名、四类具名凭据拒绝映射 auth-rejected 无值泄漏、真实 feed 凭据解析落 streaming/source-closed、fusion 调度面开/推进/暂停/恢复/关与未知 id 具名拒绝）
- Loader: `map/tests/loader-smoke.spec.mjs` profile 链接集含 `stream-providers`；`map/tests/topology.spec.mjs` 依赖方向（stream-providers→spatial-realtime、其余零 map 依赖）；`map/tests/build-exports.spec.mjs` 运行时包出口清单
- snapshot: none — 无模型可见工具面（服务面供 host 消费，不改 agent 工具集）；结构化断言由本包 spec 与 spatial-realtime/runtime 面承担
- numeric: `map/stream-providers/tests/fusion.spec.mjs` 水平算术手算（min 覆盖界、释放预算封顶、批界 256 分块）与真喂 runtime 计数钉定（admitted 9/processed 9）
- perf: none — 单轮单源一读时限、有界配额与有界队列，无既定预算面；真实供应商吞吐不在门禁（live lane 仅连通性）
- ops: `map/stream-providers/tests/service.spec.mjs` 凭据值零回显（summary/detail/报告全量扫描）、closeAll 静止关闭；`map/stream-providers/tests/live.spec.mjs` 变量激活真连 api.deepseek.com（默认 `deepseek-flash`，`STREAM_PROVIDERS_LIVE_MODEL` 覆盖），无变量自跳过，凭据值不回显；fixtures 子进程 teardown 零残留

- owner: `@map-harness/stream-providers` 包（真实流供应商接入与多源融合）
- command: `pnpm --filter @map-harness/stream-providers run test`
- suites: `map/stream-providers/tests/contract.spec.mjs`, `map/stream-providers/tests/sse.spec.mjs`, `map/stream-providers/tests/completions.spec.mjs`, `map/stream-providers/tests/fusion.spec.mjs`, `map/stream-providers/tests/service.spec.mjs`, `map/stream-providers/tests/live.spec.mjs`
- out-of-scope: 重连退避策略与 poll 族（执行轮停靠读取替代，spec 裁决）；Last-Event-ID 续传（供应商侧不支持，去重吸收重投递）；传输插件化与模型可见工具面（服务面供 host 消费）；凭据值入 checkpoint/日志/报告（值只在 reader 内存）

### `spatial-scale/`（大规模分布式数据通道 owner：不可变分块版本/range-tile-query 有界读取/worker 进程/背压/取消静止/发布与溯源/固定 workload 基准）

- unit: `map/spatial-scale/tests/contract.spec.mjs` 预算/读取/workload 词表 fixture（逐字段越界具名拒绝、固定 workload fixture 通过校验、scl- ref 解析、manifest 摘要钉定与逐块/元数据变更识别）；`map/spatial-scale/tests/store.spec.mjs` 不可变分块版本（幂等再摄取、新 head 不使旧版本失效、schema/CRS/时间范围/授权元数据、chunk digest 校验、range 游标断点续读、tile bbox 整块剪枝、query 折叠与截断、超限具名拒绝、摄取失败零版本零暂存残留）；`map/spatial-scale/tests/worker.spec.mjs` 子进程扫描（逐块 digest 验证、崩溃即 failed 不认领结果、游标+续跑等于不间断折叠、取消静止后结算、取消/完成竞争由子进程裁决、挂起超时 kill 即 failed、槽位背压与满队拒绝、dispose 静止与暂存清理）；`map/spatial-scale/tests/scan-record.spec.mjs` 溯源重建（同部件重建摘要一致、任一部件漂移具名拒绝、模型摘要无行载荷且有界、固定 workload 基准双次可重复且逐门通过）
- integration: `map/tools/tests/scale-tools.spec.mjs` 真实 catalog+投影端到端（scale_ingest 复制注册资源为不可变分块版本且幂等、scale_read query/range 游标续读与样本封顶、scale_scan 经 worker 进程扫描并按 accepted-call 配对发布摘要钉定产物、retry_of 返回已发布产物不重算、未知 retry 具名 OPERATION_NOT_PUBLISHED、预中止零折叠零发布）
- Loader: `map/tests/loader-smoke.spec.mjs` profile 链接集含 `spatial-scale`；`map/tests/topology.spec.mjs` 依赖方向（map-tools→spatial-scale、spatial-scale 零 map 依赖）；`map/tests/build-exports.spec.mjs` 运行时包出口清单
- snapshot: `snapshots/session/map-analyst-turn` pin 头收录 scale_* schema（模型可见面）；有界摘要/拒绝路径由 scale-tools.spec 结构断言承担；scale content 行为未录制（见「门禁归属」通道边界）
- numeric: `map/spatial-scale/tests/store.spec.mjs` query 折叠解析答案（values 8..15 的 count/min/max/sum 手算）与混合类型行非匹配计数；`map/spatial-scale/tests/scan-record.spec.mjs` 基准双次运行 matchedCount/matchedSum 逐位相等；`map/tools/tests/scale-tools.spec.mjs` values 32..63 匹配数手算
- perf: `map/spatial-scale/tests/scan-record.spec.mjs` 固定 workload（24,576 行/2,048 行块）基准五门（摄取吞吐、扫描吞吐、堆增长、并发墙钟比、恢复续算墙钟）对照实测记录阈值逐门断言且双次可重复；阈值记录于 `map/spatial-scale/src/contract.ts` `SCALE_RECORDED_THRESHOLDS`（2026-09-25 darwin arm64/node v25.2.1 实测，注释携带原始区间）
- ops: `map/spatial-scale/tests/worker.spec.mjs` 崩溃/超时/取消/dispose 四路暂存目录零残留；`map/tools/tests/scale-tools.spec.mjs` 拒绝路径零发布；`map/spatial-scale/tests/scan-record.spec.mjs` 重建拒绝漂移部件

- owner: `@map-harness/spatial-scale` 包（大规模分布式数据通道）
- command: `pnpm --filter @map-harness/spatial-scale run test`
- suites: `map/spatial-scale/tests/contract.spec.mjs`, `map/spatial-scale/tests/store.spec.mjs`, `map/spatial-scale/tests/worker.spec.mjs`, `map/spatial-scale/tests/scan-record.spec.mjs`, `map/tools/tests/scale-tools.spec.mjs`
- out-of-scope: 外部大数据分块驻留同步（连接器已按 2026-10-07 决策收缩为连接能力，由 `spatial-connect` 承接；本包本地分块对象 provider 维持唯一 provider）；多区域与分布式调度（spec §3.2）；恰好一次网络执行（至少一次+游标重放）；本包 content 行为流录制（keyed 通道已建立，schema 面在 `snapshots/session/map-analyst-turn`，见「门禁归属」）

### `spatial-perf/`（性能容量 owner：spatial-perf@2 冻结 workload/种子、compute-mix 校准探针、分段测量词表、hard/estimated 预算、比值/绝对基准与 advisory 趋势）

- unit: `map/spatial-perf/tests/contract.spec.mjs` 冻结 workload/预算词表 fixture（逐字段越界具名拒绝、固定 workload 通过校验、生成 fixture 与钉定摘要逐位一致、换种子响亮拒绝、hard budget 无 estimated 字段、分段/标签闭表）；`map/spatial-perf/tests/instrument.spec.mjs` 分段采样（分段/标签/结果三元组、失败与取消样本不被吞、确定性 barrier 等待、容量溢出 visible degraded 逐样本计数、payload 入标签即拒绝）；`map/spatial-perf/tests/budgets.spec.mjs` 预算平面（单项合法累计超限具名拒绝且账本零变更、scan/time 按单次终局操作判定、并发槽位、估计成本不进入任何 admission 路径、非法预算构造即抛）
- integration: `map/spatial-perf/tests/workloads.spec.mjs` 真实 Session 投影 + 真实目录 store + 真实 worker 的五 workload 重放（add/hide/show 全部真实折叠、解析-发布-回读经 SQLite 事务、recovery 冷重放与活投影逐字段相等、双点链路选第二点并配对发布折叠、预算中途拒绝先 settle 错误结果且已接受地图逐字节不变）
- Loader: `map/tests/topology.spec.mjs` 依赖方向（spatial-perf 零 map 依赖）；`map/tests/build-exports.spec.mjs` 运行时包出口清单；profile 链接集含 `spatial-perf`（`map/tests/loader-smoke.spec.mjs`）
- snapshot: none — 本包无模型可见 content/schema 变化（纯库 + 测量平面），keyed 录制与既有约定一致为发布前置且需真实 `DEEPSEEK_API_KEY`
- numeric: `map/spatial-perf/tests/workloads.spec.mjs` 空间运算面积和逐位可重复、admission 坐标计数守恒、折叠 revision 增量恰等于折叠数；`map/spatial-perf/tests/benchmark-gate.spec.mjs` 两次完整运行五个 workload 聚合摘要逐位相等
- perf: `map/spatial-perf/tests/benchmark-gate.spec.mjs` 固定 workload 双次完整运行、三条同运行校准比值吞吐门 + 七条绝对门逐门断言；`map/spatial-perf/tests/calibration.spec.mjs` 校准探针工作摘要/规格/读数守卫；阈值记录于 `map/spatial-perf/src/contract.ts` `PERF_RECORDED_THRESHOLDS`（2026-10-08 忙宿主三次实测，历史绝对带在 `PERF_ADVISORY_THROUGHPUT` 仅作参考）；诊断运行 `pnpm --filter @map-harness/spatial-perf run bench`
- ops: `map/spatial-perf/tests/benchmark-gate.spec.mjs` 报告 JSON 往返与趋势/基线比较（异种子报告不可比、两次通过运行零回归）；`map/spatial-perf/tests/diagnostic.spec.mjs` 诊断 JSON/基线缺失、损坏、缺字段和异版本路径；`map/spatial-perf/tests/workloads.spec.mjs` 取消/拒绝路径零残留零折叠

- owner: `@map-harness/spatial-perf` 包（性能容量与基准门禁）
- command: `pnpm --filter @map-harness/spatial-perf run test`
- suites: `map/spatial-perf/tests/contract.spec.mjs`, `map/spatial-perf/tests/instrument.spec.mjs`, `map/spatial-perf/tests/budgets.spec.mjs`, `map/spatial-perf/tests/workloads.spec.mjs`, `map/spatial-perf/tests/benchmark-gate.spec.mjs`, `map/spatial-perf/tests/calibration.spec.mjs`, `map/spatial-perf/tests/diagnostic.spec.mjs`
- out-of-scope: 百万要素/大栅格/网络 workload（对应 provider 落地后另设 gate，设计 §13.3）；浏览器帧渲染与真实 GUI 时延（composition lane）；供应商费用计费（估计项不强制）；Loader 启动时延（Loader smoke lane）
### `spatial-observability/`（观测运维 owner：correlation/结果词表/错误码/低基数指标/脱敏/健康平面/故障注入矩阵/诊断导出）

- unit: `map/spatial-observability/tests/contract.spec.mjs` 契约 fixture（六结果逐项结算与分类、operationRef 规范文法与越界拒绝、嵌套 scope 继承 trace、闭表标签拒绝载荷/trace id、采样永不丢失败与审计、容量溢出逐类计数、throwing sink 不阻塞不静默）；`map/spatial-observability/tests/sanitize.spec.mjs` 脱敏（凭据键任意深度、几何载荷折叠、POSIX/Windows 路径占位、深度/数组显式截断、循环结构、安全载荷逐位通过、抑制全可见）；`map/spatial-observability/tests/instrument.spec.mjs` 分段指标（八段延迟、字节/扫描/队列等待/深度 gauge、flush/artifact/render 失败独立计数、provider 调用与限流计数、单操作跨平面 correlation、有界 LRU 关联索引、基数恒定）；`map/spatial-observability/tests/health.spec.mjs` 健康面（六平面初始 ready、provider unavailable/catalog lag/render+flush 失败分离、遥测丢弃折叠 process 平面、恢复迁移弧、有界导出截断保审计、导出整体脱敏）
- integration: `map/spatial-observability/tests/correlation.spec.mjs` 一次操作贯穿真实生产面（真实 Session 投影 accepted 调用对、真实 JSONL 持久后端 flush barrier、真实 SQLite 目录注册+产物发布、投影 wire view 派生；全平面记录共享 operationRef/runId/goalRevision/traceId、分段各测一次、导出按 operationRef 可查询、宿主路径零泄漏）；`map/spatial-observability/tests/faults.spec.mjs` 故障矩阵（五点默认码注入、N 次耗尽自动解除后同点重放恢复、注入审计带 correlation、flush 注入→data degraded→重放→ready 全弧可查询、worker 崩溃如实 outcome_unknown、provider 限流独立计数）
- Loader: `map/tests/topology.spec.mjs` 依赖方向（spatial-observability 零 map 依赖）；`map/tests/build-exports.spec.mjs` 运行时包出口清单；profile 链接集含 `spatial-observability`（`map/tests/loader-smoke.spec.mjs`）
- snapshot: none — 本包无模型可见 content/schema 变化（纯遥测/运维库），keyed 录制与既有约定一致为发布前置且需真实 `DEEPSEEK_API_KEY`
- numeric: `map/spatial-observability/tests/instrument.spec.mjs` 六个 operations 系列恰对应 outcomes 闭表、计数守恒（6 项各 1）；`map/spatial-observability/tests/contract.spec.mjs` keep-1-in-N 精确保留数（3/9 与丢弃 12）、容量溢出逐类精确计数
- perf: none — 延迟/字节测量的性能门禁归 `spatial-perf`（本包只提供分段记录面，不设阈值门）；队列/等待分布由 `obs_queue_wait_ms` 系列承载
- ops: `map/spatial-observability/tests/faults.spec.mjs` flush/artifact/provider/worker/render 五故障注入、恢复与回放；`map/spatial-observability/tests/health.spec.mjs` telemetry dropped 与恢复状态；诊断导出与 runbook 流程见 [spatial-observability.md](spatial-observability.md)

- owner: `@map-harness/spatial-observability` 包（观测运维与故障处置）
- command: `pnpm --filter @map-harness/spatial-observability run test`
- suites: `map/spatial-observability/tests/contract.spec.mjs`, `map/spatial-observability/tests/sanitize.spec.mjs`, `map/spatial-observability/tests/instrument.spec.mjs`, `map/spatial-observability/tests/health.spec.mjs`, `map/spatial-observability/tests/faults.spec.mjs`, `map/spatial-observability/tests/correlation.spec.mjs`
- out-of-scope: OTLP/分布式 trace/跨区域告警/SLO 仪表盘（部署环境 adapter 接入，spec §3.2）；上游 telemetry core 改动（边界禁止）；浏览器帧渲染时延（composition lane 拥有）；模型/供应商费用计费（`spatial-perf` 估计项拥有）

### `spatial-connect/`（外部数据连接 owner：PostGIS/对象存储/COG 连接能力——受验证配置面、凭据环境引用、协议级连通/认证验证）

- unit: `map/spatial-connect/tests/contract.spec.mjs` 契约 fixture（版本与闭表结局词表、id/host/bucket/endpoint/timeout 逐字段越界具名拒绝、detail 脱敏与 200 字符有界）；`map/spatial-connect/tests/service.spec.mjs` 配置与服务面（schema 缺省凭据引用名、加载时凭据解析与 `CONNECT_CREDENTIAL_MISSING` 点名变量、id 单命名空间冲突拒绝、第 17 个连接拒绝、非法声明点名连接响亮失败、listing/摘要只携带引用名与端点身份绝不携带值、未知 id 与预中止信号、空配置空注册表）
- integration: `map/spatial-connect/tests/postgres.spec.mjs` 真实 wire 协议（脚本服务器全交换：SCRAM-SHA-256 独立重算 proof 交叉核对且错 ServerSignature 判协议违规、MD5 独立计算、cleartext、SSL disable/prefer 升级/require 'N'、SQLSTATE 28P01/28000/3D000/53300 映射、帧违规、ECONNREFUSED、静默服务器 deadline、中止、认证后查询期 ErrorResponse、Terminate 收尾、乱序即违规、未知认证族 auth-rejected）；`map/spatial-connect/tests/objectstore.spec.mjs`（ListObjectsV2 max-keys=0：AWS 公开 SigV4 文档向量独立核对签名器、path/virtual-hosted 寻址、会话令牌入 header 与签名词表、非零 KeyCount/异常字段协议违规、401/403/404/301 region 提示/503、不可达、超时、中止）；`map/spatial-connect/tests/cog.spec.mjs`（≤3 次 Range 读头与首 IFD：classic/BigTIFF × II/MM、tiled/striped 判读、每请求携带 bearer、200 整对象 unsupported-channel、非 TIFF magic、目录超限、404/401、越界即违规、不可达、超时、中止）
- Loader: `map/tests/loader-smoke.spec.mjs` profile 链接集与 patch insert 行含 `spatial-connect`（无默认 config）；`map/tests/topology.spec.mjs` 依赖方向（spatial-connect 零 map 依赖）；`map/tests/build-exports.spec.mjs` 运行时包出口清单
- snapshot: none — 本包无模型可见 content/schema 变化（连接能力库；无工具面、无 map change），keyed 录制与既有约定一致为发布前置且需真实 `DEEPSEEK_API_KEY`
- numeric: none — 协议交换断言为精确字节/状态闭表判定，无数值容差路径
- perf: none — 一次性验证交换无吞吐面；deadline 界限（1000ms–60000ms）由契约 lane 断言
- ops: `map/spatial-connect/tests/live.spec.mjs` key-activated 复验 lane（部署填 `SPATIAL_CONNECT_POSTGRES_*`/`SPATIAL_CONNECT_S3_*`/`SPATIAL_CONNECT_COG_*` 后同一命令对真实端点复验；未设自跳过）；凭据只经环境变量进入、detail/摘要整条脱敏由 contract lane 断言

- owner: `@map-harness/spatial-connect` 包（外部数据连接能力）
- command: `pnpm --filter @map-harness/spatial-connect run test`
- suites: `map/spatial-connect/tests/contract.spec.mjs`, `map/spatial-connect/tests/service.spec.mjs`, `map/spatial-connect/tests/postgres.spec.mjs`, `map/spatial-connect/tests/objectstore.spec.mjs`, `map/spatial-connect/tests/cog.spec.mjs`, `map/spatial-connect/tests/live.spec.mjs`
- out-of-scope: 外部数据驻留同步/批量摄取（2026-10-07 决策收缩为连接能力；业务数据只留存本项目）；连接池/长驻会话（一次性验证交换）；数据内容与 schema 校验（连接能力不读业务数据）；TDE/云 KMS 集成（部署环境 adapter）

### `mcp-transport/`（远程 MCP transport 接入 owner：stdio 跨进程/streamable-HTTP 连接能力——受验证配置面、凭据环境引用、协议级交换与派发）

- unit: `map/mcp-transport/tests/contract.spec.mjs` 契约 fixture（版本与闭表十一结局词表、id/command/args/envRefs/cwd/url/tokenEnv/timeout 逐字段越界具名拒绝、detail 512 字符有界）；`map/mcp-transport/tests/service.spec.mjs` 配置与服务面（两类声明解析、凭据加载时解析与 `MCP_TRANSPORT_CREDENTIAL_MISSING` 点名变量、id 单命名空间冲突拒绝、第 17 个连接拒绝、非法声明点名连接响亮失败、listing/摘要只携带引用名与端点身份绝不携带值、未知 id、openConnection 缓存、callTool 瞬态路径、closeConnection/closeAll 静止收尾）
- integration: `map/mcp-transport/tests/stdio.spec.mjs` 真实子进程（连接/握手/身份/发现/派发、envRefs 传播入子进程环境、ENOENT unreachable、静默 stdout deadline timeout、坏 initialize protocol-violated、旧 protocolVersion protocol-version-unsupported、拒 tools/list tool-list-refused、crash 工具中途退出 transport-closed、hang 工具中止 aborted、isError 内容是结果非失败、关闭后子进程退出确认）；`map/mcp-transport/tests/http.spec.mjs` 真实 node:http 监听（连接/身份/发现/派发、错 token 401 auth-rejected 且 detail 不回显 token 值/正确 token connected、拒连端口 unreachable、坏 initialize protocol-violated、静默 TCP deadline timeout、hang 中止 aborted）
- Loader: `map/tests/loader-smoke.spec.mjs` profile 链接集与 patch insert 行含 `mcp-transport`（无默认 config）；`map/tests/topology.spec.mjs` 依赖方向（mcp-transport 零 map 依赖）；`map/tests/build-exports.spec.mjs` 运行时包出口清单
- snapshot: none — 本包无模型可见 content/schema 变化（连接能力库；工具目录只在运行时从远程端点发现），keyed 录制与既有约定一致为发布前置且需真实 `DEEPSEEK_API_KEY`
- numeric: none — 协议交换断言为精确身份/状态闭表判定，无数值容差路径
- perf: none — 一次性验证交换与逐调用派发无既定预算；deadline 界限（1000ms–60000ms）与子进程退出宽限由契约 lane 断言
- ops: `map/mcp-transport/tests/live.spec.mjs` key-activated 复验 lane（部署填 `MCP_TRANSPORT_LIVE_URL`/`MCP_TRANSPORT_LIVE_TOKEN` 后同一命令对真实端点复验；未设自跳过）；静止拆除（在途 settle、子进程退出确认、SIGKILL 兜底）由 stdio lane 断言

- owner: `@map-harness/mcp-transport` 包（远程 MCP transport 接入能力）
- command: `pnpm --filter @map-harness/mcp-transport run test`
- suites: `map/mcp-transport/tests/contract.spec.mjs`, `map/mcp-transport/tests/stdio.spec.mjs`, `map/mcp-transport/tests/http.spec.mjs`, `map/mcp-transport/tests/service.spec.mjs`, `map/mcp-transport/tests/live.spec.mjs`
- out-of-scope: 远程 MCP 服务端部署（2026-10-07 决策：本项目不部署远程主机）；会话化流（SSE）传输（streamable-HTTP JSON 模式）；工具目录缓存/同步（逐连接逐调用发现）；sampling/roots/elicitation 等客户端能力（首期只覆盖 tools）


## 未实现能力的门禁归属（out-of-scope 表）

设计 §2.4：每个 release gate 只在负责能力已实现时启用；未实现能力在此登记 owner 与交付门禁，不预建空检查。

| 能力 | 阶段 | Owner | 交付时启用的门禁 | 当前状态 |
|---|---|---|---|---|
| 网络可达性（路网/LBS provider） | P1 | `@map-harness/spatial-accessibility`（已交付） | provider focused test（跨界/分页缺失/取消已由 network.spec 覆盖）；真实供应商 contract test | 受控 provider 已交付；高德、天地图、Mapbox 三家 adapter + keyless 自跳过契约门禁已交付（2026-09-27，`amap.spec.mjs`/`tianditu.spec.mjs`/`mapbox.spec.mjs`/`provider-config.spec.mjs`/`vendor-contract.spec.mjs`，受控双跑等价恒绿）；真实 API 复验为 key-activated lane（用户填 `AMAP_API_KEY`/`TIANDITU_API_KEY`/`MAPBOX_ACCESS_TOKEN` 后一条命令复验，命令见 spatial-accessibility owner 行） |
| 人口守恒/覆盖统计 | P1 | `@map-harness/spatial-accessibility`（已交付） | 格网重分配守恒 fixture（总量不变负向例） | 已交付（metrics.spec 守恒/容量/入口 fixture） |
| 空间统计/时空模式 | P2 | `@map-harness/spatial-statistics`（已交付） | 解析小样例 + 独立稠密实现 + 9! 全枚举 + Cliff–Ord 闭式对照（stats.spec 四路交叉验证） | 已交付；外部统计 provider（成熟实现直接接入）与栅格 zonal 为后续阶段 |
| 归因/预测/优化泄漏 | P3 | `@map-harness/spatial-decision`（已交付） | 基线/识别限制/预测区间/concurrent 泄漏/域外漂移负向 fixture（contract/attribution/causal/forecast/optimize.spec） | 已交付；非线性预测模型与全局组合选址为后续阶段 |
| 跨存储 DB namespace（PostGIS） | P0b 目录跨存储步骤 | spatial-catalog | DB namespace 隔离与故障注入 fixture | out of scope（本地矢量先行，设计 §15.4） |
| 性能基准 | 全局 | 上游 `benchmarks/` + `vitest.bench.config.ts`；map 侧 `@map-harness/spatial-perf`（已交付：三条同运行校准比值门、七条绝对门、历史吞吐 advisory 与记录阈值） | 上游 `test:bench` 仍按其规则启用；map 侧由 `map/spatial-perf/tests/benchmark-gate.spec.mjs` 与 `diagnostic.spec.mjs` 承担（`node map/bin/test.mjs` 聚合内） | map 定位/显隐、解析发布、单次空间运算、恢复、双点链路已有测量门禁；帧预算/百万要素 provider 另行设 gate |
| Windows 平台矩阵 | 全局 | 上游 CI platform matrix | wrapper/composition Windows lane | 本仓库验证仅 POSIX；win32 分支已写，未纳入常规验证 |
| 录制会话快照（keyed） | 发布前置 | 上游 `snapshots/` 树 | `pnpm run test:snapshot:record` 后 `pnpm run test:snapshot` keyless 回放 | 已建立（2026-09-26）：通道为全局多供应商机制——同一 `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` env 机制既可指向 DeepSeek 官方也可指向第三方网关（本次经 OpenAI 兼容 `/v1/chat/completions` 的 glm-5.3 录制；`/v1/messages` 网关侧 circuit_open 不可用），场景级 provider/model 由组合 patch 经 `llm-deepseek` 的 `protocol: chat-completions` + 模型目录声明；录制会话 `snapshots/session/map-analyst-turn`（模型 glm-5.3 真实调用 catalog_register→catalog_resolve→geo_buffer→map_add_layer 链路，含 `spatial-context/agent` 预注入器的基线+增量注入文本，墙钟 elapsed/digest 由快照 identity 层归一化）；keyless 双模式回放 src 161/2、lib 167/2 全绿。上游既有 live 场景维持 DeepSeek 录制、不随本通道重写（用户 2026-09-26 决策；重录会把上游 DeepSeek 语料整体改写为 GLM 转录，属上游所有者的单独决策） |
| Point/Line 面积拒绝、边界接触拓扑判定 | D09/P0b | map-tools 数值语义 owner | 语义变更 + 快照级证据 + 旧行为快照更新 | 现状以 published limitations 披露守卫钉住（`numeric-answers.spec.mjs`） |
| viewshed 面域可视域、大栅格/实时地形 | 后续规模包 | 待定 | 大栅格 provider contract test + 面域计算的解析对照 fixture | out of scope（本包为采样视线，spec §3.2） |

## 回放 fixture 清单

| 回放行为 | 证据位置 |
|---|---|
| 正常 fold（call→result 配对、revision/身份推进） | `map/map-container/tests/projection.spec.mjs` |
| 失败结果准入（isError+meta 不动图、bounded diagnostic） | 同上 |
| 未配对结果 / surface-replaced 重复（apply-once） | 同上 |
| 未知 schemaVersion / 未知 kind 只读拒绝 | 同上 |
| stale revision / capacity / pending overflow | 同上 |
| 旧日志（pre-P0a flat meta 专用解码路径） | 同上 |
| projection cache 阶梯（checkpoint 播种 / ver 失配丢弃 / 损坏行丢弃整段重放 / 冷重放相等 / 尾重放续跑） | 同上 |
| 新进程从原始日志恢复 + fork 隔离 | 同上 |
| 跨进程 built artifact 重放（子进程挂载 built 插件 + 真实 SessionStore，结果与手写期望字面量逐字段相等） | `map/tests/built-replay.spec.mjs` |
| patch 原子折叠（3-op patch 单 revision、操作账本含逆补偿）、fold 侧重复 operation id 只记 duplicate-op 不二折叠 | `map/tools/tests/collab-tools.spec.mjs` |
| 旧 patch 删除不自动重放（layer_missing 具名冲突）、同层 digest 期望过期具名冲突 | `map/spatial-collab/tests/engine.spec.mjs` + `map/tools/tests/collab-tools.spec.mjs` |
| 恢复后审计账本 refold 相等、undo 目标跨进程一致 | `map/tools/tests/collab-tools.spec.mjs` |
| 取消在途 / provider dispose barrier（确定性 barrier，非 fixed sleep） | `map/arcgis-mcp/tests/lifecycle.spec.mjs` |
| MCP 未知/重复/缺失工具名拒绝、execution token 绑定 | `map/arcgis-mcp/tests/arcgis-mcp.spec.mjs` |
| 模式拒绝（`mode: native` 钉死，`DSH_TOOLS_MODE=ptc\|both` 不可翻转） | `map/tests/loader-smoke.spec.mjs` |
| profile/Loader 组合与缺产物 fast-fail | `map/tests/loader-smoke.spec.mjs` |
| geo `analysis-result` meta 未知版本/kind 只读拒绝 | `map/tools/tests/geo.spec.mjs` |
| 存储迁移 SIGKILL 崩溃（步骤中途死亡→整体回滚→重跑续升，行数据保全） | `map/spatial-storage/tests/migrate.spec.mjs` |
| 备份 bundle 校验与分层恢复（冲突不覆盖、授权/摘要验证、恢复位置变化） | `map/spatial-storage/tests/backup.spec.mjs` |
| 清理 TOCTOU/lease 互斥/活动写入与 pin 保护 | `map/spatial-storage/tests/lifecycle.spec.mjs` |
| 存储条目缺文件/digest/权限/未来版本分层报告 | `map/spatial-storage/tests/recovery.spec.mjs` |
| pre-step 基线注入实际进入 user/message（确认仅由投影折叠产生） | `map/spatial-context/tests/loop.spec.mjs` |
| 重复 digest/无新事实的请求不再注入（可见 surface 去重） | `map/spatial-context/tests/loop.spec.mjs` |
| compaction 隐藏基线后同 goal 重建完整有界基线（D05） | `map/spatial-context/tests/loop.spec.mjs` |
| reject/空首步/prepareCall 前取消不自启请求、不预提交目标或注入（D05/D06） | `map/spatial-context/tests/loop.spec.mjs` |
| mid-turn 增量注入新证据/计划，不改写历史 | `map/spatial-context/tests/loop.spec.mjs` |
| decision_update 目标/计划冲突与预算在花费前拒绝 | `map/spatial-context/tests/loop.spec.mjs` |
| 未知 decision-change 版本只读诊断、失败结果折叠为 failed 证据 | `map/spatial-context/tests/projection.spec.mjs` |
| 外延嵌套/时间窗/阻抗缺失/直线探索标记拒绝 | `map/spatial-accessibility/tests/contract.spec.mjs` |
| POI 分页 complete/partial/empty、RATE_LIMITED/PERMISSION/UNAVAILABLE、expansion 内 abort checkpoint | `map/spatial-accessibility/tests/network.spec.mjs` |
| submit durable 先于 worker、同 operationRef 去重/异 digest 冲突、run_get 不重执行 | `map/spatial-accessibility/tests/runs.spec.mjs` |
| 取消先到→cancelled、完成先到→succeeded+cancelRequested、死 epoch 孤儿→outcomeUnknown、dispose 等待真实静止 | 同上 |
| 解析格网覆盖答案（180/380）、守恒恒等、入口缺失排除、容量硬上限、跨界保留、partial/empty/METHOD_NOT_APPLICABLE | `map/spatial-accessibility/tests/metrics.spec.mjs` |
| 候选同 inputRefs 重算、infeasible 命名不计算、权重扰动翻转公开、旧 goal 拒绝投影、固定 revision 导出全等 | `map/spatial-accessibility/tests/compare.spec.mjs` |
| 高德 adapter 契约（fixture 传输：infocode→既有错误词表、WGS84↔GCJ-02 datum 往返、收缩面 bike/barriers/时间片/分页窗口响亮、取消检查点、构造拒绝；共享断言集受控双跑等价） | `map/spatial-accessibility/tests/amap.spec.mjs` |
| 天地图 adapter 契约（fixture 传输：XML 窄解析、公里单位、CGCS2000 免转、响应形态归类、serviceArea/readPois 声明式收缩、取消检查点；共享断言集受控双跑等价） | `map/spatial-accessibility/tests/tianditu.spec.mjs` |
| Mapbox adapter 契约（fixture 传输：Directions/Isochrone 映射、401/403/404/422/429 与 200-带-message 形态、contours 上限、WGS84 免转、URL 上限、条款注意入限制声明；共享断言集受控双跑等价） | `map/spatial-accessibility/tests/mapbox.spec.mjs` |
| 网络源 Config/凭据面（四项已配置源、三家 credential-ref env 名默认、可选 `baseUrl` 透传与非法根拒绝、未知 id/缺凭据加载期响亮失败、凭据不进配置序列化/错误文本/networkRef） | `map/spatial-accessibility/tests/provider-config.spec.mjs` |
| 三家厂商四类断言（跨界/分页缺失/取消/无效 key）+ 真实定价面：无 `AMAP_API_KEY`/`TIANDITU_API_KEY`/`MAPBOX_ACCESS_TOKEN` 各自跳过 exit 0；同断言集受控双跑恒绿 | `map/spatial-accessibility/tests/vendor-contract.spec.mjs` |
| run_submit→run_get→run_cancel 经真实 catalog/run 服务/projection；retryOf 只取回已提交 run | `map/tools/tests/run-tools.spec.mjs` |
| 常数场/单元不足/零邻居/孤岛 → not_applicable 或具名排除，不发明 p 值 | `map/spatial-statistics/tests/stats.spec.mjs` |
| Moran/Gi\* 对照独立稠密实现；置换 sd 对照 9! 全枚举与 Cliff–Ord 闭式 | `map/spatial-statistics/tests/stats.spec.mjs` |
| 缺窗 unknown、迟到排除、稀疏拒绝、断链不插补、留出漂移/Jaccard 手算 | `map/spatial-statistics/tests/patterns.spec.mjs` |
| 同源产物谱系归组不重复计证据；多尺度符号分歧公开；图例域同版本 | `map/spatial-statistics/tests/evidence.spec.mjs` |
| stats_*/pattern_* 经真实 catalog+配对：artifact 发布、spatial-stat meta 解码、无效 spec 与 not_applicable 拒绝路径 | `map/tools/tests/stat-tools.spec.mjs` |
| 无识别设计/失衡/重叠不足/干扰疑似/无处理变异 → association/unknown 具名降级，平衡设计达 causal 且区间含真值 | `map/spatial-decision/tests/causal.spec.mjs`、`map/tools/tests/decision-model-tools.spec.mjs` |
| concurrent 特征在 forecast_validate/forecast_predict 拒绝（泄漏失败响亮）、迟到行/缺字段具名排除 | `map/spatial-decision/tests/forecast.spec.mjs`、`map/tools/tests/decision-model-tools.spec.mjs` |
| fit→predict 经序列化模型 artifact 往返、方法版本漂移拒绝、域外/漂移具名不静默外推 | `map/spatial-decision/tests/forecast.spec.mjs` |
| 不可行候选具名保留无排名、权重缺省选标记默认情景、权重扰动翻转公开 rankStable:false | `map/spatial-decision/tests/optimize.spec.mjs`、`map/tools/tests/decision-model-tools.spec.mjs` |
| 容量缺口/预算外站点关门具名、未覆盖行诚实 partial、贪心平局按 id 确定性 | `map/spatial-decision/tests/optimize.spec.mjs` |
| attribution_*/forecast_*/scenario_*/location_* 经真实 catalog+配对：artifact 发布、spatial-decision meta 解码、claim level/降级原因进 content 与 meta | `map/tools/tests/decision-model-tools.spec.mjs` |
| viz_create_style/viz_classify/viz_compare 经真实 catalog+配对：样式 artifact 发布、set-style v3 meta 折叠、统一分类域同断点、manual 断点缺来源/未知图层/常量字段/无时间来源拒绝 | `map/tools/tests/viz-tools.spec.mjs` |
| set-style 折叠到已存在图层（revision/调用身份推进）、未知图层与 styleVersion 篡改只读拒绝、v2 记录不得携带 set-style | `map/map-container/tests/projection.spec.mjs` |
| 类符号渲染（类色/缺测 x 形/尺寸分级）、时间帧过滤与恢复、共享选择高亮、测试句柄 styledLayers/frameIndex/highlightCount | `map/map-container/tests/occurrence.spec.mjs` |
| 时区日历帧（UTC/Asia/Shanghai）、缺测帧保留、播放到末帧停止不回绕、状态机无模型字段 | `map/spatial-viz/tests/timeline.spec.mjs` |
| 图例分箱复用（图表不再分级）、共享筛选 sel 摘要稳定、缺测不匹配刷选/帧、导出清单输入后不可变 | `map/spatial-viz/tests/linked.spec.mjs` |
| 重复/乱序/迟到/断线批次推进（去重计数、watermark 关窗、迟到追加修订、缺口 `empty` 物化、离线计数） | `map/spatial-realtime/tests/runtime.spec.mjs`、`map/tools/tests/stream-tools.spec.mjs` |
| checkpoint 崩溃续跑与不间断逐字段相等；重投递去重；篡改摘要/游标拒绝；已发布摘要幂等返回不二次发布 | `map/spatial-realtime/tests/checkpoint.spec.mjs`、`map/tools/tests/stream-tools.spec.mjs` |
| 不可变分块版本摄取（幂等再摄取、新 head 不失效旧版本、超限/越权具名拒绝、失败零残留） | `map/spatial-scale/tests/store.spec.mjs`、`map/tools/tests/scale-tools.spec.mjs` |
| range 游标断点续读、tile 整块剪枝、query 折叠与有界样本 | `map/spatial-scale/tests/store.spec.mjs`、`map/tools/tests/scale-tools.spec.mjs` |
| worker 崩溃即 failed 不认领、游标+续跑等于不间断折叠、取消静止、超时 kill、槽位背压、满队拒绝 | `map/spatial-scale/tests/worker.spec.mjs` |
| 固定 workload 基准五门（摄取/扫描/内存/并发/恢复）实测对照且双次可重复；溯源重建漂移拒绝 | `map/spatial-scale/tests/scan-record.spec.mjs` |
| scale_scan 配对发布摘要钉定产物、retry_of 不重算、未知 retry 具名拒绝 | `map/tools/tests/scale-tools.spec.mjs` |
| stream_open 绑定精确场景版本、批次序号断裂拒绝先于折叠；stream_materialize 经配对发布、materialized 模式拒绝 advance | `map/tools/tests/stream-tools.spec.mjs` |
| stream 层 fold 门（id=streamId、resourceRef=场景 ref、checkpoint 解码、旧 meta 只读拒绝）、渲染 token 随 revision/暂停翻转、realtime/materialized 显示区分 | `map/map-container/tests/stream-display.spec.mjs` |
| keyed 录制会话：glm-5.3 真实调用 catalog_register→catalog_resolve→geo_buffer→map_add_layer，容器折叠与工具 content 全程入 log；readPoint（readId/readAt）与 art-\* ref 经快照 identity 归一化为 token 后 keyless 双模式逐字节回放 | `snapshots/session/map-analyst-turn/session.v3.jsonl` + `snapshots/session/map-analyst-turn/tool-schemas.expected.json` |

| 固定 workload 十门基准（定位折叠/解析发布/空间运算/恢复/链路/取消静止/flush/显示派生/堆/离散度）双次可重复且聚合摘要逐位一致 | `map/spatial-perf/tests/benchmark-gate.spec.mjs` |
| 单项合法但累计超限在提交前具名拒绝、已接受地图逐字节不变；估计成本不进入 admission | `map/spatial-perf/tests/budgets.spec.mjs`、`map/spatial-perf/tests/workloads.spec.mjs` |
| 取消请求→worker 静止真实结算（子进程退出、暂存零残留）；flush barrier、显示派生为真实面测量 | `map/spatial-perf/tests/benchmark-gate.spec.mjs`、`map/spatial-perf/tests/workloads.spec.mjs` |

## GLM 网关与官方 DeepSeek 的等价性论证

主张：第三方 OpenAI 兼容网关（GLM 系模型）经 `llm-deepseek` 的 chat-completions 消费面（`packages/llm/llm-deepseek/src/protocols/chat-completions/`）与官方 DeepSeek 在 **dsh 实际消费的契约维度**上行为等价。维度与源码依据：请求形状接受性（`serialize.ts` 的 WireRequest——model/messages、`stream:true`、`stream_options.include_usage`、顶层 `thinking{type}`/`reasoning_effort`、function 工具 schema、temperature/max_tokens/stop）、历史回放编码（assistant 工具回合 `content:""` 绝不 null、`reasoning_content` CoT 回传、`role:'tool'` 按 `tool_call_id` 配对）、SSE 分帧与字面 `[DONE]` 哨兵（`sse.ts`）、流式增量语义（首个空串 reasoning 增量不开块、工具调用 id/function.name 首增量携带且后续 `''`/`null` 表示不变、按 `index` 组装并行调用）、finish_reason 词汇（stop/tool_calls/length 逐一映射，未知值落 error finish）、usage 记账（`prompt_tokens` 含缓存命中、按不相交计数扣除、`completion_tokens_details.reasoning_tokens`）、错误分类（401/403→AUTH、413/400→INVALID_REQUEST 家族、429→RATE_LIMIT 含 retry-after、≥500→SERVER）与流生命周期（usage 先于恰一个 finish 且其后无 chunk、每读空闲看门狗、调用方中止）。

证据两层。**契约级**（keyed，无 `DEEPSEEK_API_KEY` 自跳过并跑 fixture 级自检）：`apps/cli/tests/profiles/headless/tests/provider-contract.e2e.ts` 经共享双模式 launcher 从 `apps/cli/src/bin.ts` 真实启动 `dsh --profile headless`（组合 patch `apps/cli/tests/profiles/headless/provider-contract.patch.yml`，网关经 `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` 环境选择、模型经 `DSH_CONTRACT_MODEL`），固定 9 场景（纯文本回合、思考回合与 CoT 回放、单工具往返、多轮工具链、并行/索引工具调用、结构化 JSON 输出、低 max_tokens 输出上限、目录外模型与无效凭据两条负向、流中途 SIGKILL 后恢复）对上述维度做确定性结构断言；2026-09-26 经网关 glm-5.3 实测全绿，同日官方阻塞入档后带 fixture 修正复验仍绿（vitest 15/15 通过——5 keyless 自检 + 10 keyed 场景，tests 墙钟 199.41s，整链 exit 0）。**结构级**（keyless）：`map/tests/glm-deepseek-parity.spec.mjs` 只读对比既有双语料（上游 DeepSeek 录制 `snapshots/session/` vs GLM 录制 `snapshots/session/map-analyst-turn`），双方在同一组结构不变量上 100% 一致（2026-09-26 实测：嵌入式流协议序 GLM 4/4、上游 live 93/93；工具调用身份合规 GLM 4/4、上游 live 55/55；工具参数 JSON 有效性 live 双方 100%（上游唯一一条非法参数出自 authored 负向 fixture `deepseek-messages-invalid-tool-history`，其设计目的即非法历史）；call↔result 配对 GLM 4/4、上游 live 55/55 与 authored 97/97；finish 词汇双双全在文档化集合内，GLM {tool-calls:3, stop:1}、上游 live {tool-calls:49, stop:44}+authored {stop:72, tool-calls:92, max-tokens:1}；usage 正值与 totalTokens 不相交和一致 GLM 4/4、上游 live 99/99 与 22/22；reasoning 块先于 text 块 GLM 1/1、上游 39/39；GLM 网关 4/4 上报 cacheReadTokens 与 reasoningTokens）。

上游 `0.2.0-rc.2` 已移除旧的 `test:provider-parity` 根脚本；本包保留可离线重放的结构级 parity lane：`node --test map/tests/glm-deepseek-parity.spec.mjs`。需要官方供应商实跑时，应在上游拥有者恢复对应 profile lane 后另行验证，不把缺失脚本伪装成可执行证据。

诚实边界（不主张）：模型质量、能力、输出分布或语义等价（不做生成文本的评分/语义/分布对比）；官方 DeepSeek 侧行为已被验证（官方 lane fixture 就绪但实跑阻塞于官方账户零余额——2026-09-26 所有 completions 402 external_blocked，等价性结论在官方 lane 跑绿之前只对网关侧成立）；messages 协议（`/anthropic /v1/messages`）等价（网关侧 circuit_open 不可用，默认 messages 协议路径未被 GLM 通道验证）；图片输入、Files API、vision、缓存命中率数值等未测维度；跨供应商或跨模型一般化（结论只覆盖该网关的 glm-5.3 chat-completions 通道与固定场景集，网关其余 glm-* 模型 id 未测）；网关 SLA（时延、可用性、配额、行为时不变性——等价性只对运行时点证据负责，套件可复跑是唯一持续验证方式）；双 corpus 同任务同分布（两侧场景与工具面不同源，结构对比只断言各自满足同一组不变量）。

## 资源可靠性约定

map 层测试的共用约定由 `map/tests/support/reliability.mjs` 提供，`map/tests/reliability.spec.mjs` 作为门禁证明其契约：

- **临时目录**：用 `trackedTmpDir(label)` 登记 mkdtemp 根；`withTrackedTmpDir` 保证 body 抛错仍清理。禁止裸 `mkdtemp` 后依赖测试作者自觉 finally。
- **等待**：`waitFor(predicate, { timeoutMs, label })` 轮询外部状态直到成立或超时（超时错误带 label）；禁止 fixed sleep。确定性暂停用显式 barrier promise + 外部 release。
- **跨进程**：子进程脚本由父进程写入 tracked 临时目录后以绝对路径 import 各自 lib（子进程 cwd 隔离 bare specifier 解析）；父进程断言子进程退出码、stdout 与真实文件系统状态，不自报。
- **泄漏检查**：`countTmpRoots(prefix)` 观察真实 tmpdir 残留；门禁测试在子进程退出后统计前缀计数。
- **平台**：symlink/权限负向例为 POSIX 语义（`geo.spec.mjs` 工作区逃逸/符号链接竞态）；Windows 语义归上游 CI platform matrix（见 out-of-scope 表）。

## 门禁归属、刷新规则与审查流程

| 门禁 | 命令 | 归属 | 刷新规则 |
|---|---|---|---|
| focused 单包套件 | 各 owner 行 command | 对应包 | 行为变更同 PR 更新；描述行为不描述实现 |
| map 工程门禁聚合 | `node map/bin/test.mjs [--build]` | `map/tests/` | 新 suite 必须入聚合并登记本矩阵 |
| 真实 GUI/模型链路 | `pnpm --filter @map-harness/arcgis-mcp run test:composition` | arcgis-mcp lane | 需 `node map/bin/build-web.mjs` + Playwright；真实 GUI 改动另按仓库规则录制 GIF |
| expected 过程期望 | `pnpm run test:expected`（owner-local） | 上游树 owner | `pnpm run test:expected:refresh`；map 层当前无 owner-local expected |
| 录制会话快照 | `pnpm run test:snapshot` / `:record` | 上游 `snapshots/` 树 | 仅模型/用户/协议可见变化录制；record 需真实 key；replay keyless。keyed 通道已建立（2026-09-26）：通道为全局多供应商机制（`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` env 指向 DeepSeek 官方或第三方，场景级 provider/model 由组合 patch 声明）。map 层场景 `snapshots/session/map-analyst-turn`（组合 map-analyst：headless 基座 + map 容器/ArcGIS MCP/spatial-catalog/spatial-context/spatial-context/agent 预注入器/spatial-accessibility/spatial-collab 插件 + map-tools 全量 47 工具，`mode: native`）以 `DSH_SNAPSHOT=record pnpm run test:snapshot:record -t map-analyst-turn` 经网关 glm-5.3（chat-completions）录制；无 key 双模式实测全绿：CI lib 模式（`DSH_EXAMPLE_MODE=lib`）167 通过/2 跳过（169）exit 0；dev 默认 src/tsx 模式 161 通过/2 跳过（163）exit 0。通道边界如实记录：spatial-context 预注入器（`spatial-context/agent`）已纳入录制组合——墙钟 elapsed 预算行、随体 digest 与被其字宽牵动的 context 计数由快照 identity 层归一化（`{{elapsed}}`/`{{digest:n}}`/`{{contextBytes}}`），基线+增量注入文本 keyless 逐字节回放（其 keyless loop 行为由 `map/spatial-context/tests/loop.spec.mjs` 继续）；上游既有 live 场景维持 DeepSeek 录制、不随本通道重写（用户 2026-09-26 决策，属上游所有者）。spatial-accessibility 插件入口已补全（2026-09-26：包根导出 apply/inject 激活面，Loader 行激活、组合纳入并重录，run_* 工具面随插件激活进入会话，行为另由 focused specs 守卫）。2026-09-26 之前的历史：lib 模式原唯一失败 ptc-python-turn 系默认 `python3` 解析到 3.9.6，运行时对未配置默认按 python3.14…python3.10 版本化回退后接线 Homebrew ≥3.10；src 模式原 84 失败系 tsx source-launch 双平面下 `TOOL_RUNTIME_SCHEDULER` fresh Symbol 跨求值身份不等，改注册符号后收敛（处置台账见 `.spec/specs/archive` 快照阻塞清障包）。keyless 等价证据层 = map 聚合门禁（22 lane）+ composition lane + 翻译配对 + loader-smoke 全量链接断言 |
| 供应商契约等价（GLM 网关 lane） | `node --test map/tests/glm-deepseek-parity.spec.mjs` | `map/tests/glm-deepseek-parity.spec.mjs`（结构级 keyless） | 上游 `0.2.0-rc.2` 不再提供旧的 `test:provider-parity` 根脚本；该 lane 只证明已提交 transcript 的共同结构不漂移，不宣称真实供应商请求已完成；真实 provider lane 另按上游拥有者的当前 profile 约定执行 |
| benchmark | `pnpm run test:bench` | 上游 `benchmarks/` | map 层无条目；出现敏感路径时按 out-of-scope 表启用 |
| lint/doc/类型 | 各包 `tsc -b`（随 build）+ 上游聚合 lint/doc-sync | 上游（不扫 `map/`） | map 层由 `map/tests` 门禁 + built JSDoc 门禁等价覆盖，不重复报名 |

**CI 选择**：`map/**` diff 运行 `node map/bin/test.mjs --build`（含本矩阵门禁）；改动 composition 面（web 前端、浏览器半）追加 composition lane；上游聚合门禁由其自身路径过滤拥有，不因 map diff 触发。失败分类：focused 套件红 = 对应包回归；工程门禁红 = 结构/平面/登记漂移；Loader smoke 红 = 组合面或产物缺失（先 `node map/bin/build.mjs`）；composition 红 = 真实链路回归或环境缺 Playwright。

**审查流程**：本地最小验证 = diff surface 对应 owner 行 command；提交前按 dsh-pre-push-checks 报告实际运行命令。快照/GUI/expected 的刷新必须在 PR 说明中点名证据层级；`none —` 分层的取消（例如建立录制通道）需同时更新本矩阵与 out-of-scope 表。

## 聚合 suite 登记

`node map/bin/test.mjs` 按依赖序运行以下 suite；标签由 runner 与本清单互相钉住（verification-matrix 门禁交叉校验，新增 suite 必须同时改 `map/bin/test.mjs` 与本节）：

1. `map-container package tests (incl. plugin lifecycle)`
2. `spatial-storage package tests (migrations/backup/lifecycle)`
3. `spatial-catalog package tests (register/resolve/artifacts)`
4. `spatial-context package tests (frame/injection/budget)`
5. `spatial-accessibility package tests (contract/provider/runs/metrics/compare)`
6. `spatial-statistics package tests (contract/weights/stats/patterns/evidence)`
7. `spatial-decision package tests (contract/linalg/attribution/causal/forecast/optimize)`
8. `spatial-viz package tests (contract/classify/timeline/linked)`
9. `spatial-collab package tests (contract/engine/lifecycle)`
10. `spatial-terrain package tests (contract/surface/los)`
11. `spatial-realtime package tests (contract/runtime/checkpoint)`
12. `stream-providers package tests (contract/sse/completions/fusion/service)`
13. `spatial-scale package tests (contract/store/worker/record)`
14. `spatial-perf package tests (workload/instrument/budgets/benchmark)`
15. `spatial-observability package tests (contract/sanitize/instrument/health/faults/correlation)`
16. `spatial-connect package tests (contract/postgres/objectstore/cog/service/live)`
17. `mcp-transport package tests (contract/stdio/http/service/live)`
18. `map-tools package tests`
19. `arcgis-mcp package tests (incl. provider lifecycle)`
20. `map engineering topology gates`
21. `map resource reliability gates`
22. `map built-artifact replay parity`
23. `map built-artifact smoke`
24. `map Loader composition smoke`
25. `map GLM/DeepSeek corpus parity gates`
26. `map verification matrix gate`

composition e2e 保持独立 lane（`pnpm --filter @map-harness/arcgis-mcp run test:composition`），不在聚合内。
