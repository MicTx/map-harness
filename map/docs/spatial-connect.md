# 外部数据连接器：连接能力（PostGIS/对象存储/COG）

English page: see the slot row in [../README.md](../README.md)；本页是外部数据连接器的设计契约（spec 包 `2026-10-07_add-external-data-connectors`；2026-10-07 决策：全量接入收缩为「连接能力」）。

## 1. 边界：只做连接，不做驻留

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
- **key-activated 复验 lane**（`tests/live.spec.mjs`）：部署方填 `SPATIAL_CONNECT_POSTGRES_*`/`SPATIAL_CONNECT_S3_*`/`SPATIAL_CONNECT_COG_*` 后同一命令对真实端点复验；未设变量自跳过（exit 0）。

宿主行不携带默认 config：空声明组合出空注册表与零凭据要求；连接配置是部署输入，不是产品默认。
