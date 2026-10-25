# 外部数据连接与在线空间检索

English overview: see [../README.md](../README.md). `spatialConnect` 验证 PostGIS、对象存储和 COG 连接；独立的 `spatialSearch` 服务按需读取天地图数据，由 `catalog_register.online` 负责不可变登记，不做驻留同步。

## 1. 连接验证边界

本项目只留存业务数据；外部通道**不做驻留同步**。连接器交付三件事：

1. **受验证的配置面** —— 部署在 cordis.yml `spatial-connect` 行声明命名连接（`postgis[]`/`objectStores[]`/`cogs[]`，总计 ≤16），加载时逐字段校验（id 单命名空间、host 形状、endpoint 根形状、bucket 字符集、超时界限），任何非法声明**响亮失败**并点名连接。
2. **凭据引用面** —— 配置里只有环境变量**名**（`passwordEnv`/`accessKeyIdEnv`/`secretAccessKeyEnv`/`sessionTokenEnv`/`tokenEnv`，缺省名见 `src/plugin.ts`）；值在加载时一次性解析进内存，绝不进日志、detail 或摘要。缺失/空值在加载时以 `CONNECT_CREDENTIAL_MISSING` 点名变量失败。
3. **协议级连通/认证验证** —— 对每个命名连接执行一次真实协议交换并给出闭表结局。

## 2. 三条协议通道

| 通道 | 交换 | connected 判据 |
|---|---|---|
| PostGIS | SSL 协商（disable/prefer/require）→ 启动报文 → SCRAM-SHA-256（含 ServerSignature 校验）/MD5/cleartext → `SELECT version()` | 认证通过且版本串有界回读 |
| 对象存储 | ListObjectsV2 `max-keys=0`（SigV4 签名，path/virtual-hosted 寻址，会话令牌入 header 与签名词表） | 200 且 XML `KeyCount=0` 无异常字段 |
| COG | ≤3 次 Range 请求读 TIFF 头与首 IFD（classic/BigTIFF × II/MM） | 幂 ≤ 目录字节上限、tile/stripe 结构可判读 |

交换走真实 socket/fetch 语义：读取受 deadline 包裹（静默服务器必到 `timeout`，永不挂起）、abort 信号贯穿（优先于 deadline）、帧违规（长度越界/类型未知/消息乱序）判 `protocol-violated` 而非猜测续读、`Terminate` 收尾、错误路径统一销毁传输。

## 3. 结局词表（`spatial-connect@1`）

`connected` / `auth-rejected` / `unreachable` / `timeout` / `server-refused` / `not-found` / `protocol-violated` / `unsupported-channel` / `invalid-content` / `aborted`。SQLSTATE（28P01/28000/3D000/53300）与 HTTP 401/403/404/301+`x-amz-bucket-region` 各自映射；对象存储对整个对象返回 200（无视 Range）判 `unsupported-channel`，不降级为通过。错误文本 `<code>: <message>`；detail 过 `sanitizeDetail`（任一凭据泄露整条折叠为 `[redacted]`，200 字符有界）。

## 4. 测试通道

- **keyless 契约 lane**（`tests/*.spec.mjs`，自包含脚本服务器）：postgres 15 例（含独立重算的 SCRAM proof 交叉核对与错 ServerSignature 负例）、objectstore 14 例（含 AWS 公开 SigV4 文档向量 `f0e8bdb8…db41` 独立核对签名器）、cog 13 例、contract/service 19 例——凭据永不落盘，脚本服务器按 marker 应答，poll 有界。
- **key-activated 复验 lane**（`tests/live.spec.mjs`）：部署方填 `SPATIAL_CONNECT_POSTGRES_*`/`SPATIAL_CONNECT_S3_*`/`SPATIAL_CONNECT_COG_*` 后同一命令对真实端点复验；未声明端点时 node:test 显式计为 skipped（exit 0），不是 connected 或部署验收通过。声明端点后的测试验证返回结局属于闭表且不泄露凭据；部署接入通过还需确认实际结局为 connected，不能仅依据进程退出码。

三个连接族的空声明仍组合为空注册表。map-web 仅在启动环境提供 `TIANDITU_API_KEY` 时声明天地图检索配置；否则服务存在但调用明确返回 `SEARCH_NOT_CONFIGURED`，不会返回伪造的空数据。

## 5. 在线空间检索

`spatial-connect` 行的 `config.tianditu` 接受以下部署设置；`null` 或未声明表示不启用。凭据声明指向不存在/空环境变量时加载失败。

| 字段 | 默认值 | 范围或约束 |
|---|---|---|
| `apiKeyEnv` | `TIANDITU_API_KEY` | 环境变量名，不是 key 值 |
| `baseUrl` | 天地图官方 HTTPS origin | 无 path/query/userinfo；HTTP 只允许字面回环地址 |
| `timeoutMs` | 10000 | 50–60000，网络读取截止时间 |
| `maxResponseBytes` | 2097152 | 1024–16777216，包含流式响应 |
| `maxConcurrent` | 4 | 1–16，超限明确拒绝，不堆积队列 |
| `maxCoordinates` | 20000 | 4–100000，计入所有返回要素和补齐的闭合顶点 |

服务将模型 JSON 解析为四种请求：`geocode`（地址候选）、`reverse`（给定点的逆编码）、`search`（POI）、`district`（行政区中心或边界）。`search` 必须声明 bbox 或行政区代码之一，不默认城市；默认 limit=10、offset=0、level=12。供应商返回行用于推进分页，重复 POI 只在同一页去重，跨页重复仍需以内容/要素身份识别。坐标明确标记 CGCS2000 地理坐标 `EPSG:4490`；范围框不被解释为行政边界，单个地理编码候选也不证明地名唯一。

`catalog_register` 的 `online` 与 `path` 互斥，online 不接受调用方覆盖 `crs`。成功后返回资源版本、稳定 feature refs、至多五项候选预览、实际查询参数/读取时间/供应商总数及下一 offset。`source.result_status` 区分 found 与 empty。几何字节直接进入会话独立目录，不向模型展开整个边界；`retry_of` 只读取原 publication，不重发网络请求。之后用既有 `catalog_resolve`、分析工具和 `map_add_layer` 消费该 ref。导航用途的只读解析走 `map_locate`（无 bbox 为地理编码单候选，带 bbox 为限定 POI 检索可多候选/零候选），不登记、不落库，与登记链路互不冒充。

请求路径由服务固定，模型不能提供 URL；跳转被拒绝，响应错误不回显供应商正文或 key。取消、超时、权限、限流、畸形数据、超量和未配置分别有 `SEARCH_*` 错误码。卸载先撤销服务再取消并等待在途请求，不能在关闭后继续发布数据。

## 6. 检索验证与部署限制

`node --test --experimental-strip-types map/tools/tests/online-discovery.spec.mjs` 使用真实回环 HTTP、目录与地图投影，覆盖参数/分页/几何/权限/超量/取消/关闭/不可变登记与重试。`node --test --test-name-pattern='^spatial workflow: online search' map/arcgis-mcp/tests/composition.e2e.mjs` 从真实 dsh map-web profile 与浏览器运行检索、登记、上图和恢复；模型与数据供应商为隔离替身。

真连入口为 `MAP_SPATIAL_SEARCH_LIVE=tianditu node --env-file=.env --test --experimental-strip-types map/tools/tests/online-discovery-live.spec.mjs`。当前部署的 geocode、POI search、reverse 三个面已验证；administrative 端点返回 CloudWAF HTTP 418，属于外部阻塞，不算边界检索通过。该面有独立 `MAP_SPATIAL_DISTRICT_LIVE=1` 复验开关，未启用时明确 skipped；接口恢复后必须通过 Polygon 结果断言，不能用中心点或矩形代替。
