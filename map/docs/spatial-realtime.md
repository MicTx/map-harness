# 实时流与时序更新（spatial-realtime@1）

本文是实时流能力的现行契约：版本化 `spatial-realtime@1` 方法（事件时间/到达时间/处理时间三钟分离、eventId 去重、watermark 与滚动窗口、有界迟到修订）、确定性 pull 驱动的受控流运行时（有界 intake 背压、单步配额、断线/重连、有界保留）、以及 checkpoint/物化平面（有界 checkpoint 续跑、摘要钉定的不可变窗口导出）。设计依据：[空间决策架构](../../.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md)（「实时输入需要物化窗口和版本化产物；前端播放不应逐帧触发模型」）。

## 范围与不承诺

**做什么**：受控场景资源（注册的 FeatureCollection 线序事件）上的窗口聚合/迟到修订/数据缺口物化、实时派生图层与最终物化产物的显式区分、报告引用的固定 revision。

**不做什么**：

- 真实供应商接入不在本包：唯一流源仍是用户注册的场景资源；真实 SSE/completions 供应商与多源融合由 [stream-providers](stream-providers.md) 承接（经 `advanceLive` 接缝）。
- 不做后台线程/push 通道：运行时是 pull 驱动，只在 `stream_advance` 被调用时推进——真实 push 供应商是独立发布条件。
- 不做无限内存队列：intake 缓冲、去重窗口、开放窗口数、每窗口修订账本、关闭窗口保留、checkpoint 字节全部有界；超界具名拒绝或显式驱逐计数，不静默丢弃。
- 不逐事件唤醒模型：运行时没有按事件回调的通道，一次 advance 只产生一份有界汇总。
- 无限保留原始流不在本包（会话日志自身是完整历史；物化导出是可引用的固定产物）。

## 时间语义（三钟分离）

| 时钟 | 来源 | 用途 |
|---|---|---|
| eventTime | 事件自带（源域时钟），`event_time_ms` | 窗口归属与 watermark 的唯一依据 |
| ingestTime | 运行时准入时刻（调用者供给，确定性） | 到达时间观测；不参与窗口计算 |
| processTime | 每次 advance 的调用者供给时刻 | 处理时间观测；`lagMs = lastProcess − maxEventTime` 是可见延迟 |

wall-clock 永不进入状态机：三个时间全部由调用方供给，任何运行与测试都可复现。

## Watermark 与窗口

- watermark = `maxEventTime − allowedLatenessMs`（准入时刻更新；去重命中的重复不更新）。
- 窗口：按 eventTime 的翻滚窗口 `[k·windowMs, (k+1)·windowMs)`；watermark 越过窗口末即关闭。
- 关闭即产生 revision 1；窗口内的迟到事件**追加** revision N+1（不改动旧 revision，`maxRevisionsPerWindow` 有界，超出具名丢弃计数）。
- 观测跨度内没有事件的窗口物化为 `empty` 数据缺口（携带 count=0 的 no-data revision）——缺口可见、不插值、渲染时无要素。
- 窗口状态：`open`（未关闭）/ `closed`（关闭）/ `revised`（迟到修订过）/ `empty`（缺口）。
- 关闭窗口保留有界（`maxOpenWindows + 64`），最旧者驱逐并计数；会话日志保留完整历史。
- 每个修订的摘要 `windowRevisionDigestOf(startMs, endMs, revision, aggregate)` 是导出与报告引用的身份：内容相同 → 摘要相同，内容变化 → 新摘要、新 revision。

## 去重、背压、断线、限速

- **去重**：首次见到的 eventId 记入有界去重窗（FIFO 驱逐）；重复计数并丢弃，永不二次入聚合（至少一次投递 + 事件 id 去重）。
- **背压**：intake 缓冲有界（`bufferCapacity`）；满时源被按住（`heldByBackpressure` 计数），事件留在源端等下一次 advance，而不是丢弃或撑大内存。
- **限速**：`maxEventsPerAdvance` 配额限定单步处理量；慢消费者使缓冲积压、源被按住（`rateLimited` 置位），处理永远跟不上也不会失控。
- **断线/重连**：场景批次携带 `offline: true` 表示该批次源断开（不释放任何事件，计数 `offlineBatches`）；下一批次即重连，至少一次重投递表现为重复 id，由去重吸收。
- **开放窗口上界**：`maxOpenWindows` 满时处理在具名条件下停下（`openWindowBoundReached`），事件留在缓冲，不静默丢弃。

## 真实源接缝（advanceLive）

`advance(processMs)` 驱动场景批次；`advanceLive(processMs, batch)` 准入**调用方供给的一批真实事件**（stream-providers 的融合释放即此形态）：同一场景事件词表校验（非法即 `scenario-append-invalid` 具名拒绝）、离线批次支持、背压尾部留在调用方 pending（不撑大运行时）、暂停时返回空白轮。checkpoint 的缓冲/去重两个面自然携带真实事件——续跑后至少一次重投递由去重吸收，无需 checkpoint 面变更。

## Checkpoint / resume

工作台的完整状态（spec、场景游标、intake 缓冲、去重窗、窗口与修订账本、计数器、物化记录）编码为一个有界 plain-JSON checkpoint（默认上限 1 MiB，超界拒绝编码）。resume 重建的运行时与不间断运行逐字段相等；崩溃前后的至少一次重投递表现为重复 id，被去重吸收；已关闭窗口不会被二次关闭。

## 物化（materialize）

- 导出 = 全部已结算窗口（closed/revised/empty）当前 revision 的快照；开放窗口不是结论，永不导出。
- `exportDigest` = sha256（身份字段 + 窗口结论）。相同状态再物化识别为同一产物（返回既有 ref，不重复发布）；状态变化产生新摘要——**已发布的报告不被改写**。
- 物化产物以 GeoJSON FeatureCollection 形式发布进目录（经 accepted-call 配对），`inputRefs` 引用绑定的场景资源版本、继承其授权域；缺口窗口以 null geometry 要素记录（可见的 no-data，不插值）。
- 物化后工作台关闭：`stream_advance` 具名拒绝；实时派生状态与最终固定产物在图层记录中是两个可区分状态（`stream.mode: 'realtime' | 'materialized'`）。

## 工作台状态与图层

工作台状态就是折叠进地图投影的图层记录本身：`stream` 块携带 streamId、场景 ref+revision、模式、窗口/迟到参数、watermark、lag、暂停标志、revision、closed/revised/gap/duplicate/offline 计数、物化钉与**有界 checkpoint**。会话日志重放即可精确重建流状态——除了日志没有任何额外存储。fold 侧要求：当前 meta schema 版本、图层 id = streamId、resourceRef = 场景 ref、checkpoint 必须可解码（否则整条记录只读拒绝）。

工具面（全部为 map mutation，native 直调，携带 `map-change` meta）：

| 工具 | 语义 |
|---|---|
| `stream_open` | 绑定精确场景版本 + 显式窗口/迟到规格，折叠实时图层 |
| `stream_advance` | 按批推进（≤256 步/调用），折叠更新后的窗口投影与 checkpoint，返回一份加总汇总 |
| `stream_pause` / `stream_resume` | 冻结/释放源；拒绝路径具名（`STREAM_STATE_CONFLICT`） |
| `stream_materialize` | 固定版本：发布摘要钉定产物、引用场景版本、翻转最终状态；重复物化幂等 |

## 验证

- 契约/运行时/checkpoint：`map/spatial-realtime/tests/*.spec.mjs`（重复/乱序/迟到/断线 fixture、有界内存、慢消费者、限速、开放窗口上界、缺口物化、确定性重放、checkpoint 续跑逐字段相等、篡改摘要拒绝、超界拒绝、导出钉定不被改写）。
- 工具链路：`map/tools/tests/stream-tools.spec.mjs`（真实 catalog+投影端到端：绑定版本、推进折叠、暂停/继续、物化发布与配对、崩溃恢复幂等、取消/未知/嵌套零折叠零发布）。
- 显示身份：`map/map-container/tests/stream-display.spec.mjs`（fold 门、checkpoint 解码门、渲染 token 随 revision/暂停翻转、卸载清理、realtime/materialized 显示状态区分）。
