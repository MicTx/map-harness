# 空间敏感数据治理与授权（spatial governance）

本文是 map 层敏感数据治理的权威文档：`@map-harness/spatial-catalog` 拥有的授权域、部署租户、ACL grant、派生权限继承、审计 trail、授权域隔离缓存、副本登记与召回，以及各消费入口的拒绝语义。设计依据是 `.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md` §6.2/§7.2/§15.4（「ACL 在候选与片段生成前过滤，读取与执行再检查」「派生项继承限制，缓存键包含授权域/版本」）与审计 D06（权限主体来自 Host/provider，不来自模型参数或 MCP annotation）。契约版本 `spatial-governance@2`（`map/spatial-catalog/src/governance.ts`）；`@1` 语义全部保留——不声明租户的部署运行在默认租户 `default` 下，行为与既有用例一致。

## 模型与不变式

- **主体（subject）来自 Host/provider**：`GovernanceSubject` 只在宿主代码中构造（进程内执行统一使用 `HOST_SUBJECT`）；模型参数、工具参数、MCP annotations 一律不作为主体或权限依据。`catalog_register` 的 `authorization` 参数与本部署域不符时以 `INVALID_ARGUMENT` 拒绝——发布域是部署决策，不被静默改写。
- **授权域**：部署域由 catalog 插件 Config `authorizationDomain` 声明（默认 `local`）。派生权限排序使用固定敏感度格 `local < sensitive`（协议常量，非配置）：混合输入派生最严域；含未入格域的混合输入 fail loud（`GOVERNANCE_DOMAIN_UNKNOWN`）；单输入域恒等派生（单自定义域部署无需排序）。派生永不放宽。
- **ACL grant**：每个受保护对象（`resource | semantic | artifact | session | export`）在其自身域与其部署租户下有一行 `governance_acl`（主键 `(tenant, object_kind, ref, domain)`），状态 `granted | revoked | tombstoned`，`grant_version` 单调递增（同状态写是 no-op）。发布事务内 `INSERT OR IGNORE` 写入初始 grant——重放发布不会复活管理员撤回的状态。一个租户内的状态转换不触及其他租户的同名 ref 行。
- **撤权 / tombstone / 不可用分别表达**：`revoked` = 撤权（未来访问拒绝）；`tombstoned` = 显式不可用标记；两者都是 denial，错误文本都携带 copy-limit 说明：**撤权只阻止未来访问；已进入 Session 日志、报告、导出和客户端设备的副本不会被远程召回或擦除**（`COPY_LIMIT_NOTE`）。产品文案不得出现即时擦除或召回承诺。
- **不泄露存在性**：无 grant 行与未知 ref 同样回答 `CATALOG_NOT_FOUND`（治理层只在 revoked/tombstoned 时给出具名拒绝）；跨域读取维持 `CATALOG_NOT_FOUND`。
- **部署租户**：一个 catalog 部署（进程内的所有会话库）属于一个租户，由 Config `tenant` 声明（默认 `default`），多租户部署用 `tenants` 注册表声明全部可询问租户。租户 id 语法 `^[a-z0-9][a-z0-9-]{0,63}$`；未声明或语法非法的租户输入 `GOVERNANCE_INVALID_INPUT` fail loud（配置错误不是拒绝）。会话库整体单租户：开库时发现他租户行即 `CATALOG_IO` 拒绝。跨租户读取与无行同答非泄露拒绝（`GOVERNANCE_DENIED`，同未知 ref 文案），跨租户探测不泄露存在性。
- **审计**：`governance_audit` 只追加（无更新/删除路径），每条记录主体、session、对象种类、ref、资源版本、操作、决定、原因码、域、grant 版本与租户；读接口 `auditTrail(filter)`（会话视图）有界（默认 100，上限 1000），允许/拒绝都入账。治理状态与审计 trail 随每会话独立库存放：对象 grant 只在其发布库内，一个会话的撤权不影响别的会话库内同名 ref 的对象（跨对话不共享，见 [storage-lifecycle.md](storage-lifecycle.md)）。
- **副本登记（copy registry）**：授权字节离开受控存储的每个地址在 `governance_copies` 登记（只追加，幂等于 (tenant, object, channel, holder)；每对象上限 1024，超限 fail loud 不静默丢地址）。四条通道：`context`（resolve 成功，holder = sessionId）、`display`（map_add_layer ref 分支，holder = layerId）、`export`（map_save flush 成功，holder = `checkpoint:<durableThroughSeq>`）、`fork`（forkSession，holder = 子 sessionId，登记在父库）。被召回对象拒新登记。
- **召回（recall）**：Host 平面 `recallCopies({ subject, scope, origin })` 按对象（kind+ref）或租户范围记录召回事件（`governance_recall`，只追加），对每个已登记副本逐条审计（operation `recall`，`GOVERNANCE_RECALLED`），并失效对象范围缓存。召回后下一次使用被具名拒绝（`GOVERNANCE_RECALLED` + `recalledDetail`），文案携带边界句（`RECALL_NOTE`）：召回拒绝已登记副本的后续使用；从未登记的副本不可达；不擦除任何已存在副本。撤权恢复不解除召回；召回只追加、不回滚。

## 撤权语义与边界

| 状态 | 未来读取/解析/执行/导出 | 已存在副本 | 目录行与字节 |
|---|---|---|---|
| `granted` | 允许（按域） | — | 保留 |
| `revoked` | `GOVERNANCE_REVOKED` 拒绝 | 不召回、不擦除（文案随拒绝给出） | 保留（catalog 生命周期行不动） |
| `tombstoned` | `GOVERNANCE_TOMBSTONED` 拒绝 | 同上 | 保留为显式不可用标记 |
| 已召回 | `GOVERNANCE_RECALLED` 具名拒绝（文案含不擦除边界句） | 后续使用被拒绝；已存在副本不擦除 | 保留 |

物理删除、密钥销毁、备份保留与法律留存是独立治理能力，不在 ACL 转换范围内。

## 入口矩阵（每格都有负向 fixture）

| 入口 | 检查点 | 拒绝证据 |
|---|---|---|
| 候选过滤 / 解析（`catalog_resolve`） | 服务层 `resolve` 先判定 + 审计，再走目录域过滤；成功登记 `context` 副本 | `governance-entries.spec.mjs` 撤权后 `GOVERNANCE_REVOKED`；召回后 `GOVERNANCE_RECALLED` |
| 读取（`readResourceBytes`/`readArtifactBytes`） | 服务层先判定；repository 层 `assertGranted` 兜底（防御纵深） | `governance.spec.mjs` 撤权竞态；`governance-tenant-recall.spec.mjs` 召回后读取拒绝 |
| 执行（geo/stat/viz/decision `ref` 分支） | 计算前读字节，经同一服务检查；拒绝发生在任何计算与发布之前 | `governance-entries.spec.mjs`「publishes nothing」（撤权与召回各一例） |
| 缓存 | 解析缓存键含租户（`tenant\u0000domain\u0000ref\u0000semanticRef`）且条目钉住 grant 版本；撤权 bump 版本 + 显式失效，召回失效对象范围全部条目 | `governance.spec.mjs` 缓存隔离与撤权竞态；`governance-tenant-recall.spec.mjs` 召回后缓存不复活 |
| 模型上下文 / 恢复 / fork（spatial-context 快照） | 组装时经 `refStateOf` 复查候选（词表含 `recalled`）；revoked/tombstoned/recalled 候选带各自的不可用标记（已撤权/已标记不可用/已召回）渲染，绝不静默丢弃 | `snapshot.spec.mjs` 不可用标记用例（含已召回独立标记） |
| map 显示（`map_add_layer ref`） | 显示副本组装前的字节读取经同一检查；组装登记 `display` 副本（holder = layerId） | `governance-entries.spec.mjs` 显示入口拒绝、零图层折叠、召回拒绝 |
| SDK / MCP 派发（arcgis-mcp `callTool`） | 与直连工具同一 handler、同一服务检查点 | `arcgis-mcp.spec.mjs` SDK 派发撤权拒绝 |
| 报告导出（`map_save` 回执） | `confirmDurability` 对 revoked/tombstoned/recalled 引用报告治理状态；回执 `saved: false`，原因分别带 copy-limit 或召回边界句，flush 阶段不执行；flush 成功登记 `export` 副本（holder = `checkpoint:<durableThroughSeq>`） | `governance-entries.spec.mjs` 导出回执（撤权与召回边界句独立可辨） |
| Session 对象 / fork | `authorize({objectKind:'session'})`（会话视图，查本库）；`forkSession` 跨库读父库 session grant、写子库 grant 与 `session_refs` 父指针，并在父库登记 `fork` 副本（holder = 子 sessionId）；父被撤或被召回则子被拒（召回 → `GOVERNANCE_RECALLED`）；父从未用过 catalog 则 `GOVERNANCE_DENIED`；资源可见性不随 fork 跨库继承 | `governance.spec.mjs` fork 继承用例；`session-isolation.spec.mjs` fork 不放宽资源可见性；`governance-tenant-recall.spec.mjs` 召回父对象拒 fork |
| retryOf / 恢复后重试 | `lookupPublication` 取回 ref 后的字节读取重新受检 | `governance-entries.spec.mjs` retry 入口拒绝（撤权与召回各一例） |
| 跨租户授权（`authorize` 输入 `tenant`） | 租户语法/注册表 fail loud；非本部署租户的非泄露拒绝与未知 ref 同文案 | `governance-tenant-recall.spec.mjs` 跨租户不泄露、未声明 fail loud；与召回具名拒绝独立可辨 |

上游 Session 生命周期（open/list）不由 map 层拦截；map 治理覆盖的是这些会话实际触碰敏感数据的 map 自有 seam（上述全部入口）。历史副本（已折叠进日志/投影的显示副本与快照文本）不被擦除：ACL 撤权/tombstone 不召回；显式召回拒绝其后续使用但不擦除任何已存在副本。

## 存储 schema

治理表由 spatial-storage 单调迁移阶梯 v3（`spatial-governance`）引入；该步同时为既有资源/产物/语义绑定回填 `granted` grant（升级不锁死既有访问），审计表不回填。v6（`governance-tenant-recall`）把 ACL 主键升为 `(tenant, object_kind, ref, domain)` 并按本部署租户回填既有行（不重写 grant 历史）、新增只追加的 `governance_copies`（副本登记）与 `governance_recall`（召回事件）表。v2 及以上存储在下次打开时前向迁移；新于本构建的存储拒绝打开；崩溃在步骤中间回滚整步。每会话独立库各自走同一阶梯（见 [storage-lifecycle.md](storage-lifecycle.md) 每会话独立库）。

## 配置

```yaml
- id: spatial-catalog
  name: '@map-harness/spatial-catalog'
  config:
    root: !!js dshHomePath('spatial-store')
    # authorizationDomain: local   # 默认 local；敏感部署在此显式声明
    # tenant: acme                 # 默认 default；本部署所属租户
    # tenants: [acme, beta]        # 多租户部署的全部可询问租户（须含 tenant）
```

`setObjectState`（grant/revoke/tombstone/restore）、`recallCopies`（对象/租户范围召回）与 `forkSession` 只经 Host 平面服务调用；没有任何模型可见工具暴露治理写路径。会话视图的 `registerCopy`/`copyTrail`/`recallTrail` 同样是 Host 平面表面，供 map 工具在受治理入口登记显示/导出副本。
