# 空间可达性层（spatial-accessibility）

P1 可达性层把「步行 15 分钟能到什么」从几何邻近里分出来：版本化方法输入、网络源（受控路网 provider 为缺省与测试基座；高德、天地图、Mapbox、百度、腾讯五家 adapter 经 Config 选择、用户填 key 启用）、持久 run 作业、人口加权覆盖与给定候选比较。模型只经 `run_submit`/`run_get`/`run_cancel` 三个普通 MCP 工具消费它；设计依据见[空间决策架构](../../.spec/docs/2026-09-23_docs-spatial-agent-architecture_design.md) §6.4（长任务）与 §12（科学约束）。

## 方法契约（`contract.ts`）

`AccessibilitySpec` 固定一次可达性运行的全部输入：`goalRevision`、study/retrieval/support 三层外延（必须嵌套 study ⊆ retrieval ⊆ support）、observation/training 半开时间窗（training 必须在 observation 之前结束）、出行方式与阻抗（`maxMinutes`，上限 240）、固定时间片词表、障碍、入口、容量规则、人口/设施资源 ref（`res-…@vN`）与方法版本。`validateAccessibilitySpec` 在边界返回全部结构化问题（不抛出第一个就停）；`specDigestOf` 是键序无关的规范摘要——同一 operationRef 不同摘要即冲突。`straightLineExploration` 构造永久标记的直线探索记录（`exploratory: true` + 强制限制文案），`usableAsNetworkEvidence` 拒绝把它当网络证据消费。

边界语义是协议常量（`BOUNDARY_RULE`）：study 外、support 内的设施保留（可服务研究区人口）；support 外的设施排除并带诊断。

## 受控路网 provider（`network.ts`）

`CONTROLLED_NETWORK_ID` 是本部署缺省的网络源与测试基座；未知 provider id 在插件加载时即失败。provider 在 support 外延上构建确定性格网路网（节点密度有上限，digest 进入 `networkRef`），按方式速度 × 时间片因子定价边，支持 blocked/delay 障碍；`serviceArea`/`route`/`readPois` 都带 AbortSignal 检查点——取消落在扩展/分页循环内部，不是 Promise 超时。确定性故障规则注入 `RATE_LIMITED`（带 retryAfter）/`PERMISSION_DENIED`/`TEMPORARILY_UNAVAILABLE`；`collectPois` 把分页中断报告为 `partial` 覆盖（带已取条数），绝不重塑成完整读取。方式未被定价 → `METHOD_NOT_APPLICABLE`：缺路网时步行目标失败发声，绝不退化为缓冲。

## 高德 Amap adapter（`amap.ts`）

`AMAP_NETWORK_ID`（`amap-road-network`）是第二个、经 Config 显式选择的网络源（首期一厂一 adapter 显式接线，不做多厂商注册表；百度/腾讯为后续包的边界扩展）。adapter 把高德 Web 服务映射到 `NetworkProvider` 契约：`route` 一次 v3 driving/walking 调用（minutes=duration 秒/60、km=distance 米/1000、路径节点=量化返回折线）；`serviceArea` 无厂商等价服务——以确定采样格网对每个样本真实路由，预算内样本构成服务区（分辨率受格网间距约束，每面积调用数受节点上限约束）；`readPois` 走 v3 place/polygon 厂商分页（page 1 起、offset ≤ 25，契约内 0 基分页内部转换）；取消把调用方 AbortSignal 带进传输并在调用间检查（含请求超时合并）。

厂商错误码映射到既有 `AccessibilityError` 词表，不新增协议词汇：无效 key（10001）与权限/白名单/签名族（10002/10005-10009/10012/10013/10041/20011/40002）→`PERMISSION_DENIED`；配额与 QPS 族（10003/10004/10010/10014/10015/10019-10021/10029/10044/10045/40000/40003）→`RATE_LIMITED`；跨界无服务（20800）与无路/连不通（20801/20802）→`ACCESS_NOT_FOUND`；参数非法（20000/20001/20002/20803）→`ACCESS_INVALID_INPUT`；忙/资源不可用/未知/引擎 3\*\*\*/HTTP 非 2xx/非 JSON →`TEMPORARILY_UNAVAILABLE`。采样中样本级 `ACCESS_NOT_FOUND` 是网络事实（样本不进服务区），配额/权限/不可用族立即响亮抛出——部分采样绝不重塑成完整服务区；全 extent 无一路可达时整体 `ACCESS_NOT_FOUND`。

能力/限制声明成文于代码并由测试钉住（`AMAP_CAPABILITY_DECLARATION` + `AMAP_PROVIDER_LIMITATIONS`）。可映射面：route walk/drive、serviceArea 采样、readPois、取消。显式收缩面（全部响亮、绝不静默降级）：bike（v4 骑行响应面不同，`METHOD_NOT_APPLICABLE`）、barriers（厂商无输入，`ACCESS_INVALID_INPUT`）、时间片定价（厂商只回实时估计，slice 接受但不改价）、网络版本（厂商无路网数据版本身份，`networkRef` 只摘要采样形状、绝不含 key）、坐标基准（WGS84↔GCJ-02 社区文档化近似，残余米级误差列入限制文案）、POI 目录范围（无 keywords/types 时厂商默认类目，非全量 POI 宇宙）、分页窗口（同参数最多 200 行；越界读抛 `RATE_LIMITED` 使收集报 `partial`，绝不把 200/更大目录的读取标成 complete）。

## 天地图 adapter（`tianditu.ts`）

`TIANDITU_NETWORK_ID`（`tianditu-road-network`）是第三个、经 Config 显式选择的网络源（一厂一 adapter 显式接线，不做多厂商注册表；百度/腾讯仍不做）。adapter 把天地图驾车规划映射到 `route`：一次 `http://api.tianditu.gov.cn/drive?postStr={json}&type=search&tk={key}` 调用，`walk` 映射 `style` 3、`drive` 映射 `style` 0（最快）；minutes=`<duration>` 秒/60，**公里直接取 `<distance>`**（厂商单位已是公里，与高德的米不同）；路径节点=量化 `routelatlon` 折线。XML 用固定 schema 窄解析（`<result>` 根、`<distance>`、`<duration>`、`<routelatlon>`），不引入 XML 运行时依赖；嵌套标记与缺字段归 `TEMPORARILY_UNAVAILABLE`，错误文本写明是响应形态意外。

厂商未发布驾车规划错误码表，分类按实测响应形态归入既有词表（映射面钉在 keyless fixture 测试）：密钥/权限文本 →`PERMISSION_DENIED`；配额/超限文本 →`RATE_LIMITED`；无法规划/无结果文本 →`ACCESS_NOT_FOUND`；参数/经纬度文本 →`ACCESS_INVALID_INPUT`；其余形态与 HTTP 非 2xx →`TEMPORARILY_UNAVAILABLE`。

能力/限制声明成文于代码并由测试钉住（`TIANDITU_CAPABILITY_DECLARATION` + `TIANDITU_PROVIDER_LIMITATIONS`）。可映射面：route walk/drive、取消。显式收缩面（全部响亮）：serviceArea（官方无等时面 API，`METHOD_NOT_APPLICABLE`，**不用路由采样近似冒充**）、readPois（驾车规划不返回 POI 目录）、bike（文档 style 只有驾车三档与步行）、barriers、时间片定价、网络版本（`networkRef` 只摘要 bbox、绝不含 key）、途经点（`mid` 从不发送）。

## Mapbox adapter（`mapbox.ts`）

`MAPBOX_NETWORK_ID`（`mapbox-road-network`）是第四个、经 Config 显式选择的网络源。`route` 走 Directions v5 `https://api.mapbox.com/directions/v5/{profile}/{coordinates}`：`walk`→`mapbox/walking`、`bike`→`mapbox/cycling`、`drive`→`mapbox/driving`，一次恰 2 个坐标点（厂商上限 25），minutes=`duration` 秒/60、km=`distance` 米/1000、路径节点=量化 GeoJSON LineString（`geometries=geojson`）。`serviceArea` 走 Isochrone v1 `https://api.mapbox.com/isochrone/v1/{profile}/{coordinates}`：`polygons=true` 加一条 `contours_minutes` 等值线（厂商范围 1–60、每次 1 坐标、最多 4 条；adapter 只发 1 条），返回多边形外环为服务区，环上节点的 minutes 取等值线值。GET URL 超过厂商上限 8192 字节在请求发出前以 `ACCESS_INVALID_INPUT` 拒绝。

错误映射：HTTP 401/403 →`PERMISSION_DENIED`，429 →`RATE_LIMITED`，404 →`ACCESS_NOT_FOUND`，422 →`ACCESS_INVALID_INPUT`；HTTP 200 且 body `code` 为 `NoRoute`/`NoSegment` →`ACCESS_NOT_FOUND`，`InvalidInput` →`ACCESS_INVALID_INPUT`；HTTP 200 携带 "No route found" 消息且无 routes/features →`ACCESS_NOT_FOUND`；非 JSON 与其余形态 →`TEMPORARILY_UNAVAILABLE`（错误文本写明是响应形态意外）。

能力/限制声明成文于代码并由测试钉住（`MAPBOX_CAPABILITY_DECLARATION` + `MAPBOX_PROVIDER_LIMITATIONS`）。可映射面：route walk/bike/drive、serviceArea、取消。显式收缩面：readPois、barriers、时间片定价（`driving-traffic` 是实时 profile，不是时间片因子，本 adapter 不使用）、等值线上限、坐标点数与 URL 上限、网络版本。服务条款要求结果经 Mapbox 地图展示——内部分析用途是部署法务注意项，写入限制声明，代码不强制。

## 百度 adapter（`baidu.ts`）

`BAIDU_NETWORK_ID`（`baidu-road-network`）经 Config 选择，凭据默认来自 `BAIDU_API_KEY`。`route` 调用 Direction Lite `directionlite/v1/driving` 或 `directionlite/v1/walking`，输入按百度 `lat,lng` 发送，返回的 `duration` 秒、`distance` 米和 steps path 折叠为 provider 结果；`readPois` 调用 Place v2 `place/v2/search`，使用 bounds、0 基 `page_num` 与有界 `page_size`。百度没有契约等价的等时面，`serviceArea` 使用受节点上限约束的真实路由采样。bike、barriers、超出分页窗口与坏响应分别响亮拒绝或映射到既有错误词表，key 只进 `ak` 查询参数。

## 腾讯 adapter（`tencent.ts`）

`TENCENT_NETWORK_ID`（`tencent-road-network`）经 Config 选择，凭据默认来自 `TENCENT_MAP_KEY`。`route` 调用 `ws/direction/v1/driving/` 或 `ws/direction/v1/walking/`，输入按 `from`/`to` 的 `lat,lng` 发送，返回的 `duration` 秒、`distance` 米和压缩 polyline 解码为 provider 结果；`readPois` 调用 `ws/place/v1/search`，使用 rectangle boundary、1 基厂商 `page_index`（内部仍为 0 基）与有界 `page_size`。服务区、bike、barriers、分页窗口和凭据错误的语义与百度一致，key 只进 `key` 查询参数。

## 五家坐标系差异

内部契约是 WGS84。三家差异是显式事实，分别被测试钉住：

| 厂商 | 厂商坐标系 | adapter 行为 | 测试钉住的事实 |
|---|---|---|---|
| 高德 | GCJ-02 | 输入 WGS84→GCJ-02、输出反向，社区文档化近似，残余米级误差列入限制 | 线上 origin 相对输入偏移 > 0.0005° |
| 天地图 | CGCS2000 | 免转换：分析粒度下与 WGS84 差异可忽略，坐标原样通过 | 线上 origin 与输入逐字相等 |
| Mapbox | WGS84 | 免转换：与内部契约一致 | 线上坐标与输入逐字相等 |
| 百度 | BD-09 | 按百度协议发送，不臆造未经核验的转换 | fixture 断言 `lat,lng` 请求形状 |
| 腾讯 | WGS84 地理坐标 | 免转换：route/POI 坐标原样通过 | fixture 断言 `from`/`to` 与 polyline 解码 |

## 凭据与配置面（`plugin.ts`）

Config 的 `provider` 缺省 `controlled-lattice`（无 schemastery 默认——既有部署的组合 dump 不变），已配置源恰六项：`controlled-lattice`、`amap-road-network`、`tianditu-road-network`、`mapbox-road-network`、`baidu-road-network`、`tencent-road-network`。五个厂商块都是 credential-ref 角色、只携带 env 名：`amap.apiKeyEnv` 缺省 `AMAP_API_KEY`、`tianditu.apiKeyEnv` 缺省 `TIANDITU_API_KEY`、`mapbox.accessTokenEnv` 缺省 `MAPBOX_ACCESS_TOKEN`、`baidu.apiKeyEnv` 缺省 `BAIDU_API_KEY`、`tencent.apiKeyEnv` 缺省 `TENCENT_MAP_KEY`；`timeoutMs` 单请求超时 1000–60000ms，百度/腾讯 `spacingDeg` 为采样间距（有界）。五块另有可选 `baseUrl`（TLS 或内网镜像根）：须为非空 `http://` 或 `https://` 前缀、无尾斜杠、无路径/查询串/片段、无 userinfo；缺省不写入配置，请求仍走厂商根常量，组合 dump 不变。选择由 `resolveNetworkSource` 在加载期定案：未知 id 即错并列出六个已配置源；选任一厂商而 env 未设或为空即响亮失败——指名 env 名、声明拒绝静默回退受控 provider；非法 `baseUrl` 在加载期拒绝，失败文本不回显 URL 里的凭据片段。凭据值只经 env 引用进入、只在内存闭包持有：不进配置默认值与序列化、不进日志与错误文本（失败文本只携带 env 名与厂商错误码/形态）、不进 `networkRef`/证据、不经 `baseUrl` 携带。接入方式：用户 overlay 加任一厂商 `provider`，部署环境在根 `.env` 设对应变量（不入提交）；需要 TLS 或镜像根时在同一厂商块加 `baseUrl: https://mirror.example`。

## 真实厂商契约门禁（key-activated lane）

`spatial-accessibility/tests/vendor-contract.spec.mjs` 固化台账重试条款的四类断言——跨界、分页缺失、取消、无效 key——外加真实定价面。断言集本体在 `provider-contract.shared.mjs`，供应商无关：同一断言集对受控 provider 恒绿（受控双跑等价）；无对应凭据时该厂商侧自跳过、套件 exit 0。天地图与 Mapbox 没有 POI 目录，分页类断言在真实 lane 上是声明式收缩（`readPois` 响亮 `METHOD_NOT_APPLICABLE`，绝不伪造一页）；天地图没有等时面，定价类断言只覆盖 route。五家 adapter 的 fixture suite 以各厂商 wire 格式覆盖 keyless 契约与映射/收缩面。用户填 key 后按需设置对应 env 复验真实 API：

```sh
TIANDITU_API_KEY=<用户key> node --test --experimental-strip-types map/spatial-accessibility/tests/vendor-contract.spec.mjs
MAPBOX_ACCESS_TOKEN=<用户token> node --test --experimental-strip-types map/spatial-accessibility/tests/vendor-contract.spec.mjs
AMAP_API_KEY=<用户key> node --test --experimental-strip-types map/spatial-accessibility/tests/vendor-contract.spec.mjs
BAIDU_API_KEY=<用户key> node --test --experimental-strip-types map/spatial-accessibility/tests/vendor-contract.spec.mjs
TENCENT_MAP_KEY=<用户key> node --test --experimental-strip-types map/spatial-accessibility/tests/vendor-contract.spec.mjs
```

## 持久 run 作业（`runs.ts`）

`run_submit` 先在一个事务里持久化 run 行（稳定 `runId` + 由会话调用派生的 `operationRef` + `requestDigest` + 规范化 spec），然后才启动 worker；`run_get` 纯读不重执行；`run_cancel` 只请求取消。终态由服务裁决：worker 在检查点停下 → `cancelled`；虽然收到请求但完成了全部工作 → 真实终态 + `CANCEL_REQUESTED` 诊断（succeeded + cancelRequested 合法）。worker 至少一次执行、显式检查点；进程重启时上一 epoch 的非终态 run 一律裁决为 `outcomeUnknown`（绝不编造失败/成功）。dispose 先等待全部 worker 真实静止，再关存储。

## 覆盖与比较（`metrics.ts` / `compare.ts`）

覆盖计算：设施经入口（facility 属性或 spec 显式入口）吸附路网，无入口即排除并命名；逐时间片按阻抗算服务区；人口单元最近优先分配给有余量的设施——每单元恰好计入一次，covered + uncovered ≡ 分母（守恒是结构性的）；容量是硬上限，放不下的单元保持未覆盖；provider 故障 → 结果 `partial`，零可用设施或零有效分母 → `empty`。evidence 声明分母口径、窗口、重复计数规则、consumedFeatureCount、输入版本、诊断与限制。`run_get`/`run_submit`/`run_cancel` 把计算级 `evidence.diagnostics` 与 run 级诊断合并进模型可见 `diagnostics`（既有词汇，`code` 后接 `facilityId=` 或 `unitId=`，合计上限 16 条），无入口排除因此具名可见。

候选比较只在用户给定的 ≤8 个方案内进行：基线与每个候选用同一 inputRefs 重算；超预算/重复设施 id/非正容量命名为 infeasible（列出原因，不计算）；分数 = 显式权重点积（coverage + equity − cost）；敏感性做 coverage↔equity 权重互换重排，排名翻转即公开 `rankingStable: false`。`projectComparison` 拒绝旧 goalRevision（`goal-revision-stale`）——晚到的旧 run 永不覆盖新目标。导出固定 revision：同输入 re-export 字节全等，mapLayers 按排名序，report 声明「非全局最优」与权重敏感性限制。

## 接入

- host：map-web patch insert 行 `spatial-accessibility`（store 根 `dshHomePath('accessibility-store')`，网络源缺省受控 provider），注册 `spatialAccessibility` 投影（run_submit 配对）与 run 服务；工具经 `ctx.get('spatialAccessibility')` 消费。部署切厂商：用户 overlay 加任一 vendor provider（凭据见上文「凭据与配置面」）。
- 工具：`map/tools` 的 `run-tools.ts` 提交前解析人口/设施目录版本字节（worker 不重读可变路径），成功结果携带 `accessibility-run` 持久 meta；`retry_of` 只取回已提交 run，缺记录返回 `OPERATION_NOT_PUBLISHED`。要素 id 解析顺序为顶层 `feature.id`、字符串 `properties.id`、再跨全部已解析资源唯一的位置回退（`facility-N` / `unit-N`）；显式 id 重复（跨资源或同一资源内）以 `INVALID_ARGUMENT` 点名冲突 id 与资源，不静默改名。模型面 `type:'json'` 参数（`facility_refs`、`time_slices`、三层外延、`entrances`、`capacities`、`barriers`、`candidates`、`weights`）双形态可调：已解析值原样通过，JSON 字符串先解码再走既有形状校验；畸形字符串以 `INVALID_ARGUMENT` 点名参数，不回显过长内容。`entrances`/`capacities` 的 facility id 绑定上述解析结果；无入口设施在 `run_get` 诊断中以 `entrance-missing` 与 `facilityId` 具名。
- 门禁归属见 [verification-matrix](verification-matrix.md) 的 `spatial-accessibility/` owner 行。
