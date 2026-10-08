# 空间资源目录（spatial-catalog）

本文是 P0b 版本化数据链和语义索引的运行时权威文档：`@map-harness/spatial-catalog`（`map/spatial-catalog/`）拥有的事务化目录 API、身份模型与发布顺序；模型可见的 `catalog_register`/`catalog_resolve` 工具与 `map_save` 的跨存储顺序归 `map/tools`（错误码与工具面见 [arcgis-mcp.md](arcgis-mcp.md)）。物理存储（每会话独立 `store.db` schema 版本、`files/`、`staging/`、备份/清理）归 [storage-lifecycle.md](storage-lifecycle.md) 与 `@map-harness/spatial-storage`。设计依据是 `.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md` §6.2/§7.2/§8/§15.4 与审计 D03/D07/D08。

## 职责边界

| 层 | 拥有物 | 不做的事 |
|---|---|---|
| `spatial-storage` | store 根布局与每会话库布局（`sessions/<sessionId>/`）、单调 `SPATIAL_STORE_SCHEMA_VERSION`（当前 v3，含 feature_refs/semantic_bindings 与治理表）、逐库迁移/备份/校验/清理与会话库清单/显式删除机制 | 不解释资源语义，不做目录决策 |
| `spatial-catalog` | 目录 repository API 与事务、资源版本/featureRef/RetrievalBundle/产物身份、发布意图（intents）、发布配对 projection、`spatialCatalog` host 服务（进程级路由 + `forSession(sessionId)` 会话视图） | 不读工作区路径（字节由工具边界送入）、不做 CRS 数值变换、不折叠地图状态 |
| `map/tools` | `catalog_register`/`catalog_resolve`/`map_save` 工具面、geo 工具 `ref` 分支、显示副本组装（WGS84 收敛 + displayDigest + 最小图例） | 不绕过目录直接写 `files/`，不把绝对路径交给模型 |

依赖方向固定：`tools → spatial-catalog → spatial-storage`（`map/tests/topology.spec.mjs` 拦截反向）。

## 身份模型

- **资源版本**：`catalog_register` 把源字节复制进受控 `files/`，对实际字节计算 `contentDigest`（sha256），并发布一行 `catalog_resources`。逻辑资源 `res-<id>` 由显式 `name` 确定性派生（同名再登记 = 新版本，v1、v2… 永不互删）；未命名登记生成新 id。模型只见精确 ref `res-…@vN`——目录新 head 不使旧版本失效。
- **featureRef**：登记时对每个 feature 计算 `f-<sha256(canonical JSON)[0:16]>`——同一字节永远得到同一组 featureRef（跨登记可复现），原始 `id` 保留在 `original_id`。geo 工具的 `ref` 输入必须显式给出 featureRef，绝不隐式取首项。
- **RetrievalBundle**：`catalog_resolve` 对一次授权解析冻结 resourceRef、contentDigest、schemaDigest、语义绑定版本、transformVersion（WGS84 族为 `identity`，投影 CRS 为 `proj4:<digest>`）、catalogReadPoint（读取观察点，非全局失效键）与 authorizationVersion。
- **语义定义**：`registerSemanticDefinition` 在同一会话库中递增 `definitionId` 的版本，保存 canonicalName、aliases、definition、applicability、sourceRef、reviewStatus，并与 `def-<id>@vN` 的 semantic ACL 在同一事务发布。绑定到资源前必须存在且与资源授权域一致。
- **语义检索**：`catalog_resolve` 的 `query` 分支按 canonicalName/alias/关键词与 applicability 过滤，先过滤授权再返回最多 32 个最新版本候选；`resource` 分支额外返回绑定定义的完整内容。两者互斥，不新增 `semantic_register` 或逐条翻页工具。
- **产物（artifact）**：`geo_buffer` 的 ref 分支把缓冲结果作为不可变产物发布：`art-…@vN`、inputRefs（`res-…@vN+f-…`）、方法与参数摘要、analysisCrs、内容摘要。产物授权继承输入的最小权限。

## 发布事务顺序

1. 工具边界：工作区准入（containment/no-follow/字节上限）+ CRS 构造校验（`assertCrsSupported`，未建表 EPSG 在此拒绝）+ 取消检查。
2. 暂存：写 `staging/` 专属文件（`wx`、0600），对暂存字节复核 digest。
3. 事务（`BEGIN IMMEDIATE`）：rename 进 `files/` → 写 `catalog_resources`/`feature_refs`/`artifacts` 行 → 写 `intents` 发布记录 → COMMIT。崩溃窗口只留下可回收的孤儿字节，绝不留下指向缺失文件的目录行。
4. 可查询确认：COMMIT 后回读版本行；读不到即 `CATALOG_IO`。

操作身份 `operationRef = op-<sha256(kind:sessionId:callSeq)>`：同一操作重复发布返回原对象（`deduplicated: true`），同身份不同输入报 `CATALOG_CONFLICT`。`retry_of` 参数引用本 Session 原调用 seq：只查 intents 取回已发布对象——**不重读 path、不重算**；缺记录报 `CATALOG_OPERATION_NOT_PUBLISHED`。发布调用与 callSeq 的配对由 `spatialCatalog` projection 的 pending 表提供（与 `mapContainer` 同纪律：无 accepted `tool/call` 的直接执行拒绝发布）。

## 授权与预算

- 授权治理（`spatial-governance@2`，权威文档见 [spatial-governance.md](spatial-governance.md)）：部署域由 Config `authorizationDomain` 声明（默认 `local`），部署租户由 `tenant` 声明（默认 `default`，多租户部署用 `tenants` 注册表）；每个资源/语义绑定/产物在发布事务内取得显式 ACL grant（租户键控行），`revoke`/`tombstone` bump grant 版本并拒绝未来 resolve/read/execute/save（错误文本携带副本不召回的 copy-limit 说明），resolve/字节读/持久确认在服务层判定并审计，repository 层 `assertGranted` 兜底；解析缓存键含租户、授权域与 grant 版本；产物授权按敏感度格派生输入的最小权限（`local < sensitive`）。未授权/未知 ref 维持 `CATALOG_NOT_FOUND`（不泄露存在性），跨租户读取同答非泄露拒绝；过滤发生在任何模型可见片段生成之前。授权字节离开存储的每个地址登记副本（`context`/`display`/`export`/`fork` 四通道，幂等有界），Host 平面 `recallCopies` 按对象/租户范围召回：逐副本审计、失效缓存、后续使用被具名拒绝（`GOVERNANCE_RECALLED`，文案含不擦除边界句）。
- 预算：单文件 32 MiB、要素 10k、坐标 100k、meta 64 KiB；`maxStoreBytes`（部署 Config，profile 未设即不限）超限报 `CATALOG_STORE_FULL` 并保留旧状态；投影累计预算与图层/单变更上限见 `map-container` protocol。

## map_save 的跨存储顺序

`map_save` 固定当前 accepted prefix（含自身 `tool/call`，`durableThroughSeq = session.seq - 1`）→ 对图层引用的 catalog 对象逐个确认（文件在、digest 合、行已发布）→ `ctx.sessions.flush(session)`。三个阶段独立报告；任何阶段失败返回 `saved: false` 且 accepted 状态不变，回执只覆盖固定前缀、绝不包含尚未追加的 save 结果本身。map_save 不是跨存储原子提交，也不伪称其一。
