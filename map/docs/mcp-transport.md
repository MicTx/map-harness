# 远程 MCP transport：接入能力（stdio 跨进程 / streamable-HTTP）

English page: see the slot row in [../README.md](../README.md)；本页是远程 MCP transport 客户端面的设计契约（spec 包 `2026-10-07_add-remote-mcp-transport`；2026-10-07 决策：不部署远程主机，keyless lane 在环回 fixture 上证明客户端面）。

## 1. 边界：接入，不部署

本项目不部署任何远程 MCP 服务端。`mcp-transport` 交付的是**接入能力**：把部署声明的远程 MCP 端点（跨进程 stdio 子进程或 streamable-HTTP 端点）当作被验证的连接，证明 initialize 握手、tools/list 发现与 tools/call 派发在真实传输上协议正确。

1. **受验证的配置面** —— 部署在 cordis.yml `mcp-transport` 行声明命名连接（`stdio[]`/`http[]`，总计 ≤16），加载时逐字段校验（id 单命名空间、command/argv 界限、envRef 形状、URL 形状、超时界限），任何非法声明**响亮失败**并点名连接。
2. **凭据引用面** —— 配置里只有环境变量**名**（stdio 的 `envRefs`、http 的 `tokenEnv`）；值在加载时一次性解析进内存，绝不进日志、detail 或摘要。缺失/空值在加载时以 `MCP_TRANSPORT_CREDENTIAL_MISSING` 点名变量失败。stdio 子进程环境 = SDK `getDefaultEnvironment()` + 已解析引用，绝不静默继承全量父环境。
3. **协议级交换面** —— `verifyConnection` 走一次有界交换并给出闭表结局；`openConnection`/`callTool` 提供缓存的与瞬态的两条派发路径。

## 2. 两条传输通道

| 通道 | 交换 | connected 判据 |
|---|---|---|
| stdio | 真实子进程（`StdioClientTransport`）→ initialize → tools/list → tools/call | 握手完成、服务器身份可回读、目录可发现 |
| http | streamable-HTTP（`StreamableHTTPClientTransport`，可选 bearer）→ 同上 | 同上 |

每次交换受 deadline 包裹（静默对端必到 `timeout`，永不挂起）；abort 信号贯穿并作为协议 `notifications/cancelled` 到达对端后本地才 reject（判 `aborted`）；拆除是静止的——在途交换先 settle，客户端关闭，stdio 子进程退出在宽限窗口内确认，超时 SIGKILL 兜底，无孤儿存活。

## 3. 结局词表（`mcp-transport@1`）

`connected` / `unreachable` / `auth-rejected` / `handshake-failed` / `protocol-version-unsupported` / `tool-list-refused` / `server-error` / `protocol-violated` / `timeout` / `aborted` / `transport-closed`。工具以 `isError: true` 内容应答是**成功的协议交换**（一个结果），绝不落入失败词表；JSON-RPC error 应答按阶段映射（initialize → handshake-failed、tools/list → tool-list-refused、tools/call → server-error）。detail 有界（512 字符）且不携带凭据值。

## 4. 测试通道

- **keyless 契约 lane**（`tests/*.spec.mjs`，真实环回 fixture）：stdio 12 例（真实子进程：连接/身份/发现/派发、envRefs 传播、ENOENT、静默 stdout deadline、坏 initialize、旧 protocolVersion、拒 tools/list、子进程中途退出、中止、isError 结果、关闭后子进程退出确认）；http 6 例（真实 `node:http` 监听：连接/发现/派发、401 双向、拒连端口、坏 initialize、静默 TCP deadline、中止）；contract/service 13 例。
- **key-activated 复验 lane**（`tests/live.spec.mjs`）：部署方填 `MCP_TRANSPORT_LIVE_URL`（可选 `MCP_TRANSPORT_LIVE_TOKEN`）后同一命令对真实端点复验；未设变量自跳过。
