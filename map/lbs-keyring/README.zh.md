---
description: "LBS 密钥池：逐 key 状态与按次序、轮换、随机三种使用模式。"
kind: package-reference
---

# @map-harness/lbs-keyring

[English](README.md) | 中文

## 摘要

让部署为每家 LBS 供应商配置多个 key，并由同一策略决定下一次请求由哪个 key 承担。本包拥有 `map-lbs-keyring` 设置命名空间（池结构与值自由状态），以及经凭据 seam 解析已配置值的宿主 `lbsKeyring` 服务。密钥值不进入设置文档、状态投影、错误或日志。浏览器设置页、可达性 run、在线检索与底图激活读取同一池。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在同时提供 `settings` 与 `credentials` 的组合中挂载宿主插件；二者均可选，缺少任一服务时保持原有单 key 路径。

### 何时选择

部署需要每家多个 LBS key、需要平摊配额，或需要查看当前由哪个 key 服务时选用。未配置池的部署保持每家原有单一凭据引用。

### 最小配置

```yaml
- id: map-lbs-keyring
  name: '@map-harness/lbs-keyring'
```

| 字段 | 缺省 | 含义 |
|---|---|---|
| `vendors` | `{}` | 每家供应商的池：有序槽位、使用模式、游标与健康；空池保持原有单引用。 |
| `cooldownScale` | `1` | 结局冷却倍数，取值 `[0, 10]`。 |

两个字段都是 volatile 设置，设置页无需重挂插件即可编辑池。接受的形状由 [`src/config.ts`](src/config.ts) 定义。

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

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`createLbsKeyring(deps)` 在注入的 settings、credentials 与时钟面上构建服务。`select(vendorId)` 解析一个值并持久化新游标与使用次数。`report({ vendorId, slotId, outcome })` 更新冷却健康。`document()` 每次读取都在持久边界校验文档。纯模块 `contract.ts` 与 `policy.ts` 不含 I/O，可由浏览器半导入。

| 源码 | 职责 |
|---|---|
| `src/index.ts` | 宿主插件（`name`/`apply`/`inject`）与服务声明 |
| `src/config.ts` | volatile 设置 schema 与共享命名空间 id |
| `src/contract.ts` | 引用语法、上限与文档归一 |
| `src/policy.ts` | 无 I/O 的合格槽位与选取策略 |
| `src/service.ts` | 基于 settings、credentials 与时钟的服务 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Map-web profile 组合](../profiles/map-web/cordis.patch.yml) — 随附的挂载行与空池缺省。
- [LBS 协议升级说明](../../docs/upgrade-guide/v0.2.0-rc.2/map-lbs-protocol/guide.zh.md) — 与本池并列的 LBS 坐标、网络身份与授权变化。
- [验证矩阵](../docs/verification-matrix.md) — 本包的单元、Loader 与归属行。
- [工程参考](../docs/engineering.md) — 包清单与消费方摘要。

<a id="model-experience"></a>
## 模型体验

通过经 `lbsKeyring` 解析 key 的 LBS 检索、可达性与底图消费方间接影响模型；模型可见结果与失败归这些消费方所有。

#### KV 缓存影响

本包不组装模型请求，也不编辑请求历史；key 选取只改变消费方使用的凭据，既不会追加模型上下文 token，也不会使可复用前缀失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 厂商侧密钥有效性探测不在范围内：本包只对消费方上报的结局分类，不自行调用厂商端点。
- 运行时健康是由上报结局推导的冷却状态，不是独立的健康检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`pnpm --filter @map-harness/lbs-keyring run test` 覆盖引用语法与上限、文档校验、各选取模式、冷却转换、隐式单 key 兼容，以及持久状态中不含密钥值。

</details>
