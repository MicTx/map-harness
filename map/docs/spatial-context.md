# 空间上下文循环

`@map-harness/spatial-context` 拥有空间上下文循环：DecisionFrame 领域、权威 `decisionFrame` session 投影、有界 pre-step 快照注入、版本化方法卡与任务预算账本。

## 面与组合

| 面 | 入口 | 挂载方 | 注册 |
|---|---|---|---|
| Host | `@map-harness/spatial-context` | map-web patch insert 行 `spatial-context` | `decisionFrame` 投影与 `spatialContext` 服务（解析后的任务预算 + 帧读取） |
| Agent 监听器 | `@map-harness/spatial-context/agent` | map-web host fallback `spatial-context-agent-fallback`；可选 preset 行 `spatial-context-agent` | `agent/pre-step` 监听器 |

host 投影是帧折叠的前提。map-web fallback 为未挂载监听器的 preset（含已安装的用户 preset）提供上下文，从不改写它们的文件。preset 同时挂载监听器时，其内层 waterfall 决定负责准入与自己的预算：外层监听器既不重复快照，也不绕过上下文字节拒绝。请求内的准入标记经 decision spread 保留，但不写入 Session 事件。

## 领域与权限分离

- **GoalContract** — 只由被接受的 real `user/message` 事件推进（`source.kind === 'user'`）。插件 user-role context、模型输出与工具结果永远不能授权目标，无论引用哪个 seq。每个被接受的 real user message 提升 `goalRevision`，并由其 source seq 重新派生 `questionId`。可信 UI 的结构化字段没有上游扩展点，除非新增事件类型；本循环不新增事件类型，该 seam 被记录，不伪造。
- **PlanState** — 只由被接受的 `decision_update` 结果写入，其 `decision-change` meta 引用当前 `goalRevision` 与 `expectedPlanRevision`。模型解释保持暂定；`decision_update` handler 与投影 fold 执行同一组冲突检查（`goal-revision-stale`、`plan-revision-conflict`、`unknown-evidence-ref`），因此旧运行永远不能覆盖新目标。
- **EvidenceLedger** — 只从已结算的空间工具结果折叠：`analysis-result`/`catalog-result`/`map-save-receipt` 记录成为带 `succeeded` 状态的有界条目；失败结果折叠为无适用记录的 `failed-tool` 条目。模型不能以断言把证据标为完成。每条保留记录上报的 headline 值（至多 `MAX_EVIDENCE_METRICS` 条，名称与字符串值截断到 `MAX_EVIDENCE_TEXT_CHARS`）、记录自身的 claim 级别（若有）以及结算时的 goal revision，使后续步骤或重建基线可以引用结果本身。快照把它们渲染为 `name=value unit` 与 `claim=<level>`，并标注在更早目标下结算的证据。账本不记录 map revision，因为记录本身不携带。
- **mapRevision** — 权威地图表达 revision 是 `mapContainer` 投影的 revision 计数器；快照将其渲染为只读事实。样式/视图变化不使数值证据失效；目标、输入或方法变化经 plan 重新打开适用性。
- **更广的分析家族** — 账本折叠每个统一空间工具真实的 `tool/result.meta` 协议：`spatial-stat`、`spatial-decision`、`viz-style`、`accessibility-run`、`spatial-terrain` 与 `spatial-scale` 记录经有界消费者侧 reader 解码，并钉住生产者精确的 schema 版本/kind；条目保留记录自身的 status 与 refs。非终态的可达性 run 保持 `unknown` 并附显式未终态 limitation——绝不算成功；`indeterminate` 的视线或坡度同样折叠为 `unknown`。`terrain_slope` 记录保留平均与最大坡度及缺测格数。地图 mutation 只计预算（地图投影拥有它们）。折叠名册由 parity 测试钉住 `SPATIAL_MCP_TOOL_NAMES`；`analysis-result` reader 的工具名单钉住 map-tools geo 名册，parity 测试为每个列出的工具解码一条生产者构造的记录。

`decisionFrame` 状态代次是 `DECISION_FRAME_STATE_VERSION`（2）。来自其他代次的投影缓存行被丢弃，帧从 Session 日志重新折叠，两个方向都如此。

- **地图事实** — 快照的地图块由当前投影组合：逐层可见性（`显示/隐藏`，超过 8 条截断并显式说明）、视窗（center/zoom/wkid）与研究 AOI（name + bounding ring）渲染为三条不同行——视窗绝不与 AOI 混同，未设置 AOI 会被明说。未结算的空间调用以 pending 计数出现。撤销的图层就是消失：组合读取撤销后的权威状态。当地图容器的 `mapViewport` 注册表持有浏览器落定的相机时，投影视窗之后跟一行 `用户视窗`（center、zoom、visible extent、wkid、2D/3D），一行 `地图环境` 说明 mode 与权威底图及兼容注记标题（组合 fixture 为 `Fixture Basemap + Fixture Labels`；显式注记可以缺失）。增量只在用户移动相机后重复 `用户视窗` 行。

提交协议与地图容器一致：mutation 工具先校验候选再返回；只有成功、配对、首次结算的结果才折叠；版本未知、未配对、重复与过期记录保持先前状态不变，并记录有界只读诊断。未知 `decision-change` 版本是只读拒绝——相关领域写入被阻止，绝不取默认值。

## 注入算法

pre-step 监听器按序执行：

1. 先调用 `next()`。`reject` 决定或空的首步原样返回——空间快照从不自行发起请求。
2. 读取被接受的帧状态（host 投影），并把被认领 batch 的 real user messages 折叠为**暂定目标候选**——被认领消息尚未进入日志，因此持久契约不被触碰；`provisionalFrameOf` 只用于组合。
3. 当模型表面上看不到当前目标的基线时，组合一份**基线**（完整有界帧：goal、plan、地图快照、资源候选、证据、选中的方法卡、工具可用性指导、停止建议、预算）——首次进入、恢复、fork，或压缩/表面替换隐藏了基线之后。否则组合**增量**，列出最新可见快照之后结算的事实，以及每条当前文本与最新可见副本不同的被跟踪行：图层列表、视觉与视觉变化候选、AOI、用户视窗与停止建议。没有变化时什么都不组合。预算行中的耗时计数从不触发增量，预算建议只点名耗尽的计数器而不带实时数值，因此耗尽的预算只投递一次。
4. 按内容 digest 去重：相同的可见快照抑制重复注入。digest 从表面计数，进程缓存与压缩摘要永远不能代替可见性。
5. 仅当上下文字节预算仍能容纳快照与固定形式的预算通知（`composeBudgetNotice`，至多 `STOP_NOTICE_RESERVE_BYTES`）时才准入快照。放不下时改为注入一次通知：它说明后续事实不再到达且投递为 `partial`。截断会切掉权威、单位或限制，所以快照永不缩短。通知正文不依赖目标，因此一份可见通知覆盖后续目标；通知已可见或同样放不下时什么都不注入。
6. 在每个 await 前后重新检查取消信号，并把消息接在被认领 batch 之后。

注入状态只在投影从已接受日志折叠快照 `user/message` 时更新——仅组合永远不确认注入，准入前取消使 goal、plan 与注入状态保持不变。

工具可用性来自当前请求的工具 schema，而不是快照中的第二份名单。方法指导不声称工具已挂载；缺失工具保持显式缺口。owner-local `tests/expected/context-entry.json` 快照对照被准入的 Session 消息与作用域预算检查模型请求指导。

## 方法卡与停止条件

受控集合有十一张卡：`visualization`，其指导调用 `viz_recommend` 做数据驱动选择；两张视觉卡 `visual-candidates` 与 `visual-change-candidates`；`locate`（定位）、`topology`（拓扑与几何量算：缓冲、面积、相交、距离、包含）与 `evidence-check`（证据检查）；以及分析家族 `network`（路网）、`statistics`（统计）、`spatiotemporal`（时空）、`site-selection`（选址预测）、`terrain`（地形）。每张卡携带 triggers、required data、scale、tool families、preconditions、outputs、misjudgments、stop conditions、applicability 与 version（`METHOD_CARD_SET_VERSION`）；快照渲染 required data、preconditions、outputs、stop conditions 与 misjudgments。

选择是确定性且有界的，每份快照至多 `MAX_RENDERED_CARDS`（4）张。CJK triggers 按子串匹配；ASCII triggers 按整词匹配，因此 `contain` 不会在 `container` 内触发。evidence-check 卡需要已结算证据，但因果措辞（`因果`、`导致`、`归因`、`影响因素`）除外——它在任何证据出现前就选中该卡；它排第一，因为它守住结论。当前问题选中的卡排在其后，然后是被接受 plan 在 `methods` 中按 card id 点名的卡：plan 把方法带过「继续」这类追问，因属于模型的候选而排当前问题之后。其余保持可发现，不注入。`locate` 覆盖计数问题：要求研究区、去重与已声明的 POI 来源覆盖，之后才报告数字。卡提醒模型条件，绝不宣称分析已发生；检索到的外部材料不能覆盖卡所声明的执行规则。负向指导是契约的一部分：缓冲永不冒充路网，未知 CRS 拒绝，没有正分母的比率不是比率，相关永不冒充因果，视锥不是 viewshed。

`evaluateStops` 渲染诚实的建议：`blocked` 表示受阻缺口，`not_applicable` 表示缺少必需数据且无证据结算，`partial` 表示开放缺口但有部分证据，`budget` 表示计数器耗尽。`unknown`/`not_applicable`/`partial`/`blocked` 证据永不渲染为成功。每个被接受的 real user message 都提升 goal revision，包括追问；为更早 revision 编写的 plan 继续计入其缺口，plan 行与建议都把它标注为为更早目标编写，并点名新更新必须引用的 `goal_revision`。

`decision_update` 引用在账本中缺失时以 `UNKNOWN_EVIDENCE_REF` 拒绝。账本已满且引用早于最旧条目时，详情报告它已被逐出并点名最旧保留 seq；否则报告该引用从未结算。

## 预算

`BudgetConfig` 是经校验的插件 config（任一面上的 `budget`）：`maxModelSteps`、`maxMetaBytes`、`maxContextBytes`、`maxScanFeatures`、`maxElapsedMs`、`maxGapRetries`。`maxModelSteps` 没有默认值：步骤被计数并渲染为 `steps N/不限`，但除非 composition 设置，从不限制；随附的 map preset 都不设置。账本从已接受事件折叠——模型步骤、序列化空间 meta 字节（含大体积 map-change 副本）、准入快照字节、消费要素——并位于 plan 之外：`planRevision` 更新、重试或恢复永远不能重置它，取消不退还任何预算。`decision_update` 在组合记录前运行 preflight，并以 `BUDGET_EXHAUSTED` 拒绝；同一 gap id 的重复重开超过 `maxGapRetries` 时同样拒绝。Provider 成本只作为估算，不是限制。

## `decision_update` 工具

由 `map-tools` 拥有（与每个模型面 handler 一样），把领域检查委托给本包。输入引用 `goal_revision`、`expected_plan_revision` 与有界更新；拒绝携带稳定码（`GOAL_REVISION_STALE`、`PLAN_REVISION_CONFLICT`、`UNKNOWN_EVIDENCE_REF`、`BUDGET_EXHAUSTED`）。四个 `type:'json'` 参数（`methods`、`steps`、`gaps`、`evidence_refs`）接受已解析值或 JSON 字符串；畸形字符串是点名参数的 `INVALID_ARGUMENT`，解码后的值仍须通过既有 shape 检查。固定的 74 名空间工具集构成完整目录；统一身份表、MCP provider 注册与模型 assemble 全部对照它交叉核对。

## 测试

`pnpm --filter @map-harness/spatial-context run test` 运行七个 spec 文件：领域单元（`frame.spec.mjs`）、预算单元（`budget.spec.mjs`）、底图上下文身份（`basemap-context.spec.mjs`）、真实 Session 投影折叠（`projection.spec.mjs`，含消费者侧记录 reader 与 map-tools 生产者 codec 的 parity）、快照组合单元（`snapshot.spec.mjs`）、方法卡发现与选择（`method-discovery.spec.mjs`），以及断言真实模型请求的 keyless 循环 fixture（`loop.spec.mjs`）——基线准入、去重、轮内增量、压缩重建、reject/empty/cancel 遏制、fork 重放与工具拒绝矩阵。
