# 空间协同：串行提交、冲突差异与补偿撤销

English page: see the slot row in [../README.md](../README.md); this page is the design contract for the collaboration plane (设计 §11.3，spec 包 `2026-09-24_add-spatial-collaboration`)。

## 1. 模型选择：单服务器串行提交

多人/多写者地图编辑采用**单服务器串行提交**：权威状态是一个进程内的 `mapContainer` projection，fold 是唯一串行提交段——`targetRevision` CAS 与变更接受在同一个同步 `settleMapResult` 调用内完成，任何并发写者都无法在检查与接受之间插入。本包**不伪称**分布式 CAS、CRDT 或跨进程事务；吞吐不足时按设计 §11.3 转入大规模包单独评估。

- 写者身份（`writerId`）由宿主解析：工具调用经可信 ToolExecution 绑定会话；显式写者（多客户端/多 occurrence 操作台）经 `ctx.spatialCollab.join` 登记。模型参数不能选择任意会话，只能引用本会话已登记的写者。
- `expectedRevision` 是乐观并发读：调用方声明自己基于哪个 revision 提交。handler 段与 fold 段双重校验，任何一段不匹配都拒绝。

## 2. patch：条件操作与可解释冲突

`map_apply_patch` 接受 1..8 个有序条件 op，整包原子生效（一次 revision）。`patch` 是模型面 `type:'json'` 参数，已解析数组与 JSON 字符串两种形态都可调；畸形字符串以 `INVALID_ARGUMENT` 点名 `patch`，解码成功后仍走既有 patch 校验：

| op | 载荷 | 期望（expect） |
|---|---|---|
| `upsert-layer` | 图层载荷 + 内容 digest | `digest`（当前内容）、`absent`（删除冲突守卫） |
| `remove-layer` | layerId | `digest` |
| `reorder-layers` | 完整层序 | `order` |
| `set-view` / `set-mode` | 视图/模式值 | `viewDigest` / `mode` |
| `set-style` | 逐层样式或 `null`（清除） | 逐层 `digest` |
| `set-aoi` | AOI 环或 `null` | `aoiDigest` |

冲突是**成功结果里的具名状态**（不是异常）：`stale_revision`、`layer_missing`（删除不再自动重放）、`layer_digest_conflict`（同层更新过期）、`layer_present`、`order_conflict`、`view_conflict`、`mode_conflict`、`aoi_conflict`。冲突响应携带逐 op 原因与当前文档面（层 id + digest）；服务器**绝不**把旧 patch 改写到新基线上，客户端显式重读重判。

**幂等**：`operation_id` 是客户端幂等键。重复提交返回首次结果（`duplicate`），不二次应用；fold 侧对已入账本的 operation id 只记 `duplicate-op` 只读诊断（防御日志重放/重提）。

## 3. 撤销：新补偿 revision

`map_undo` 把已记录操作的**逆变更**作为全新 revision 提案（fold 在接受每个变更时计算逆与 post-state，写入有界操作账本 `MapOperationRecord`，上限 32 条 = 撤销视界 + 幂等窗口）：

- 不带 `undo_of`：从最新操作向回走，跳过撤销记录与不可逆操作（redo 用 `undo_of` 指向撤销记录显式完成）。
- 目标判定（`checkUndoTarget`）：`matched`（效果仍在，可补偿）、`already-undone`（效果已不在）、`changed`（受影响切片被并发修改——冲突拒绝而非覆盖）。
- **原始历史保留**：撤销只追加，不改写会话日志；审计（写者、operation id、undo 链）随 projection 恢复逐位重放一致。
- **外部副作用不回滚**：已发布产物、文件、LBS 作业不受撤销影响，工具输出明示这一点；本包不伪称跨资源事务。

## 4. 写者生命周期

`ctx.spatialCollab`（`@map-harness/spatial-collab` 宿主 plugin）按会话维护写者 lease：

- `join` → `active`；`disconnect`（transport close）→ 新提交立即拒绝（`WRITER_OFFLINE`），身份保留；`reconnect` → 恢复写入。
- `setPermission(writer, false)` → 权限撤销，提交拒绝（`WRITE_PERMISSION_DENIED`），双向显式。
- `release(writer)` 先拒绝新提交，再等待该写者全部 in-flight gate 关闭（真实静止，非定时器），最后移除身份；plugin dispose `quiesce()` 等待全部写者静止。
- 写者是进程内租约：宿主重启后写者重新 join；文档与审计从会话日志恢复，二者一致。

## 5. 地图协议落点

- `MAP_META_SCHEMA_VERSION` 3 → 4：v4 meta 携带可选 `operationId`/`undoOf`/`writerId` 与三个新变更 op（`patch`、`reorder-layers`、`set-aoi`）；v1–v3 记录照常解码，旧版本构建对 v4 记录只读拒绝。
- `MAP_PROJECTION_STATE_VERSION` 5 → 6：状态新增 `aoi` 与 `operations` 账本，旧缓存行弃用后从原始日志重放。
- 浏览器 occurrence 渲染 AOI 轮廓；Workbench 呈现操作历史（只读审计面）；`map_get_state` 输出 revision、逐层 digest、AOI 与最近操作（`expected_revision`/undo 目标的读取源）。

## 6. 验证

- `pnpm --filter @map-harness/spatial-collab run test`：契约 fixture（同层更新/删除/排序/重复 patch）、引擎（CAS/冲突/幂等/并发 barrier/undo verdict）、生命周期（静止/权限/dispose）。
- `pnpm --filter @map-harness/map-tools run test`：`collab-tools.spec.mjs` 走真实会话 store + projection + 双 plugin 的端到端提交协议。
- `node map/bin/test.mjs`：全聚合（含 Loader `--dump-config` 组合 smoke 的 `spatial-collab` 行断言）。
