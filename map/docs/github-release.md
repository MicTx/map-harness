# GitHub 发布与公开仓规范（Gitea 真源 / GitHub 仅发布）

本仓两条 Git 链路有固定分工，发布与公开仓门面必须遵守本规范。规则来源：2026-10-15 所有者指示（贡献者隐私 + 门面规范化）。

## 链路分工

- **Gitea 开发真源**（私有地址不入公开仓）：全量历史、全部分支、任务包（`.spec/`）、发布器本体。
- **GitHub `MicTx/map-harness`**（公开）：**仅承载发布状态**。main 上每个版本一个压缩提交（孤儿历史，无开发提交），附同名版本 release 对象。开发历史、任务包、内部迭代永不进入本仓。

## 发布操作

```sh
# 开发完成并推送 Gitea 后（先产出最新构建）：
pnpm run build:lib && node map/bin/build-web.mjs
node map/bin/publish-release.mjs --version vX.Y.Z
```

发布器自动完成：读取 LLM 安装引导组成 release 说明 → 干净树与 Gitea 同步预检 → 隐私排除暂存（见下）→ 打包预编译运行包 → 孤儿单提交（引用 Gitea SHA 溯源）→ force 推送 GitHub main → 创建同名 release 对象并上传运行包，并审计输出被替换的远端前值 → 在 Gitea 打同名 tag、创建或更新同名 release 并上传同一运行包（凭据取自 git credential helper，不打印）。

## 预编译运行包（双仓 release 附件）

`map/bin/pack-runtime.mjs` 产出 `map-harness-<version>-runtime.zip`（Windows）与 `.tar.gz`（macOS/Linux），两平台同一份内容：隐私过滤后的跟踪文件 + 各包 `lib/`、`apps/web/dist`、`native/system/packages/entry/lib`，不含 `node_modules` 与任何平台二进制。用户解压后跑 `install.cmd` / `./install.sh`（`map/bin/setup.mjs`：校验 Node 22.19+/24+，按序探测 npmmirror → 腾讯云 → npmjs 镜像，或 `--registry <url>` / `MAPHARNESS_REGISTRY` 指定；无全局 pnpm 时经 `npx` 取锁定版本；跳过 Electron 与 Playwright 浏览器下载；Windows 下缩短 pnpm 虚拟仓目录名以避开 260 字符路径上限），再跑 `start.cmd` / `./start.sh`。用户机器上不编译任何项目代码。保留完整 workspace 是为了让 `--frozen-lockfile` 与锁文件一致。

## Release 说明必含 LLM 安装引导

每个 release 对象的说明正文必须包含「Install guide for LLM agents」一节：写给代为安装的 AI 编码 agent，按序给出前置检查、取源（锁定本版本 tag）、下载运行包、经镜像安装依赖、配置模型密钥（只向用户索取，不得编造、记录或提交）、启动地图模式 Web 服务（`start.cmd` / `./start.sh`），并附源码构建的开发者路径，每步附可机器判定的成功条件。真源是 `map/docs/release-install-guide.md`（英文，`{{version}}` 占位由发布器替换）；发布器读取它组成说明，文件缺失、丢失标题或残留未知占位时拒绝发布。安装、构建或启动方式变化时，在同一提交更新该文件。规则来源：2026-10-21 所有者指示。

## 隐私排除（发布树永不包含）

`.spec/`、`.agents/`、`.claude/`、`.codex/`、`.pi/`、`.zcode/`、`.cursor/`、`.paseo/`、`.env*`、`logs/`、`user/`——任务包、agent 状态、凭据、日志与会话存储不入公开仓与运行包。`.env*` 按任意目录层级的文件名匹配（`isPrivate`，`map/bin/pack-runtime.mjs`），仅放行无值模板 `*.example`；发布器与运行包共用这一份规则。

## 违规记录

- 2026-10-15：v0.1.0/v0.1.1 首发时将开发真源地址写入 About homepage、双语 README、release 说明与发布提交信息，公开暴露私有源头。处置：`resolved_current`——发布器与文档已去除全部真源地址，README/About/说明重写后重新发布；规则升级为「公开仓任何位置（含提交信息与 release 说明）不得出现开发真源地址」，发布器生成的内容由本条规则约束。

## 提交身份

统一 **`MicTx <39692970+MicTx@users.noreply.github.com>`**（关联公开仓的 MicTx 账号）。实名邮箱（QQ）与自有域邮箱不进入公开仓历史；仓库级 `user.email` 已固定为该 noreply 地址。

## 公开仓门面规范（About 与 README）

每次发布后检查 GitHub 仓门面，以下各项缺一不可：

- **About 描述**：一句话说清项目是什么；**不出现内部行话**（真源/本仓/任务包编号/内部任务单等）；附主页链接（指向 Gitea 开发真源）。
- **Topics**：至少 `gis`、`maps`、`agent`、`deepseek`、`spatial-analysis`。
- **README**：双语；开头三段固定顺序——项目一句话定位 → 开发真源与发布下载链接 → 能力概览（六条以内）；随后 Quick start、架构、贡献、**License 节必填**（AGPL-3.0，上游 MIT 单独披露）。
- **README 禁项**：不出现实名邮箱、内部任务单、未发布版本的内部编号、以及任何 privacy-exclude 路径的截屏或路径文本。

## 已知平台限制

- GitHub `refs/pull/*` 只读：仓库重建后旧 PR 引用随之消失；不重建仓时旧 PR 页面仍可达（元数据留存，提交内容随 force 更新不可达）。
- 贡献者图基于默认分支可达提交，发布态提交只剩 MicTx noreply 身份；服务端旧对象在 GC 后彻底消失。
