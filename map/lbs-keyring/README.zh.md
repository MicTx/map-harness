---
description: "LBS 密钥池：逐 key 状态与按次序、轮换、随机三种使用模式。"
kind: package-reference
---

# @map-harness/lbs-keyring

[English](README.md) | 中文

Map Harness 的 LBS 密钥池：每家供应商一组有序凭据引用、逐 key 状态，以及决定下一次请求由哪个 key 承担的使用模式。

## 摘要

本包拥有一个池结构与值自由状态的设置命名空间（`map-lbs-keyring`），以及一个经凭据 seam 选取已配置 key 的宿主服务（`lbsKeyring`）。密钥值不进入设置文档、状态投影、错误或日志。浏览器设置页、可达性 run、在线检索与底图激活读取同一策略。

## 使用本包

### 何时选择

部署需要每家多个 LBS key、需要平摊配额，或需要查看当前由哪个 key 服务时选用。未配置池的部署保持每家原有单一凭据引用。

### 数据归属

| 数据 | 归属 | 线路路径 |
|---|---|---|
| 池结构：模式、有序槽位、启用标记、标签 | 宿主设置命名空间 | `settings.describe` / `settings.mutate`，经 `configForms` |
| 单个槽位的密钥值 | 凭据 seam | `credentials.set` / `credentials.unset` / `credentials.describe` |
| 使用状态：结局码、冷却、使用次数、最近使用 | 宿主设置命名空间 | 已转发的 `settings/document-updated` |
| 单次操作选中的值 | 宿主服务内存 | `lbsKeyring.select(vendorId)` |

每家首个槽位沿用原有引用（`TIANDITU_API_KEY`、`AMAP_API_KEY` 等），新增槽位使用 `TIANDITU_API_KEY_2` 一类编号引用。槽位引用保持稳定：重排不重新分配引用，删除槽位不给其余槽位重新编号。

### 使用模式

| 模式 | 选取方式 |
|---|---|
| `priority`（按次序） | 始终优先最早的已启用且已配置槽位，仅在其无法服务时后退。默认值，与旧单 key 行为一致。 |
| `round-robin`（轮换） | 每次选取沿持久化的游标推进到下一个合格槽位。 |
| `random`（随机） | 每次选取在合格槽位中均匀随机。 |

停用、未配置与冷却中的槽位会被跳过。`rate-limited` 或 `permission-denied` 结局使对应槽位进入冷却，`success` 结局清除冷却。没有槽位可服务时，消费方回退到原有单引用解析。

## 服务契约

`createLbsKeyring(deps)` 在注入的 settings、credentials 与时钟面上构建服务。`select(vendorId)` 解析一个值并持久化新游标与使用次数。`report({ vendorId, slotId, outcome })` 更新冷却健康。`document()` 每次读取都在持久边界校验文档。纯模块 `contract.ts` 与 `policy.ts` 不含 I/O，可由浏览器半导入。

## 测试

`pnpm --filter @map-harness/lbs-keyring run test` 覆盖引用语法与上限、文档校验、各选取模式、冷却转换、隐式单 key 兼容，以及持久状态中不含密钥值。

## 已知限制与后续工作

厂商侧密钥有效性探测不在范围内：本包只对消费方上报的结局分类，不自行调用厂商端点。运行时健康是由上报结局推导的冷却状态，不是独立的健康检查。
