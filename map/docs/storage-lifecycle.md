# 存储对象清单、迁移与生命周期

本文是 map 层自有持久状态的权威清单：每个存储对象的 owner、schema 版本、引用者、备份/恢复顺序和删除前提。实现归 `@map-harness/spatial-storage`（`map/spatial-storage/`）；设计依据是 `.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md` §7.2/§11.2/§13.2 与审计 D07/D08。上游 Session 日志与 projection cache 的格式归上游所有，本文只约束 map 层对它们的备份、恢复和引用保护行为。

## 每会话独立库

**每个对话（session）一个独立 SQLite 库**（2026-09-26 发布决策）：store 根（map-web 组合给 `dshHomePath('spatial-store')`）之下按会话分库——`<root>/sessions/<sessionId>/`，每库内部沿用同一单库布局（`store.db` + `files/ staging/ backups/ trash/`），迁移/备份/checksum/清理纪律逐库独立执行。会话身份来自工具执行上下文（`exec.agent.session`），经 `spatialCatalog` 服务的 `forSession(sessionId)` 会话视图路由；`sessionId` 在成为路径成分前经 `invalid-session-id` 显式校验（`map/spatial-storage/src/sessions.ts`）。

- **根目录清单** = `sessions/` 目录本身（每子目录一会话库；`listSessionStores(root)` 只读派生）。不设根级共享索引库/索引文件。
- **跨对话不共享**（显式设计边界）：会话 B 解析会话 A 发布的 ref 得 `CATALOG_NOT_FOUND`（与未知 ref 同答，不泄露存在性）；fork 只继承 session 对象 ACL 状态（父库读、子库写），不继承资源可见性。
- **保留策略**：默认全保留——会话结束不自动删除任何库；删除只有两条显式路径：库内 staging/孤儿清理（下文），以及根级 `dropSessionStore(root, sessionId)`（显式运维调用，经 `<root>/trash/` 原子中转后删除，唯一整库删除路径；无模型可见工具暴露）。
- **旧共享库**：升级部署在 `<root>/store.db` 可能遗留旧单库布局的共享库——插件 load 时 warn 一次，不读、不删、不迁移；新布局自新会话首用起生效。迁移工具明确不提供（`.spec/specs/` 发布决策）。

## 存储对象清单

| 对象 | 物理位置 | schema 版本 owner | 权威状态 | 引用者 |
|---|---|---|---|---|
| catalog（资源目录条目） | `<root>/sessions/<sessionId>/store.db` 表 `catalog_resources` | `@map-harness/spatial-storage`，`SPATIAL_STORE_SCHEMA_VERSION`（`PRAGMA user_version`，单调，逐库） | 目录行是唯一登记处；字节在会话库 `files/` | session/map/report/export/job/backup pin（见引用图，均在本库内） |
| resource（导入资源版本） | `<root>/sessions/<sessionId>/files/…`（目录行 `relative_path` 记含 `files/` 前缀的库相对 POSIX 路径，加 `digest`/`bytes`） | 同上，随 `SPATIAL_STORE_SCHEMA_VERSION` | 不可变字节 + 目录行 | 同上 |
| artifact（分析产物版本） | `<root>/sessions/<sessionId>/files/<artifactId 前缀分片>`，表 `artifacts` | 同上 | 不可变字节 + 目录行 | 同上 |
| intent（发布操作意图） | `<root>/sessions/<sessionId>/store.db` 表 `intents`（`operation_ref` 主键、`request_digest`、`state`） | 同上 | 目录行 | 所属 session；由 `session_id`+`source_call_seq` 定位 |
| stream（作业/流状态） | `<root>/sessions/<sessionId>/store.db` 表 `streams` | 同上 | 目录行 | 所属 session；`job_refs` |
| session（会话日志） | 上游 SessionStore 的 JSONL 文件（备份内为 `<bundle>/data/sessions/<sessionId>` 的字节副本） | 上游 session format 世代；map 层不拥有格式 | 上游日志；map 层只按字节复制/校验，不移动、不覆盖、不删除已提交世代 | `session_refs`（fork 父子，记于子库）；被引用的 resource/artifact 反向保护它 |
| projection cache（投影缓存） | 上游 `session-projection-cache` 存储；`mapContainer` 单元携带 `stateVersion = MAP_PROJECTION_STATE_VERSION`（`map/map-container/src/protocol.ts`） | `@map-harness/map-container`（投影单元状态版本） | 可丢弃派生数据，永远可从原始日志重建 | 无——不是任何引用的目标 |
| map document（地图文档） | 由 Session 日志经 `mapContainer` 投影派生；无第二个权威存储 | 投影单元状态版本同上 | 派生 | 无 |

根目录布局（map 自有部分）：`sessions/<sessionId>/`（每会话独立库，内部为 `store.db`（SQLite，回滚日志模式）、`files/`（不可变字节）、`staging/`（写入前登记的暂存字节）、`backups/`（备份 bundle）、`trash/`（清理的原子中转））；根级 `trash/` 仅服务 `dropSessionStore` 的整库删除中转。目录与数据库文件按 owner-only 权限创建（`0o700`/`0o600`），与上游 `dsh-storage-sqlite` 的约定一致。写入协议：先登记 staging 行，再写字节；发布是把字节 rename 进 `files/` 后才写目录行——崩溃窗口只留下可回收的孤儿字节，绝不留下指向缺失文件的目录行。

## 引用图

保护边（全部存于所属会话库的 `store.db`，只读扫描不修改任何行；引用与保护边不跨库——一个会话的 pin/lease/引用只保护它自己库内的对象）：

| 边 | 表 | 含义 |
|---|---|---|
| session → resource/artifact | `map_refs`（map 图层引用）、`report_refs`（报告/证据引用）、`export_refs`（导出引用）、`job_refs`（进行中作业引用，带 `state`） | 删除该版本会破坏对应会话产物 |
| session → session | `session_refs`（`parent_session_id`，记于子库） | fork 父子指针；资源可见性不跨库继承（跨对话不共享，fork 只继承 session 对象 ACL 状态） |
| backup pin → 任意目标 | `backup_pins`（`target_kind`/`target_id`/`reason`） | 备份窗口内显式固定，备份完成显式释放 |

保护规则：存在任一保护边的已发布版本不可回收；没有引用所有者时同样拒绝自动删除（P0 不自动 GC 已发布资源，见 spec §2.1）。引用一律存相对路径与稳定 id，不存本机绝对路径——备份恢复到新位置后引用仍可解析。

## 迁移

- `SPATIAL_STORE_SCHEMA_VERSION` 单调递增，存于 `PRAGMA user_version`；迁移清单 forward-only，禁止降级，**逐库独立执行**（每会话库各自持有版本号、journal 与备份，一个库的升级不触碰邻居库）。当前版本为 **4**：`p0b-catalog-chain` 步骤在基线之上加入 P0b 目录链 schema（`catalog_resources` 的逻辑资源/摘要/CRS/授权列、`feature_refs`、`semantic_bindings`、`artifacts` 的产物身份列、`intents` 的发布结果列）；`spatial-governance` 步骤（v3）加入治理 ACL/审计表并为既有对象回填 `granted` grant；`semantic-index` 步骤（v4）加入 `semantic_definitions` 与 `semantic_aliases`，定义版本和别名索引由 `spatial-catalog` 在 ACL 同事务中发布。全部为带默认值的附加列/新表，v1 行保持有效。目录 repository/API 与其事务归 `map/spatial-catalog`（见 [spatial-catalog.md](spatial-catalog.md)），schema 版本本身仍由本包的单一迁移阶梯拥有。打开时发现比当前构建更新的版本：显式拒绝（`future-schema-version`），不猜测、不降级、不静默只读。
- 迁移前先 dry-run（只读连接列出待执行步骤，不写任何字节）；写路径执行 backup-before-write（`VACUUM INTO` 一致性快照 + sha256）。
- 每个迁移步骤一个事务：DDL、`migration_journal` 行、版本号更新同事务提交；进程在任意点崩溃（含 SIGKILL），SQLite 回滚日志保证该步骤整体生效或整体消失，重跑从已提交版本继续。
- 幂等：已在目标版本时迁移是空操作。checksum：迁移报告记录前后整库文件 sha256；备份 manifest 记录逐条目 sha256。

## 备份与恢复顺序

备份内容：资源/产物文件字节、`store.db` 一致性快照、指定 Session 日志字节、manifest（manifest 版本、store schema 版本、逐条目 sha256/字节数、可选授权摘要）。发布顺序：全部条目写入 staging → 逐条目校验 digest → 原子 rename 成正式 bundle；staging 内不完整产物不是备份，按孤儿清理回收。

恢复按层执行并逐层报告状态（跨文件/数据库/会话无全局原子性，报告必须分层，见 spec §7）：

1. resource/artifact 文件字节（已存在且不同→冲突保留，绝不覆盖）。
2. `store.db`（目标无库→恢复并校验 schema 版本；同 digest→跳过；不同→拒绝，绝不覆盖活库）。
3. Session 日志（目标已有同名世代→保留现世代，绝不覆盖；恢复的是字节副本且 digest 校验）。
4. projection cache：一律不恢复，报告 `discarded-derived`（派生数据，从日志重建；`stateVersion` 不符的旧行本就会被投影丢弃）。
5. 外部作业状态：`not-covered-external`，由作业 owner 另行核对。

授权与摘要验证：manifest 携带可选授权摘要（sha256），verify/restore 必须提供匹配 token；任一条目 digest 不符即整包拒绝恢复并逐条目报告。

## 删除前提

| 目标 | 删除前提 |
|---|---|
| 已发布 resource/artifact（字节版本） | 默认保留；经显式 `releaseVersion` 终结且无任何保护边（session/map/report/export/job/backup pin、reader pin）后成为清理候选，由 `cleanup` lease 协议按既有 plan→execute 逐候选复核回收（字节先原子 rename 入 `trash/`，行与标记随后删除）；被回收版本的读取返回既有显式 missing/unavailable 语义，不回退旧版本、不由空数据替代 |
| staging 暂存 | 状态为 `released`（写入方已结束）且无 backup pin、无活动写入标记、清理执行时复核仍满足；先原子 rename 入 `trash/` 再删除 |
| 孤儿文件（`files/` 下无目录行、无 staging 行） | 同上；目录行在文件成功入 `trash/` 之后才删除 |
| 清理自身 | 必须持有 `cleanup` lease（过期视为无主）；两个清理者并发时后者拒绝（`lease-held`） |
| 整个会话库（`sessions/<sessionId>/`） | 只经显式 `dropSessionStore(root, sessionId)`：会话结束不触发、无任何自动路径；先原子 rename 入根级 `trash/` 再删除（link 形态只 unlink 不跟随）；库不存在时 `missing-session-store` 拒绝 |

并发约定：活动写入以 staging 行 `active` 状态与 pin/lease 表达；清理执行阶段对每个候选重新核对（plan 与 execute 之间加入的 pin/活动写入会让该候选跳过），防止以过期计划删除新受保护对象。已发布版本同一复核覆盖 reader pin：读者先 `acquireReaderPin` 后使用、用毕 `releaseReaderPin`；所有者以 `releaseVersion` 显式终结（设计 §6.4「先 pin 后使用、终结后释放」）。会话关闭不触发任何回收，也不等于释放引用——保护边存于库内，只有显式 drop 或释放才消失。schema v5 新增 `reader_pins`/`released_versions` 两表（monotonic 迁移，backup-before-write 前置）。

## 诊断与失败语义

| 状态 | 含义 | 后续 |
|---|---|---|
| `missing-file` | 目录行引用的文件不存在 | 该条目 unavailable；恢复时逐层报告 |
| `digest-mismatch` | 字节与登记摘要不符 | 拒绝按该版本读取；不静默替换 |
| `permission-denied` | 文件/目录模式变化导致不可读 | 报告条目与 errno；不重试绕过 |
| `future-schema-version` | 存储版本比构建新 | 打开即拒绝，指向可迁移的构建 |
| `lease-held` | 清理/写租约被他人持有 | 调用方稍后重试或接管（租约过期后） |
| `restore-conflict` | 恢复目标已有不同字节/活库 | 保留现状，要求显式清理后重试 |

## 运维 runbook

以下演练是本包验收的固定脚本（`map/spatial-storage/tests/` 逐条钉住）；实际操作按同一顺序调用 `@map-harness/spatial-storage` 的公开函数，不另设 CLI 入口。

**迁移升级（schema vN → vN+1）**：

1. `dryRunStoreMigration(dbPath)` 列出待执行步骤——只读连接，零写入。
2. `migrateStore(root)`：自动 backup-before-write（`backups/pre-migration-v<N>-*.db`，逐字节校验自身 digest），每个步骤单事务提交并写 `migration_journal`。
3. 失败处理：步骤抛错或进程崩溃（含 SIGKILL）时该步整体回滚，store 停在最后提交版本；修复步骤清单后重跑，从记录版本继续。手工恢复 = 停写 + 用 `backups/` 快照替换 `store.db`。
4. 打开即报 `future-schema-version`：升级构建，不对 store 降级。

**备份**：`createBackup(root, db, { sessions, authorization? })`。bundle 经 staging 自校验后原子发布到 `backups/<bundleId>/`；manifest 含 store schema 版本、逐条目 sha256/字节数、可选授权摘要。staging 残留（中断的备份）不是备份，由清理回收。

**恢复演练**：`verifyBackup(bundlePath, { authorization? })` 全绿后 `restoreBackup(bundlePath, targetRoot, { authorization? })`。报告逐层核对：files（restored/kept-identical/conflict-kept-existing）→ database（schema 版本回读）→ sessions（字节副本 digest 相等，绝不覆盖既有世代）→ projection-cache（discarded-derived，从日志重建）→ external-jobs（not-covered-external，作业 owner 另行核对）。恢复到全新位置后跑 `verifyStore(newRoot)` 应全部 ok——引用是相对路径，位置变化不破坏可解析性。

**清理周期**：`acquireLease(db, { scope: 'cleanup', owner, ttlMs })` → `planCleanup(root, db)` 审阅 dry-run → `executeCleanup(root, db, plan, { leaseId })`。执行对每个候选重新核对 pin/active-write/claim 变化；`releaseLease` 收尾。两个清理者并发时后者 `lease-held` 拒绝，过期租约可接管。

**已发布版本回收**：`releaseVersion(db, { kind, id })` 显式终结（仅 resource/artifact 字节版本；`unsupported-gc-target`/`unknown-target` 具名拒绝）→ 读者侧 `acquireReaderPin`/`releaseReaderPin`（先 pin 后使用）→ `collectGarbage(root, db, owner, ttlMs)` 一次完成 lease→plan→execute→release；`planCleanup` 的 dry-run 同样列出 released 候选（`published-version` 条目，保留原因 `pinned`）。`doc-sync` 门禁约束文档与实现一致：回收候选类、拒绝码与测试断言同源（`map/spatial-storage/tests/gc.spec.mjs`）。

**定期核验**：`verifyStore(sessionStoreRoot(root, sessionId))` 逐库分层报告 missing-file/digest-mismatch/permission-denied/not-regular-file；报告只读，恢复决策由运维依据报告做出（P0 不自动删除任何已发布条目）。一个库的损伤只标记该库的报告，不影响邻居库。

**会话库运维**：`listSessionStores(root)` 从 `sessions/` 目录只读派生清单（含每库是否已有数据库文件；模式外/外来条目跳过且不删除）。保留策略为默认全保留；确认废弃的会话库经 `dropSessionStore(root, sessionId)` 显式删除（唯一整库删除路径，无模型可见工具暴露）。升级部署遗留的根级旧共享库 `<root>/store.db`：插件 load 时 warn 一次，不读、不删、不迁移。
