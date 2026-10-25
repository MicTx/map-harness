# 空间观测运维（spatial-observability）

English name: **Spatial observability and operations**. 包标识 `@map-harness/spatial-observability`，方法契约 **`spatial-observability@1`**。纯库，无 host 行；消费方是采纳 correlation scope 的 map 自有面（tools、provider adapter、catalog、run service、render 平面）、本包门禁 lane（`node map/bin/test.mjs`）与本文的 runbook 诊断流程。

## 1. 契约要素

### 1.1 关联身份（correlation）

一次操作的完整身份：

| 字段 | 形态 | 说明 |
| --- | --- | --- |
| `operationRef` | `op:<domain>:<sessionId>#<sourceCallSeq>` | 授权域 + Session 调用身份（设计 §6.4；request digest 是独立的一致性校验，不入身份） |
| `runId` | 可选 | durable run 标识（`run_submit` 交付的作业引用） |
| `goalRevision` | 可选 | 决策帧目标 revision |
| `traceId` | `trace-` + 16 hex（高基数） | 跨工具/产物/Session/render 跟踪；只进日志与 trace payload |

`ObservabilityRuntime.scope(input, body)` 经 `AsyncLocalStorage` 传播身份：嵌套 scope 继承父 scope 的 `traceId`（一次操作一条 trace），`operationRef` 逐调用更新。所有日志记录、审计事实与故障注入记录自动携带当前 scope，无需逐层穿参。

### 1.2 结果词表与错误码

结果（closed，六值）：`succeeded` / `partial` / `failed` / `cancelled` / `outcome_unknown`（无法判定结算——例如 worker 死后无记录）/ `degraded`（交付但能力或遥测可见降级）。结果永不默认；`failed`/`degraded` 结算必须携带错误码。

错误码（closed，版本化；增改即契约版本变更）：`FLUSH_FAILED`、`ARTIFACT_PUBLISH_FAILED`、`PROVIDER_RATE_LIMITED`、`PROVIDER_UNAVAILABLE`、`WORKER_CRASHED`、`RENDER_FAILED`、`CATALOG_LAGGING`、`CATALOG_UNAVAILABLE`、`TELEMETRY_DEGRADED`、`OPERATION_CONFLICT`。错误码是机器协议，日志文本只是辅助（设计 §6.5）。

### 1.3 低基数指标

指标名、标签键、标签值全部来自闭表（`OBS_METRICS`/`OBS_METRIC_LABEL_KEYS`/plane/segment/outcome/code/provider/kind）；每个指标声明的标签键**必填**。每个指标的基数由闭表天然封顶（最大组合 = 各词表笛卡尔积），超界即响亮拒绝——载荷值、operationRef、traceId 进入标签是代码缺陷，必须在采样器处失败而不是污染外部监控系统。

分段词表（设计 §13.3 测量点）：`context`/`mcp`/`compute`/`commit`/`flush`/`render`/`scan`/`cancel`。计数器覆盖 operations、flush/artifact-publish/render 失败、provider 调用与限流、故障注入、遥测自弃。

### 1.4 脱敏

凭据承载键（`token`/`secret`/`credential`/`password`/`apiKey`/`authorization`/`cookie`/`privateKey` 等，大小写不敏感子串匹配）→ `[redacted:<key>]`；几何载荷键（`geometry`/`coordinates`/`features`/`geom`/`raster` 的对象/数组值）→ `{ obsRedacted: 'geometry' }`；绝对文件系统路径（POSIX/Windows）→ `<path>`；深度/数组越界显式截断标记。每次抑制都出现在返回的 `redactions` 列表——脱敏可见，绝不静默。日志、诊断导出全量过同一 sanitizer。

## 2. 日志采样与遥测自健康

- `warn`/`error`/`audit` **永不参与采样**；`debug`/`info` 按 keep-1-in-N（`sampleEvery`，默认全保留）。
- 缓冲固定容量；溢出按类别精确计数（sample/audit 分列）并置 `degraded`。
- sink 抛错被捕获并按类计数，绝不向调用方传播。
- `runtime.telemetryHealth()` 返回逐类精确丢弃数；`runtime.reportTelemetryHealth()` 将其折叠进 `process` 健康平面（降级为持续事实：本轮发生过丢弃就如实报告）。
- 遥测自身失败只计数，绝不阻塞空间主结果（spec §7）。

## 3. 健康平面

六个平面独立报告（`process`/`provider`/`catalog`/`run`/`data`/`render`），状态 `ready`/`degraded`/`unavailable`；readiness 是**派生**聚合，`heldBack` 按 unavailable→degraded 列出拖延平面——不用一个 boolean 掩盖部分故障（spec §2.4）。每次状态翻转进入有界迁移史并写入审计日志；同状态重报刷新 detail、清陈旧 code、不算迁移。

## 4. 故障注入矩阵与恢复

闭表注入点（默认码 → 健康平面）：

| 注入点 | 默认码 | 平面 |
| --- | --- | --- |
| `flush` | `FLUSH_FAILED` | data |
| `artifact-publish` | `ARTIFACT_PUBLISH_FAILED` | catalog |
| `provider` | `PROVIDER_RATE_LIMITED` | provider |
| `worker` | `WORKER_CRASHED` | run |
| `render` | `RENDER_FAILED` | render |

`arm(point, { times, code, message })` → `hit(point, invoke)` 在武装时抛 `ObsFaultError`（真实调用不执行），计数耗尽自动解除；`hit` 在未武装时透传真实调用（原始异常原样重抛）。注入 → 失败 → 解除 → **同调用点重放成功** = 确定性恢复序列；每次注入、每次恢复后的成功结算都带 correlation 进入审计轨迹。runtime 的 `hit` facade 自动附加 ambient correlation；`reportFault` 记录注入计数与错误事实，操作结算分类由 `reportOutcome` 单独负责（不重复计数）。

## 5. 诊断导出

`runtime.exportDiagnostic({ maxBytes })` 输出有界 JSON：方法版本、readiness/迁移史、指标汇总、故障矩阵记录、关联索引（最近 256 个操作）、日志尾部、遥测丢弃计数。字节预算按优先级截断：**audit 类日志先入**，截断只吃 `debug`/`info` 量，被裁条数精确计入 `truncatedRecords` 并折算 `obs_telemetry_dropped_total{kind: export}`。整个文档过 sanitizer——凭据/路径即使到达任何分节也到不了文件。

## 6. Runbook（故障响应手册）

### 6.1 重试

1. 从错误结果或审计日志取 `operationRef`/`runId`；`parseOperationRef` 还原 domain/session/sourceCallSeq。
2. 判类：`PROVIDER_RATE_LIMITED` → 退避后以**同一操作身份**重发，服务端按已发布记录幂等返回（设计 §6.4：retry 只复用已发布产物，缺记录不盲算）；`PROVIDER_UNAVAILABLE` → 查 §6.2 健康面，恢复后重试；`FLUSH_FAILED`/`ARTIFACT_PUBLISH_FAILED` → **逻辑接受状态有效**，只补持久化/发布步骤，不重跑计算。
3. `WORKER_CRASHED` 且无结算记录 → 按 `outcome_unknown` 处理：先查 run 记录确认无已提交产物，再以新操作明确本次输入重放；禁止把崩溃伪装成成功。
4. 同一身份不同参数 → `OPERATION_CONFLICT`，拒绝盲重发（审计 D07/C01）。

### 6.2 查询（诊断入口）

```js
runtime.telemetryHealth()            // 遥测自弃逐类计数（process 平面是否降级）
runtime.health.readiness()           // 六平面状态 + heldBack 列表
runtime.health.of('catalog')         // 单平面（如 CATALOG_LAGGING 的 lag detail）
runtime.health.transitions()         // 迁移史：ready->degraded->ready 全弧
runtime.faults.injections()          // 注入审计（point/code/remaining/correlation）
runtime.exportDiagnostic({ maxBytes })  // 一次性打包以上全部 + 日志尾部 + 关联索引
```

同一操作跨平面追踪：导出文档 `operations[]` 按 `operationRef` 索引，`logCounts` 按层给出记录数；日志记录自带全套 correlation 字段。

### 6.3 回滚 / 补偿

- flush 失败：接受态保留（不报告 durable）；重放只重试持久化 barrier。
- artifact 发布失败：无产物可见；重放走 `artifact-publish` 点，成功前不存在"半发布"状态。
- render 失败：数据结果有效，render 平面单独 degraded；重放只重做显示派生。
- 操作级补偿（撤销已接受变更）属于 collaboration 平面的 compensating-undo 职责（`spatial-collab@1`），本包只提供审计轨迹与迁移史作为补偿依据，不重复实现补偿引擎。

### 6.4 清理

故障注入是测试/演练设施：演练结束后 `faults.resetAll()` 确认 `armedPoints` 为空（诊断导出 `faults.armedPoints` 应为 `[]`）。注入记录与审计日志随运行缓冲有界化（默认 256/1024 条），无独立清理面；诊断导出按 `maxBytes` 用后即弃，不落盘累积。

### 6.5 升级条件

- `process` 平面 degraded（`TELEMETRY_DEGRADED`，丢弃计数 > 0）：演练性丢弃可接受；生产持续增长 → 升级（sink/容量配置问题）。
- `provider` unavailable 跨越一次退避重试仍不恢复 → 升级到 provider 运维。
- `catalog` unavailable（非 lag）→ 停写升级；`CATALOG_LAGGING` 持续扩大 → 升级并冻结依赖最新投影的读路径。
- `run` 平面 `WORKER_CRASHED` 重复出现 → 取证导出（§6.2）后升级，不以重放掩盖崩溃率。

## 7. 验证

| 层 | 证据 |
| --- | --- |
| unit | `map/spatial-observability/tests/contract.spec.mjs`（六结果 fixture、身份文法、闭表拒绝）、`tests/sanitize.spec.mjs`（凭据/几何/路径脱敏、可见抑制）、`tests/instrument.spec.mjs`（分段延迟/字节/队列/flush/render/provider 指标、跨平面 correlation、有界索引） |
| integration | `tests/correlation.spec.mjs`（真实 Session 投影 + 真实 JSONL flush barrier + 真实 SQLite 目录：一次操作全平面关联、导出可查询、无宿主路径泄漏）、`tests/health.spec.mjs`（provider unavailable/catalog lag/render failed/telemetry dropped + 恢复弧 + 有界截断导出）、`tests/faults.spec.mjs`（五点注入、N 次耗尽自动解除、同点重放恢复、outcome_unknown、限流计数） |

命令：`pnpm --filter @map-harness/spatial-observability run test`；聚合 lane 见 `map/bin/test.mjs`。
