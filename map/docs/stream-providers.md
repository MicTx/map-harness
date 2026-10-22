# 真实流供应商：接入与多源融合（stream-providers@1）

English page: see the slot row in [../README.md](../README.md)；本页是真实流供应商接入面的设计契约（spec 包 `2026-10-07_add-realtime-provider-fusion`；2026-10-07 决策：凭据按名经 cc-switch 在执行轮解析，poll 族方案否决；重连退避由停靠在途读取替代）。

## 1. 边界：接入与融合，不部署

本项目不部署任何流服务端。`stream-providers` 交付的是**接入能力**：把部署声明的真实流端点（两族——标准 SSE 端点与 OpenAI 兼容流式 completions 中继）当作被验证的源读入，并把 2..8 个源融合成一条确定性的、喂给 [`StreamRuntime.advanceLive`](spatial-realtime.md) 的事件时间线。

1. **受验证的配置面** —— 部署在 cordis.yml `stream-providers` 行声明 `sources[]`（≤16）与 `fusions[]`（≤16），加载时逐字段校验（id 单命名空间、URL 形状、completions 的 model 界限、fusion 源数 2..8 且不悬空），任何非法声明**响亮失败**并点名 id；无默认配置——空声明组合空注册表，零凭据要求。
2. **凭据引用面** —— 配置里只有 cc-switch 的**名字**（`credentialRef: 'cc-switch:DeepSeek'`）；值在打开源的**执行轮**才从本机 cc-switch 库解析进 reader 内存，绝不进日志、detail、报告或 checkpoint。四类具名拒绝（库不可用/名字无承载/无密钥/同名分歧）全部映射为 `auth-rejected` 结局并点名，不泄漏值。
3. **读轮面** —— 每源一条停靠在途读取（打开后挂起，读轮收割），单轮受事件配额约束：配额满即停读、下轮续读，不撑大内存、不丢字节；关闭是静止的（在途读取 settle 后释放）。

## 2. 两族源与九结局（`stream-providers@1`）

| 源族 | 线格式 | 凭据 |
|---|---|---|
| `sse` | 标准 `text/event-stream`，逐帧 JSON 载荷 | 可选 bearer |
| `completions` | OpenAI 兼容 `chat/completions` 流式中继：token 增量逐行组装成事件，`[DONE]` 干净终结 | 必需 bearer |

结局词表（闭表九成员）：`streaming` / `unreachable` / `auth-rejected` / `http-error` / `content-type-violated` / `stream-violated` / `timeout` / `aborted` / `source-closed`。协议块与叙述行分离计数（completions 的非 JSON 叙述行是**计数的拒绝**，不是流违规）；坏 JSON 协议块、坏 UTF-8、content-type 前缀不符是具名违规；中途 socket 死亡判 `unreachable`（通道「无法建立或不再存在」）。detail 有界且不携带凭据值。

## 3. 融合引擎

- **水位**：融合水位 = 所有**结论性**源的 `maxReceivedEventTimeMs` 之最小值——滞后源压住结论；干净终结源计为 +∞（其积压排空后不再阻塞）；paused/failed 源非结论性，退出水位。
- **命名空间**：事件以 `源id::事件id` 进入运行时首见去重——两源同名事件不冲突，重投递被去重吸收。
- **释放序**：`(eventTimeMs, 声明序, 到达序)` 稳定排序；满 pending 队列时**不读线**（背压留在源端），越预算读取进溢出携带、下轮归队，零丢失。
- **落点**：释放按线上批界（≤256）分块喂 `StreamRuntime.advanceLive`；全失败轮报告 `offline`；pause 冻结源队列、resume 释放、close 静止收口。

## 4. 服务面（host 行）

插件加载校验后提供 `streamProviders` 服务：`listSources`/`listFusions`（只具名，脱敏）、`verifySource`（一轮有界真连验证）、`openFusion` → `fusionAdvance` → `pauseSource`/`resumeSource` → `closeFusion` 调度面。未知 id/状态错序以 `STREAM_PROVIDERS_UNKNOWN_SOURCE/UNKNOWN_FUSION/STATE/CONFIG_INVALID` 点名拒绝。

## 5. 测试通道

- **keyless 契约 lane**（`tests/*.spec.mjs`，真实环回 fixture + sqlite fixture 库）：contract 7（词表界桩）；sse 15（九结局全覆盖）；completions 11（token 组装跨轮、协议/叙述分离）；fusion 12（融合语义脚本化 + 双真实 loopback 源真喂 `StreamRuntime`）；service 6（四类凭据拒绝无值泄漏、调度面生命周期）。
- **key-activated 复验 lane**（`tests/live.spec.mjs`）：部署方设 `STREAM_PROVIDERS_LIVE=deepseek`（可选 `STREAM_PROVIDERS_LIVE_MODEL` 覆盖默认 `deepseek-flash`、`STREAM_PROVIDERS_LIVE_CREDENTIAL` 覆盖凭据名）后同一命令对 api.deepseek.com 真连复验；未设变量自跳过。
