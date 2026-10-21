# GitHub 发布与公开仓规范（Gitea 真源 / GitHub 仅发布）

本仓两条 Git 链路有固定分工，发布与公开仓门面必须遵守本规范。规则来源：2026-10-15 所有者指示（贡献者隐私 + 门面规范化）。

## 链路分工

- **Gitea 开发真源**（私有地址不入公开仓）：全量历史、全部分支、任务包（`.spec/`）、发布器本体。
- **GitHub `MicTx/map-harness`**（公开）：**仅承载发布状态**。main 上每个版本一个压缩提交（孤儿历史，无开发提交），附同名版本 release 对象。开发历史、任务包、内部迭代永不进入本仓。

## 发布操作

```sh
# 开发完成并推送 Gitea 后：
node map/bin/publish-release.mjs --version vX.Y.Z
```

发布器自动完成：干净树与 Gitea 同步预检 → 隐私排除暂存（见下）→ 孤儿单提交（引用 Gitea SHA 溯源）→ force 推送 GitHub main → 创建同名 release 对象，并审计输出被替换的远端前值。

## 隐私排除（发布树永不包含）

`.spec/`、`.agents/`、`.claude/`、`.codex/`、`.pi/`、`.zcode/`、`.cursor/`、`.paseo/`、`.env*`、`logs/`、`user/`——任务包、agent 状态、凭据、日志与会话存储不入公开仓。

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
